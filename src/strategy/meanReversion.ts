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
const CALCULATION_PERIOD = 21; // Lookback period for EMA and StdDev calculations AND minimum data for trading
const MAX_QUEUE_LENGTH = 90; // Maximum number of prices to store in the queue
const Z_SCORE_ENTRY_THRESHOLD = 2.2; // Enter if Z-score exceeds this (positive or negative)
const Z_SCORE_EXIT_THRESHOLD = 0.3; // Exit (TP) if Z-score comes back within this range of 0
const PORTFOLIO_RISK_PER_TRADE = 0.05; // Trade size as % of total collateral (e.g., 5%)
const MAX_PORTFOLIO_ALLOCATION = 0.4; // Max % of total collateral to be in positions (e.g., 40%)
const MINIMUM_PROFIT_PERCENTAGE = 0.01; // Minimum profit target as 1% of initial position value (for Z-Score exit)
const MAX_LOSS_PERCENTAGE = 0.05; // Maximum loss (5%) based on initial position value before stop-loss
const TAKE_PROFIT_PERCENTAGE = 0.05; // Take profit if unrealized PnL reaches 5% of initial value
const LEVERAGE_FACTOR = 5; // The leverage multiplier to use

// --- State Variables ---
let priceQueue: number[] = [];
let takerFeePercentState: number | null = null; // Store fetched fee percentage
let currentEntryPrice: number | null = null; // Store estimated entry price
let lastEMA: number | null = null; // Store the last calculated EMA value

// --- Helper Functions ---

/**
 * Calculates the Exponential Moving Average (EMA) for the current price.
 * Uses an initial SMA if no previous EMA is available, based on the specified period.
 * @param currentPrice The latest price.
 * @param period The lookback period for the EMA calculation.
 * @param previousEMA The EMA calculated in the previous step.
 * @param priceData The full price queue (used to slice the relevant period).
 * @returns The current EMA, or null if data is insufficient.
 */
function calculateEMA(
  currentPrice: number,
  period: number, // This will be CALCULATION_PERIOD
  previousEMA: number | null,
  priceData: number[]
): number | null {
  // Check if enough data exists in the whole queue to perform the calculation period
  if (priceData.length < period) {
    // console.log(`Debug: EMA needs ${period} data points, has ${priceData.length}.`); // Optional debug log
    return null; // Not enough data in the queue yet for the calculation period
  }

  const smoothingFactor = 2 / (period + 1);
  const relevantPriceData = priceData.slice(-period); // Use only the last 'period' prices for seeding

  if (previousEMA !== null) {
    // Calculate EMA using the previous EMA
    return currentPrice * smoothingFactor + previousEMA * (1 - smoothingFactor);
  } else {
    // Calculate the initial SMA using only the relevant period data
    const sum = relevantPriceData.reduce((acc, val) => acc + val, 0);
    const initialSMA = sum / period;
    // Calculate the current EMA using the initial SMA as the "previous" value
    return currentPrice * smoothingFactor + initialSMA * (1 - smoothingFactor);
  }
}

/**
 * Calculates the Standard Deviation of the most recent data points relative to their EMA.
 * @param data The array of numbers (price queue).
 * @param ema The pre-calculated Exponential Moving Average (EMA).
 * @param period The number of recent data points to use for Std Dev calculation.
 * @returns The standard deviation, or null if data or EMA is insufficient.
 */
function calculateStdDev(
  data: number[],
  ema: number | null,
  period: number
): number | null {
  // Check if enough data exists and EMA is valid
  if (ema === null || data.length < period) {
    // console.log(`Debug: StdDev needs ${period} data points, has ${data.length}.`); // Optional debug log
    return null; // Need EMA and enough data for the calculation period
  }
  // Calculate StdDev based ONLY on the prices within the calculation period
  const dataSlice = data.slice(-period);
  const variance =
    dataSlice.reduce((acc, val) => acc + Math.pow(val - ema, 2), 0) / period; // Variance relative to EMA, using the specified period
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

  // 3. Update price queue (maintain up to MAX_QUEUE_LENGTH)
  priceQueue.push(currentPrice);
  if (priceQueue.length > MAX_QUEUE_LENGTH) {
    // Trim based on MAX_QUEUE_LENGTH
    priceQueue.shift();
  }
  console.log(
    `  -> Price Queue Size: ${priceQueue.length}/${MAX_QUEUE_LENGTH} (Min Trade Data: ${CALCULATION_PERIOD})` // Updated log
  );

  // 4. Calculate indicators (using CALCULATION_PERIOD)
  // These calculations will run if priceQueue.length >= CALCULATION_PERIOD
  let currentEMA: number | null = calculateEMA(
    currentPrice,
    CALCULATION_PERIOD,
    lastEMA,
    priceQueue
  );
  let currentStdDev: number | null = null;
  let zScore: number | null = null;

  if (currentEMA !== null) {
    lastEMA = currentEMA; // Store the calculated EMA for the next iteration
    console.log(`  -> EMA (${CALCULATION_PERIOD}): ${currentEMA.toFixed(4)}`);

    currentStdDev = calculateStdDev(priceQueue, currentEMA, CALCULATION_PERIOD);
    if (currentStdDev !== null) {
      console.log(
        `  -> StdDev (${CALCULATION_PERIOD}): ${currentStdDev.toFixed(4)}`
      );
      if (currentStdDev > 0) {
        zScore = (currentPrice - currentEMA) / currentStdDev;
        console.log(`  -> Z-Score: ${zScore.toFixed(4)}`);
      } else {
        console.log(
          "  -> Standard Deviation is zero, cannot calculate Z-Score."
        );
      }
    } else {
      console.log("  -> StdDev calculation failed (likely insufficient data).");
    }
  } else {
    console.log("  -> EMA calculation failed (likely insufficient data).");
    lastEMA = null; // Reset EMA state if calculation failed
  }

  // 5. Fetch current position (Fetch AFTER indicators are calculated)
  const openPositions = getOpenPositions(driftClient);
  const currentPosition = openPositions?.find(
    (p) => p.marketIndex === marketIndex
  );
  const positionSizeBase = currentPosition?.baseAssetAmount ?? 0;
  console.log(`  -> Current Position Size (Base): ${positionSizeBase}`);

  // 6. Pre-calculate Trade Sizes and Limits (Do this regardless of trading decision)
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

  // Calculate buying power using leverage
  const buyingPower = totalCollateral * LEVERAGE_FACTOR;
  console.log(
    `  -> Buying Power (${LEVERAGE_FACTOR}x Leverage): $${buyingPower.toFixed(
      2
    )}`
  ); // Log buying power

  // Calculate desired trade size based on buying power and risk percentage
  const desiredTradeValueQuote = buyingPower * PORTFOLIO_RISK_PER_TRADE;
  const desiredTradeSizeBase = desiredTradeValueQuote / currentPrice;

  const roundedDesiredTradeSizeBase =
    Math.floor(desiredTradeSizeBase * 100) / 100;

  const actualTradeSizeBase = Math.max(
    roundedDesiredTradeSizeBase,
    minOrderSizeNumber
  );
  console.log(
    `  -> Desired Trade Size (${(PORTFOLIO_RISK_PER_TRADE * 100).toFixed(
      1
    )}% of Buying Power): ~${desiredTradeSizeBase.toFixed(6)} Base` // Updated log to mention buying power
  );
  console.log(
    `  -> Rounded Desired Size (2dp): ${roundedDesiredTradeSizeBase.toFixed(
      2
    )} Base`
  );
  console.log(
    `  -> Actual Trade Size (>= Min, 2dp): ${actualTradeSizeBase.toFixed(
      2
    )} Base`
  );

  // Fetch market fees ONCE (Fetch AFTER indicators, BEFORE trade decisions)
  let estimatedRoundTripFeeCostQuote = 0; // Initialize with default
  if (takerFeePercentState === null && zScore !== null) {
    // Only fetch if we have a valid Z-Score (potential trade)
    console.log("  -> Fetching market fees...");
    try {
      const marketFees = await driftClient.getMarketFees(
        MarketType.PERP,
        marketIndex
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
        "  -> Fee fetching failed. Cannot reliably check profit targets or enter trades this cycle."
      );
      // Do not return yet, maybe stop-loss can still run? Or return if fees essential
    }
  } else if (takerFeePercentState !== null) {
    console.log(
      `  -> Using stored Taker Fee: ${takerFeePercentState.toFixed(4)}%`
    );
  }

  if (takerFeePercentState !== null) {
    estimatedRoundTripFeeCostQuote =
      desiredTradeValueQuote * (takerFeePercentState / 100) * 2;
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

  // <<< --- GUARD FOR TRADING DECISIONS --- >>>
  if (priceQueue.length < CALCULATION_PERIOD) {
    console.log(
      `  -> 🟡 Holding/No Action: Price queue size (${priceQueue.length}) is less than required minimum (${CALCULATION_PERIOD}) for trading decisions.`
    );
    return; // Exit before checking entry/exit conditions
  }
  // <<< --- END GUARD --- >>>

  // 7. Check Exit/Entry Conditions (Only run if queue size >= CALCULATION_PERIOD)

  // Check if Z-Score is valid before proceeding with trade logic
  if (zScore === null) {
    console.log(
      "  -> 🟡 Holding/No Action: Z-Score could not be calculated (StdDev likely zero or insufficient data)."
    );
    return; // Can't make decisions without Z-Score
  }

  // --- Exit Conditions (Stop Loss & Take Profit) ---
  if (
    positionSizeBase !== 0 &&
    currentEntryPrice !== null &&
    takerFeePercentState !== null // Ensure fee is known for PnL check
  ) {
    // Only check exits if we have a position, know the entry price, AND know the fee

    const estimatedPnl =
      positionSizeBase > 0
        ? positionSizeBase * (currentPrice - currentEntryPrice) // Long PnL
        : positionSizeBase * (currentEntryPrice - currentPrice); // Short PnL

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
        currentEntryPrice = null;
        console.log("  -> Position closed due to stop loss.");
      } catch (error) {
        console.error("  -> ❌ Error closing position on stop loss:", error);
      }
      return;
    }

    // --- Percentage Take Profit Check ---
    if (initialPositionValueQuote > 0) {
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
          currentEntryPrice = null;
          console.log("  -> Position closed due to percentage take profit.");
        } catch (error) {
          console.error(
            "  -> ❌ Error closing position on percentage take profit:",
            error
          );
        }
        return;
      }
    }

    // --- Z-Score Take Profit Check ---
    const takeProfitThresholdMet =
      positionSizeBase > 0
        ? zScore >= -Z_SCORE_EXIT_THRESHOLD
        : zScore <= Z_SCORE_EXIT_THRESHOLD;

    if (takeProfitThresholdMet) {
      const logDirection = positionSizeBase > 0 ? "Long" : "Short";
      const comparisonOperator = positionSizeBase > 0 ? ">=" : "<=";
      const zScoreExitValue =
        positionSizeBase > 0 ? -Z_SCORE_EXIT_THRESHOLD : Z_SCORE_EXIT_THRESHOLD;

      const dynamicMinProfitTargetQuote =
        initialPositionValueQuote * MINIMUM_PROFIT_PERCENTAGE;
      const profitCheckThreshold =
        estimatedRoundTripFeeCostQuote + dynamicMinProfitTargetQuote;

      console.log(
        `  -> Potential Exit ${logDirection} Signal: Z-Score (${zScore.toFixed(
          4
        )}) ${comparisonOperator} ${zScoreExitValue}`
      );
      console.log(
        `  -> Checking Profit Magnitude: |Estimated PnL ($${estimatedPnl.toFixed(
          4
        )})| vs (Fee Cost ($${estimatedRoundTripFeeCostQuote.toFixed(
          4
        )}) + Min Profit (${(MINIMUM_PROFIT_PERCENTAGE * 100).toFixed(
          1
        )}% = $${dynamicMinProfitTargetQuote.toFixed(
          4
        )})) [Threshold: $${profitCheckThreshold.toFixed(4)}]`
      );

      let profitSufficient = false;
      if (positionSizeBase > 0) {
        profitSufficient =
          estimatedPnl > 0 && estimatedPnl > profitCheckThreshold;
      } else if (positionSizeBase < 0) {
        profitSufficient =
          estimatedPnl < 0 && Math.abs(estimatedPnl) > profitCheckThreshold;
      }

      if (profitSufficient) {
        console.log(
          `  -> ✅ Profit Magnitude > Fees + Min Target. Proceeding with exit for ${logDirection}.`
        );
        try {
          await closePosition(driftClient, marketIndex);
          currentEntryPrice = null;
        } catch (error) {
          console.error(
            `  -> ❌ Error closing ${logDirection.toLowerCase()} position:`,
            error
          );
        }
        return;
      } else {
        console.log(
          `  -> 🟡 Holding ${logDirection}: Estimated Profit Magnitude does not meet fee + min profit target.`
        );
      }
    }
  } else if (
    positionSizeBase !== 0 &&
    (currentEntryPrice === null || takerFeePercentState === null)
  ) {
    console.warn(
      `  -> ⚠️ Cannot reliably check Stop Loss / Take Profit PnL: ${
        currentEntryPrice === null ? "Entry price not recorded." : ""
      } ${takerFeePercentState === null ? "Fee info unavailable." : ""}`
    );
    console.log(
      "  -> Holding position due to inability to evaluate exit conditions."
    );
    return;
  }

  // --- Entry Condition Check ---
  if (positionSizeBase === 0) {
    if (currentCapitalUsage >= maxAllowedCapital) {
      console.log(
        `  -> 🟡 Skipping Entry: Current capital usage ($${currentCapitalUsage.toFixed(
          2
        )}) >= max allocation ($${maxAllowedCapital.toFixed(2)})`
      );
    } else if (takerFeePercentState === null) {
      console.warn("  -> 🟡 Skipping Entry: Cannot proceed without fee info.");
    } else {
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
          currentEntryPrice = currentPrice;
          console.log(
            `  -> Stored Entry Price: ${currentEntryPrice.toFixed(4)}`
          );
        } catch (error) {
          console.error("  -> ❌ Error placing long order:", error);
          currentEntryPrice = null;
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
          currentEntryPrice = currentPrice;
          console.log(
            `  -> Stored Entry Price: ${currentEntryPrice.toFixed(4)}`
          );
        } catch (error) {
          console.error("  -> ❌ Error placing short order:", error);
          currentEntryPrice = null;
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
  takerFeePercentState = null;
  currentEntryPrice = null;
  lastEMA = null;
  console.log(
    " -> Price queue, fee state, entry price, and EMA state cleared."
  ); // Updated log
}

// Ensure imports are correct and unused variables are handled if necessary
// Add error handling for driftClient.getUser() if needed
// Consider edge cases like partial fills if using limit orders in the future
