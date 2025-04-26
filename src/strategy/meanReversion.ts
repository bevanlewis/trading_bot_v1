// src/strategy/meanReversion.ts
import { DriftClient, PositionDirection } from "@drift-labs/sdk";
import { getOraclePriceData, getOpenPositions } from "../drift/data";
import { placeMarketOrder, closePosition } from "../drift/orders";

// --- Strategy Configuration ---
const PRICE_QUEUE_LENGTH = 21; // Lookback period for SMA
const Z_SCORE_ENTRY_THRESHOLD = 2.0; // Enter if Z-score exceeds this (positive or negative)
const Z_SCORE_EXIT_THRESHOLD = 0.5; // Exit (TP) if Z-score comes back within this range of 0
const TRADE_AMOUNT_BASE = 0.01; // Example trade size

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

  // 1. Fetch latest price
  const oraclePriceData = getOraclePriceData(driftClient, marketIndex);
  if (!oraclePriceData) {
    console.error("  -> ❌ Could not get oracle price data. Skipping check.");
    return;
  }
  const currentPrice = oraclePriceData.price;
  console.log(`  -> Current Price: ${currentPrice.toFixed(4)}`);

  // 2. Update price queue
  priceQueue.push(currentPrice);
  if (priceQueue.length > PRICE_QUEUE_LENGTH) {
    priceQueue.shift(); // Keep queue at fixed size
  }
  console.log(
    `  -> Price Queue Size: ${priceQueue.length}/${PRICE_QUEUE_LENGTH}`
  );

  // 3. Calculate indicators
  const sma = calculateSMA(priceQueue);
  if (sma === null) {
    console.log("  -> Not enough data for SMA calculation yet.");
    return;
  }
  const stdDev = calculateStdDev(priceQueue, sma);
  if (stdDev === null) {
    console.log("  -> Not enough data for StdDev calculation yet.");
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

  // 4. Fetch current position
  const openPositions = getOpenPositions(driftClient);
  const currentPosition = openPositions?.find(
    (p) => p.marketIndex === marketIndex
  );
  const positionSize = currentPosition?.baseAssetAmount ?? 0;
  console.log(`  -> Current Position Size: ${positionSize}`);

  // 5. Check Entry/Exit Conditions using Z-Score

  // Exit condition: If we have a position, check if Z-score crossed exit threshold
  if (positionSize > 0) {
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
  } else if (positionSize < 0) {
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
  if (positionSize === 0) {
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
          TRADE_AMOUNT_BASE
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
          TRADE_AMOUNT_BASE
        );
      } catch (error) {
        console.error("  -> ❌ Error placing short order:", error);
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
