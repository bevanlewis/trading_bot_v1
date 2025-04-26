// src/cli.ts
// Import specific functions from the new package
import { select, input, Separator } from "@inquirer/prompts";

// Import DriftClient and related classes for initialization
import { DriftClient, Wallet, BulkAccountLoader } from "@drift-labs/sdk";

// Import config loading functions
import { getSolanaConnection, loadKeypair, activeConfig } from "./config";

// Import refactored functions (accepting DriftClient)
import { runSolanaConnectionTest } from "./solana/connect"; // Solana test doesn't need drift client
// Renamed imports for drift functions
import { testDriftConnection } from "./drift/connect";
import { fetchSingleMarketInfo, fetchAccountAndPositions } from "./drift/data";
import { runKeypairValidation } from "./utils/validateKeypair"; // Util doesn't need drift client

// Import the new cancel function
import { cancelAllPerpOrders } from "./drift/orders";

// Import loop control functions
import {
  startTradingLoop,
  stopTradingLoop,
  isLoopRunning,
} from "./strategy/core";

// --- Main Menu Function ---
async function showMainMenu() {
  // Use the 'select' function from @inquirer/prompts
  const action = await select({
    message: "Drift Trading Bot - Main Menu",
    choices: [
      { name: "Start Bot", value: "start" },
      { name: "Stop Bot", value: "stop" },
      new Separator(),
      { name: "Test Solana Connection", value: "testSolana" },
      { name: "Test Drift Connection", value: "testDrift" },
      { name: "Fetch Single Market Info", value: "fetchMarketInfo" },
      { name: "View Account & Positions", value: "viewAccount" },
      { name: "Cancel All Perp Orders", value: "cancelAll" },
      { name: "Run Utility Tests", value: "runUtils" },
      new Separator(),
      { name: "Exit", value: "exit" },
    ],
    // loop: false, // 'loop' is often the default or handled differently, check docs if needed
  });
  return action;
}

// --- Main Application Loop ---
async function runCli() {
  console.clear(); // Clear console on start
  console.log("Welcome to the Drift Trading Bot!");

  // --- Initialize DriftClient ONCE ---
  let driftClient: DriftClient | null = null;
  let isClientSubscribed = false;
  try {
    console.log("\nInitializing Drift Client...");
    const connection = getSolanaConnection();
    const keypair = loadKeypair();
    const wallet = new Wallet(keypair);
    driftClient = new DriftClient({
      connection,
      wallet,
      env: activeConfig.driftEnv,
      accountSubscription: {
        type: "polling",
        accountLoader: new BulkAccountLoader(
          connection,
          activeConfig.solanaCommitment ?? "confirmed",
          5000 // Poll interval can be adjusted
        ),
      },
    });
    console.log("Subscribing Drift Client...");
    isClientSubscribed = await driftClient.subscribe();
    if (!isClientSubscribed) {
      throw new Error("Drift Client failed to subscribe.");
    }
    console.log("✅ Drift Client Initialized and Subscribed.");
    // Optional: Short pause to ensure initial data load if needed by first action
    // await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (error) {
    console.error(
      "\n❌ Failed to initialize or subscribe Drift Client:",
      error
    );
    console.error("Exiting CLI.");
    process.exit(1); // Exit if client fails to init
  }

  // --- Main Loop ---
  let running = true;
  while (running) {
    const choice = await showMainMenu();
    let pauseAfterAction = true; // Flag to control pausing

    try {
      switch (choice) {
        case "start":
          if (isLoopRunning()) {
            console.log("\nBot is already running.");
          } else {
            // Ask user for market index to trade
            const marketIndexInput = await input({
              message:
                "Enter Perp Market Index to trade (e.g., 0 for SOL-PERP):",
              default: "0",
              validate: (value) => {
                const num = parseInt(value, 10);
                return !isNaN(num) && num >= 0
                  ? true
                  : "Please enter a non-negative number.";
              },
            });
            const marketIndex = parseInt(marketIndexInput, 10);
            console.log("\n--- Starting Bot ---");
            startTradingLoop(driftClient, marketIndex);
            pauseAfterAction = false; // Don't pause after starting the bot
            console.log("\nBot loop started in background. Menu is active.");
          }
          break;
        case "stop":
          if (!isLoopRunning()) {
            console.log("\nBot is not running.");
          } else {
            console.log("\n--- Stopping Bot ---");
            stopTradingLoop();
            // Keep pauseAfterAction = true here
          }
          break;
        case "testSolana":
          console.log("\n--- Running Solana Connection Test ---");
          await runSolanaConnectionTest(); // No change, doesn't need drift client
          console.log("\n--------------------------------------");
          break;
        case "testDrift":
          console.log("\n--- Running Drift Connection Test ---");
          // Pass the initialized client
          await testDriftConnection(driftClient);
          // Log separator is now inside testDriftConnection
          break;
        case "fetchMarketInfo":
          console.log("\n--- Fetch Single Market Info ---");
          const marketIndexInput = await input({
            message:
              "Enter Perp Market Index to fetch data for (e.g., 0 for SOL-PERP):",
            default: "0",
            validate: (value) => {
              const num = parseInt(value, 10);
              return !isNaN(num) && num >= 0
                ? true
                : "Please enter a non-negative number.";
            },
          });
          const marketIndex = parseInt(marketIndexInput, 10);
          // Pass the initialized client
          await fetchSingleMarketInfo(driftClient, marketIndex);
          // Log separator is now inside fetchSingleMarketInfo
          break;
        case "viewAccount":
          console.log("\n--- View Account State & Positions ---");
          // Pass the initialized client
          await fetchAccountAndPositions(driftClient);
          // Log separator is now inside fetchAccountAndPositions
          break;
        case "cancelAll":
          console.log("\n--- Cancelling All Perp Orders ---");
          // Pass the initialized client
          const cancelTx = await cancelAllPerpOrders(driftClient);
          if (cancelTx) {
            console.log("   Cancellation Request Sent. Tx:", cancelTx);
          } else {
            console.log(
              "   No orders found to cancel or transaction not needed."
            );
          }
          console.log("----------------------------------");
          break;
        case "runUtils":
          console.log("\n--- Running Utility Tests (Keypair Validation) ---");
          const validationSuccess = await runKeypairValidation(); // No change, doesn't need drift client
          if (validationSuccess) {
            console.log("\n✅ Keypair Validation Succeeded.");
          } else {
            console.log(
              "\n❌ Keypair Validation Failed. Check logs above and .env configuration."
            );
          }
          console.log("\n--------------------------------------------------");
          break;
        case "exit":
          // Ensure bot loop is stopped before exiting
          if (isLoopRunning()) {
            console.log("\nStopping bot loop before exiting...");
            stopTradingLoop();
          }
          pauseAfterAction = false; // Don't pause before exiting
          running = false;
          break;
        default:
          console.log("Invalid choice.");
          pauseAfterAction = false; // Don't pause on invalid choice
      }
    } catch (error) {
      // Catch errors from the awaited functions
      console.error("\n❌ An error occurred while executing the action:");
      if (error instanceof Error) {
        console.error(`   Message: ${error.message}`);
        // Optional: Print stack trace for more details during development
        // console.error(`   Stack: ${error.stack}`);
      } else {
        console.error("   An unknown error occurred:", error);
      }
      console.log("\nPlease check the output above for details.");
      // Keep pauseAfterAction = true here to let user see error
    }

    // Pause briefly before showing the menu again, based on the flag
    if (running && pauseAfterAction) {
      await input({ message: "Press Enter to continue..." });
    }
    // Always clear console before next menu display if not exiting
    if (running) {
      console.clear();
    }
  }

  // --- Unsubscribe DriftClient on Exit ---
  // Ensure bot loop is stopped before unsubscribing client
  if (isLoopRunning()) {
    stopTradingLoop();
  }
  if (driftClient && isClientSubscribed) {
    console.log("\nUnsubscribing Drift Client...");
    await driftClient.unsubscribe();
    console.log("Client unsubscribed.");
  }

  console.log("\nExiting Drift Trading Bot. Goodbye!\n");
  process.exit(0);
}

// --- Start the CLI ---
runCli().catch((error) => {
  console.error("\n❌ CLI Error:", error);
  process.exit(1);
});
