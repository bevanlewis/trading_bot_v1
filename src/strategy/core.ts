import { DriftClient } from "@drift-labs/sdk";
import {
  runMeanReversionLogic,
  resetMeanReversionState,
} from "./meanReversion"; // Assuming logic lives here

let isBotRunning = false;
let loopTimeoutId: NodeJS.Timeout | null = null;
const BOT_LOOP_INTERVAL_MS = 5000; // Run checks every 5 seconds (example)

/**
 * Starts the main trading bot loop.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @param marketIndex The perp market index to trade.
 */
export function startTradingLoop(
  driftClient: DriftClient,
  marketIndex: number
) {
  if (isBotRunning) {
    console.log("Bot loop is already running.");
    return;
  }

  console.log(`Starting trading loop for market ${marketIndex}...`);
  isBotRunning = true;

  const runLoop = async () => {
    if (!isBotRunning) {
      console.log("Loop stop signal received.");
      return; // Exit loop if stopped
    }

    console.log(`\n[${new Date().toISOString()}] Running strategy check...`);
    try {
      // Call the specific strategy logic function
      await runMeanReversionLogic(driftClient, marketIndex);
    } catch (error) {
      console.error("❌ Error during strategy execution:", error);
      // Decide if you want to stop the bot on error, or just log and continue
      // stopTradingLoop();
    }

    // Schedule the next run
    if (isBotRunning) {
      loopTimeoutId = setTimeout(runLoop, BOT_LOOP_INTERVAL_MS);
    }
  };

  // Start the first iteration immediately
  runLoop();
}

/**
 * Stops the main trading bot loop and resets strategy state.
 */
export function stopTradingLoop() {
  if (!isBotRunning) {
    console.log("Bot loop is not running.");
    return;
  }

  console.log("Stopping trading loop...");
  isBotRunning = false;
  if (loopTimeoutId) {
    clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
  }

  // Reset the strategy state (e.g., clear price queue)
  resetMeanReversionState();

  console.log("Trading loop stopped.");
}

// Function to check if the bot is currently running
export function isLoopRunning(): boolean {
  return isBotRunning;
}
