// src/strategy/meanReversion.ts
import {
  DriftClient,
  PositionDirection,
  BN,
  convertToNumber,
  BASE_PRECISION,
  MarketType,
  User,
} from "@drift-labs/sdk";
import {
  getOraclePriceData,
  getOpenPositions,
  getAccountState,
} from "../drift/data";
import { placeMarketOrder, closePosition } from "../drift/orders";

// --- Strategy Configuration ---
// Note: These parameters influence trade frequency and sensitivity.
// Longer PRICE_QUEUE_LENGTH smooths the moving average, requiring larger deviations.
// Higher Z_SCORE_ENTRY_THRESHOLD requires stronger signals to enter trades.
// These should ideally be configurable and tuned based on market conditions.
const PRICE_QUEUE_LENGTH = 90; // Lookback period for SMA (User updated)
const Z_SCORE_ENTRY_THRESHOLD = 2.2; // Enter if Z-score exceeds this (positive or negative)
const Z_SCORE_EXIT_THRESHOLD = 0.5; // Exit (TP) if Z-score comes back within this range of 0
const PORTFOLIO_RISK_PER_TRADE = 0.02; // Trade size as % of total collateral (e.g., 2%)
const MAX_PORTFOLIO_ALLOCATION = 0.4; // Max % of total collateral to be in positions (e.g., 40%)
const MINIMUM_PROFIT_PERCENTAGE = 0.005; // Minimum profit target as 0.5% of initial position value (for Z-Score exit)
const MAX_LOSS_PERCENTAGE = 0.05; // Maximum loss (5%) based on initial position value before stop-loss
const TAKE_PROFIT_PERCENTAGE = 0.1; // Take profit if unrealized PnL reaches 10% of initial value

// --- State Variables ---
let priceQueue: number[] = [];
let takerFeePercentState: number | null = null; // Store fetched fee percentage
let currentEntryPrice: number | null = null; // Store estimated entry price

// --- Helper Functions ---

/**
 * Calculates the Simple Moving Average (SMA) of a list of numbers.
 * @param data The array of numbers.
 * @returns The SMA, or null if data is insufficient.
 */
function calculateSMA(data: number[]): number | null {
  if (data.length < PRICE_QUEUE_LENGTH) {
    return null; // Not enough data yet
  }
  const sum = data
    .slice(-PRICE_QUEUE_LENGTH)
    .reduce((acc, val) => acc + val, 0);
  return sum / PRICE_QUEUE_LENGTH;
}

/**
 * Calculates the Standard Deviation of a list of numbers.
 * @param data The array of numbers.
 * @param mean The pre-calculated mean (SMA) of the data.
 * @returns The standard deviation, or null if data is insufficient.
 */
function calculateStdDev(data: number[], mean: number | null): number | null {
  if (mean === null || data.length < PRICE_QUEUE_LENGTH) {
    return null; // Need mean and enough data
  }
  const dataSlice = data.slice(-PRICE_QUEUE_LENGTH);
  const variance =
    dataSlice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
    PRICE_QUEUE_LENGTH;
  return Math.sqrt(variance);
}

// --- Main Strategy Logic Function ---
/**
 * Executes one cycle of the mean reversion strategy logic.
 * Fetches data, calculates indicators, checks conditions, and places orders.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @param marketIndex The perp market index to trade.
 */
export async function runMeanReversionLogic(
  driftClient: DriftClient,
  marketIndex: number
) {
  console.log(` -> Running Mean Reversion Logic for Market ${marketIndex}`);

  // 1. Fetch Account State (for collateral)
  const accountState = getAccountState(driftClient);
  if (!accountState || accountState.totalCollateral <= 0) {
    console.error(
      "  -> ❌ Could not get account state or total collateral is zero. Skipping check."
    );
    return;
  }
  const totalCollateral = accountState.totalCollateral;
  console.log(`  -> Total Collateral: $${totalCollateral.toFixed(2)}`);

  // 2. Fetch latest price
  const oraclePriceData = getOraclePriceData(driftClient, marketIndex);
  if (!oraclePriceData) {
    console.error("  -> ❌ Could not get oracle price data. Skipping check.");
    return;
  }
  const currentPrice = oraclePriceData.price;
  console.log(`  -> Current Price: $${currentPrice.toFixed(4)}`);

  // 3. Update price queue
  priceQueue.push(currentPrice);
  if (priceQueue.length > PRICE_QUEUE_LENGTH) {
    priceQueue.shift(); // Keep queue at fixed size
  }
  console.log(
    `  -> Price Queue Size: ${priceQueue.length}/${PRICE_QUEUE_LENGTH}`
  );

  // 4. Calculate indicators
  const sma = calculateSMA(priceQueue);
  const stdDev = calculateStdDev(priceQueue, sma);

  if (sma === null || stdDev === null) {
    console.log("  -> Not enough data for SMA/StdDev calculation yet.");
    return;
  }
  console.log(`  -> SMA: ${sma.toFixed(4)}, StdDev: ${stdDev.toFixed(4)}`);

  // Calculate Z-Score (handle division by zero)
  let zScore: number | null = null;
  if (stdDev > 0) {
    zScore = (currentPrice - sma) / stdDev;
    console.log(`  -> Z-Score: ${zScore.toFixed(4)}`);
  } else {
    console.log("  -> Standard Deviation is zero, cannot calculate Z-Score.");
    return; // Cannot proceed without valid Z-Score
  }

  // Fetch market fees ONCE
  if (takerFeePercentState === null) {
    console.log("  -> Fetching market fees...");
    try {
      // Call getMarketFees without the user argument to avoid potential UserStats issues
      // This will likely return base fees, not tier-specific ones.
      const marketFees = await driftClient.getMarketFees(
        MarketType.PERP,
        marketIndex
        // user // REMOVED: Avoid passing user for now
      );
      takerFeePercentState = marketFees.takerFee * 100;
      console.log(
        `  -> Fetched Base Taker Fee: ${takerFeePercentState.toFixed(
          4
        )}% (May not reflect user tier)`
      );
    } catch (error) {
      console.error("  -> ❌ Error fetching market fees:", error);
      console.warn(
        "  -> Cannot proceed without fee info. Skipping this cycle."
      );
      return; // Exit if fees can't be fetched initially
    }
  } else {
    // Use the stored fee percentage
    console.log(
      `  -> Using stored Taker Fee: ${takerFeePercentState.toFixed(4)}%`
    );
  }

  // 5. Fetch current position
  const openPositions = getOpenPositions(driftClient);
  const currentPosition = openPositions?.find(
    (p) => p.marketIndex === marketIndex
  );
  const positionSizeBase = currentPosition?.baseAssetAmount ?? 0;
  console.log(`  -> Current Position Size (Base): ${positionSizeBase}`);

  // 6. Calculate trade sizes and limits
  const currentCapitalUsage = Math.abs(positionSizeBase) * currentPrice; // Approx value in quote
  const maxAllowedCapital = totalCollateral * MAX_PORTFOLIO_ALLOCATION;

  const perpMarketAccount = driftClient.getPerpMarketAccount(marketIndex);
  if (!perpMarketAccount) {
    console.error(
      `  -> ❌ Could not get perp market account for index ${marketIndex}. Skipping check.`
    );
    return;
  }
  const minOrderSizeBN = perpMarketAccount.amm.orderStepSize;
  const minOrderSizeNumber = convertToNumber(minOrderSizeBN, BASE_PRECISION);
  console.log(`  -> Market Min Order Size (Step Size): ${minOrderSizeNumber}`);

  const desiredTradeValueQuote = totalCollateral * PORTFOLIO_RISK_PER_TRADE;
  const desiredTradeSizeBase = desiredTradeValueQuote / currentPrice;

  // Round the desired size DOWN to 2 decimal places to match market precision (e.g., for SOL-PERP)
  const roundedDesiredTradeSizeBase =
    Math.floor(desiredTradeSizeBase * 100) / 100;

  // Calculate estimated round-trip fee cost based on desired trade value and STORED fee
  // Note: This is calculated based on the *desired* entry size, used for TP check later
  const estimatedRoundTripFeeCostQuote =
    takerFeePercentState !== null
      ? desiredTradeValueQuote * (takerFeePercentState / 100) * 2
      : 0; // Default to 0 if fee wasn't fetched

  if (takerFeePercentState !== null) {
    console.log(
      `  -> Estimated Round-Trip Taker Fee Cost (on initial ${desiredTradeValueQuote.toFixed(
        2
      )}): ~$${estimatedRoundTripFeeCostQuote.toFixed(4)}`
    );
  } else {
    console.warn(
      "  -> Fee cost estimation skipped as fee percentage is unavailable."
    );
  }

  // Determine actual trade size for entry, using the rounded desired size
  // and ensuring it meets the minimum order/step size.
  const actualTradeSizeBase = Math.max(
    roundedDesiredTradeSizeBase,
    minOrderSizeNumber
  );
  console.log(
    `  -> Desired Trade Size (${(PORTFOLIO_RISK_PER_TRADE * 100).toFixed(
      1
    )}%): ~${desiredTradeSizeBase.toFixed(6)} Base`
  );
  console.log(
    `  -> Rounded Desired Size (2dp): ${roundedDesiredTradeSizeBase.toFixed(
      2
    )} Base`
  );
  console.log(
    `  -> Actual Trade Size (>= Min, 2dp): ${actualTradeSizeBase.toFixed(
      2
    )} Base` // Log with 2dp for clarity
  );

  // 7. Check Exit/Entry Conditions

  // --- Exit Conditions (Stop Loss & Take Profit) ---
  if (
    positionSizeBase !== 0 &&
    currentEntryPrice !== null &&
    takerFeePercentState !== null
  ) {
    // Only check exits if we have a position, know the entry price, AND know the fee

    const estimatedPnl =
      positionSizeBase > 0
        ? positionSizeBase * (currentPrice - currentEntryPrice) // Long PnL
        : positionSizeBase * (currentEntryPrice - currentPrice); // Short PnL

    // --- Calculate Initial Position Value (Used for SL and TP targets) ---
    const initialPositionValueQuote =
      Math.abs(positionSizeBase) * currentEntryPrice;

    // --- Stop Loss Check ---
    const maxAllowedLossQuote = initialPositionValueQuote * MAX_LOSS_PERCENTAGE;

    if (estimatedPnl < 0 && Math.abs(estimatedPnl) >= maxAllowedLossQuote) {
      console.log(
        `  -> 🛑 STOP LOSS Triggered: Estimated PnL ($${estimatedPnl.toFixed(
          4
        )}) <= Max Allowed Loss (-$${maxAllowedLossQuote.toFixed(4)})`
      );
      try {
        await closePosition(driftClient, marketIndex);
        currentEntryPrice = null; // Reset entry price after successful close
        console.log("  -> Position closed due to stop loss.");
      } catch (error) {
        console.error("  -> ❌ Error closing position on stop loss:", error);
      }
      return; // Exit function after stop loss attempt
    }

    // --- Percentage Take Profit Check (Check BEFORE Z-Score TP) ---
    if (initialPositionValueQuote > 0) {
      // Avoid division by zero if initial value is somehow zero
      const estimatedPnlPercentage = estimatedPnl / initialPositionValueQuote;
      if (estimatedPnlPercentage >= TAKE_PROFIT_PERCENTAGE) {
        console.log(
          `  -> ✅ TAKE PROFIT (Percentage Triggered): Estimated PnL (${(
            estimatedPnlPercentage * 100
          ).toFixed(2)}%) >= Target (${(TAKE_PROFIT_PERCENTAGE * 100).toFixed(
            1
          )}%)`
        );
        try {
          await closePosition(driftClient, marketIndex);
          currentEntryPrice = null; // Reset entry price after successful close
          console.log("  -> Position closed due to percentage take profit.");
        } catch (error) {
          console.error(
            "  -> ❌ Error closing position on percentage take profit:",
            error
          );
        }
        return; // Exit function after percentage TP attempt
      }
    }

    // --- Z-Score Take Profit Check (Only if SL and Percentage TP NOT Triggered) ---
    const takeProfitThresholdMet =
      positionSizeBase > 0
        ? zScore >= -Z_SCORE_EXIT_THRESHOLD // Long TP condition
        : zScore <= Z_SCORE_EXIT_THRESHOLD; // Short TP condition

    if (takeProfitThresholdMet) {
      const logDirection = positionSizeBase > 0 ? "Long" : "Short";
      const comparisonOperator = positionSizeBase > 0 ? ">=" : "<=";
      const zScoreExitValue =
        positionSizeBase > 0 ? -Z_SCORE_EXIT_THRESHOLD : Z_SCORE_EXIT_THRESHOLD;

      // Calculate dynamic minimum profit target based on initial value
      const dynamicMinProfitTargetQuote =
        initialPositionValueQuote * MINIMUM_PROFIT_PERCENTAGE;

      console.log(
        `  -> Potential Exit ${logDirection} Signal: Z-Score (${zScore.toFixed(
          4
        )}) ${comparisonOperator} ${zScoreExitValue}`
      );
      console.log(
        `  -> Checking PnL: Estimated PnL ($${estimatedPnl.toFixed(
          4
        )}) vs (Fee Cost ($${estimatedRoundTripFeeCostQuote.toFixed(
          4
        )}) + Min Profit (${(MINIMUM_PROFIT_PERCENTAGE * 100).toFixed(
          1
        )}% = $${dynamicMinProfitTargetQuote.toFixed(4)}))`
      );

      if (
        estimatedPnl >
        estimatedRoundTripFeeCostQuote + dynamicMinProfitTargetQuote
      ) {
        console.log("  -> ✅ PnL > Fees + Min Target. Proceeding with exit.");
        try {
          await closePosition(driftClient, marketIndex);
          currentEntryPrice = null; // Reset entry price after successful close
        } catch (error) {
          console.error(
            `  -> ❌ Error closing ${logDirection.toLowerCase()} position:`,
            error
          );
        }
        return; // Exit after attempting close
      } else {
        console.log(
          `  -> 🟡 Holding ${logDirection}: Estimated PnL does not meet fee + min profit target.`
        );
      }
    }
    // If neither stop loss nor take profit conditions met, continue (implicitly holds position)
  } else if (
    positionSizeBase !== 0 &&
    (currentEntryPrice === null || takerFeePercentState === null)
  ) {
    // Log warning if we are in a position but lack entry price or fee info for PnL/Stop check
    console.warn(
      `  -> ⚠️ Cannot check Stop Loss / Take Profit PnL: ${
        currentEntryPrice === null ? "Entry price not recorded." : ""
      } ${takerFeePercentState === null ? "Fee info unavailable." : ""}`
    );
    // We are in a position, but cannot evaluate exits properly.
    // We will NOT proceed to entry checks in this state.
    console.log(
      "  -> Holding position due to inability to evaluate exit conditions."
    );
    return; // Prevent attempting entries while in this indeterminate state
  }

  // --- Entry Condition Check ---
  // Only check for entries if we are currently flat (no position)
  if (positionSizeBase === 0) {
    // Check max allocation BEFORE checking entry signal
    if (currentCapitalUsage >= maxAllowedCapital) {
      // Check if currentCapitalUsage needs recalculation here if only done inside exit block
      console.log(
        `  -> 🟡 Skipping Entry: Current capital usage ($${currentCapitalUsage.toFixed(
          2 // Might need recalculation if position was just closed
        )}) >= max allocation ($${maxAllowedCapital.toFixed(2)})`
      );
    } else if (takerFeePercentState === null) {
      console.warn("  -> 🟡 Skipping Entry: Cannot proceed without fee info.");
    } else {
      // Sufficient capital and fee info available, check Z-score entry signals
      if (zScore < -Z_SCORE_ENTRY_THRESHOLD) {
        console.log(
          `  -> 🔥 Entry Long Signal: Z-Score (${zScore.toFixed(
            4
          )}) < ${-Z_SCORE_ENTRY_THRESHOLD}`
        );
        try {
          await placeMarketOrder(
            driftClient,
            marketIndex,
            PositionDirection.LONG,
            actualTradeSizeBase
          );
          currentEntryPrice = currentPrice; // Store entry price on successful order attempt
          console.log(
            `  -> Stored Entry Price: ${currentEntryPrice.toFixed(4)}`
          );
        } catch (error) {
          console.error("  -> ❌ Error placing long order:", error);
          currentEntryPrice = null; // Ensure entry price is null if order failed
        }
      } else if (zScore > Z_SCORE_ENTRY_THRESHOLD) {
        console.log(
          `  -> 🔥 Entry Short Signal: Z-Score (${zScore.toFixed(
            4
          )}) > ${Z_SCORE_ENTRY_THRESHOLD}`
        );
        try {
          await placeMarketOrder(
            driftClient,
            marketIndex,
            PositionDirection.SHORT,
            actualTradeSizeBase
          );
          currentEntryPrice = currentPrice; // Store entry price on successful order attempt
          console.log(
            `  -> Stored Entry Price: ${currentEntryPrice.toFixed(4)}`
          );
        } catch (error) {
          console.error("  -> ❌ Error placing short order:", error);
          currentEntryPrice = null; // Ensure entry price is null if order failed
        }
      }
    }
  }

  console.log("  -> Strategy check complete.");
}

// --- State Reset Function ---
/**
 * Resets the internal state of the mean reversion strategy (e.g., price queue).
 */
export function resetMeanReversionState() {
  console.log(" -> Resetting mean reversion strategy state...");
  priceQueue = [];
  takerFeePercentState = null; // Reset fee state
  currentEntryPrice = null; // Reset entry price state
  console.log(" -> Price queue, fee state, and entry price cleared.");
}

// Ensure imports are correct and unused variables are handled if necessary
// Add error handling for driftClient.getUser() if needed
// Consider edge cases like partial fills if using limit orders in the future
