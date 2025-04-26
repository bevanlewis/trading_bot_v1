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

// Placeholder functions for actions still needing implementation
const startBot = async () => console.log("\n Bot starting... (Placeholder)\n");
const stopBot = async () => console.log("\n Bot stopping... (Placeholder)\n");

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

    // Add try-catch around the actions to handle errors gracefully
    try {
      switch (choice) {
        case "start":
          await startBot();
          break;
        case "stop":
          await stopBot();
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
          running = false;
          break;
        default:
          console.log("Invalid choice.");
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
    }

    // Pause briefly before showing the menu again, unless exiting
    if (running) {
      // Use 'input' for the pause prompt
      await input({ message: "Press Enter to continue..." });
      console.clear(); // Clear console before showing menu again
    }
  }

  // --- Unsubscribe DriftClient on Exit ---
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
