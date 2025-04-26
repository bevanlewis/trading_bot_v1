// src/strategy/meanReversion.ts
import {
  DriftClient,
  PositionDirection,
  BN,
  convertToNumber,
  BASE_PRECISION,
} from "@drift-labs/sdk";
import {
  getOraclePriceData,
  getOpenPositions,
  getAccountState,
} from "../drift/data";
import { placeMarketOrder, closePosition } from "../drift/orders";

// --- Strategy Configuration ---
const PRICE_QUEUE_LENGTH = 21; // Lookback period for SMA
const Z_SCORE_ENTRY_THRESHOLD = 2.0; // Enter if Z-score exceeds this (positive or negative)
const Z_SCORE_EXIT_THRESHOLD = 0.5; // Exit (TP) if Z-score comes back within this range of 0
const PORTFOLIO_RISK_PER_TRADE = 0.02; // Trade size as % of total collateral (e.g., 2%)
const MAX_PORTFOLIO_ALLOCATION = 0.4; // Max % of total collateral to be in positions (e.g., 40%)

// --- State Variables ---
let priceQueue: number[] = [];

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

  // 5. Fetch current position
  const openPositions = getOpenPositions(driftClient);
  const currentPosition = openPositions?.find(
    (p) => p.marketIndex === marketIndex
  );
  const positionSizeBase = currentPosition?.baseAssetAmount ?? 0;
  console.log(`  -> Current Position Size (Base): ${positionSizeBase}`);

  // 6. Calculate current capital usage and limits
  const currentCapitalUsage = Math.abs(positionSizeBase) * currentPrice; // Approx value in quote
  const maxAllowedCapital = totalCollateral * MAX_PORTFOLIO_ALLOCATION;

  // Fetch Perp Market Account for market parameters
  const perpMarketAccount = driftClient.getPerpMarketAccount(marketIndex);
  if (!perpMarketAccount) {
    console.error(
      `  -> ❌ Could not get perp market account for index ${marketIndex}. Skipping check.`
    );
    return;
  }
  // Get the minimum order size (step size) and convert it
  const minOrderSizeBN = perpMarketAccount.amm.orderStepSize;
  const minOrderSizeNumber = convertToNumber(minOrderSizeBN, BASE_PRECISION);
  console.log(`  -> Market Min Order Size (Step Size): ${minOrderSizeNumber}`);

  // Calculate desired trade size based on portfolio risk
  const desiredTradeValueQuote = totalCollateral * PORTFOLIO_RISK_PER_TRADE;
  const desiredTradeSizeBase = desiredTradeValueQuote / currentPrice;

  // Determine actual trade size, ensuring it meets minimum
  const actualTradeSizeBase = Math.max(
    desiredTradeSizeBase,
    minOrderSizeNumber
  );

  console.log(
    `  -> Desired Trade Size (2%): ~${desiredTradeSizeBase.toFixed(6)} Base`
  );
  console.log(
    `  -> Actual Trade Size (>= Min): ${actualTradeSizeBase.toFixed(6)} Base`
  );

  // 7. Check Entry/Exit Conditions using Z-Score

  // Exit condition: If we have a position, check if Z-score crossed exit threshold
  if (positionSizeBase > 0) {
    // Currently Long
    if (zScore >= -Z_SCORE_EXIT_THRESHOLD) {
      // Z-score moved up towards/past zero
      console.log(
        `  -> ✅ Exit Long (Take Profit): Z-Score (${zScore.toFixed(
          4
        )}) >= ${-Z_SCORE_EXIT_THRESHOLD}`
      );
      try {
        await closePosition(driftClient, marketIndex);
      } catch (error) {
        console.error("  -> ❌ Error closing long position:", error);
      }
      return; // Exit after closing
    }
  } else if (positionSizeBase < 0) {
    // Currently Short
    if (zScore <= Z_SCORE_EXIT_THRESHOLD) {
      // Z-score moved down towards/past zero
      console.log(
        `  -> ✅ Exit Short (Take Profit): Z-Score (${zScore.toFixed(
          4
        )}) <= ${Z_SCORE_EXIT_THRESHOLD}`
      );
      try {
        await closePosition(driftClient, marketIndex);
      } catch (error) {
        console.error("  -> ❌ Error closing short position:", error);
      }
      return; // Exit after closing
    }
  }

  // Entry condition: If no position, check if Z-score crossed entry threshold
  if (positionSizeBase === 0) {
    // Check max allocation BEFORE checking entry signal
    if (currentCapitalUsage >= maxAllowedCapital) {
      console.log(
        `  -> 🟡 Skipping Entry: Current capital usage ($${currentCapitalUsage.toFixed(
          2
        )}) >= max allocation ($${maxAllowedCapital.toFixed(2)})`
      );
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
        } catch (error) {
          console.error("  -> ❌ Error placing long order:", error);
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
        } catch (error) {
          console.error("  -> ❌ Error placing short order:", error);
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
  console.log(" -> Price queue cleared.");
}
