//* This is the main file for connecting to Drift and testing the connection.

// src/connectDrift.ts
import {
  DriftClient,
  Wallet,
  UserAccount,
  BulkAccountLoader,
} from "@drift-labs/sdk";
import { Keypair } from "@solana/web3.js";
import { getSolanaConnection, loadKeypair, activeConfig } from "./config";

// Main async function to connect to Drift and test
async function checkDriftConnection() {
  console.log(
    `Attempting to connect to Drift Protocol (${activeConfig.driftEnv})...`
  );
  console.log(`   RPC Endpoint: ${activeConfig.rpcUrl}`);

  try {
    // 1. Load Solana Keypair
    const keypair: Keypair = loadKeypair();
    console.log(`   Wallet Public Key: ${keypair.publicKey.toBase58()}`);

    // 2. Create Solana Connection
    const connection = getSolanaConnection();
    console.log("   Solana connection object created.");

    // 3. Wrap Keypair in Drift Wallet
    // The DriftClient requires the keypair to be wrapped in its Wallet class
    const wallet = new Wallet(keypair);
    console.log("   Drift SDK Wallet wrapper created.");

    // 4. Initialize DriftClient
    console.log("   Initializing DriftClient...");
    const driftClient = new DriftClient({
      connection: connection,
      wallet: wallet,
      env: activeConfig.driftEnv,
      // --- Force polling instead of websockets for diagnosis ---
      accountSubscription: {
        type: "polling",
        accountLoader: new BulkAccountLoader(
          connection,
          activeConfig.solanaCommitment ?? "confirmed", // Use commitment from config
          5000 // Polling interval in ms (e.g., 5 seconds)
        ),
      },
    });
    console.log("   DriftClient instance created (using polling).");

    // 5. Subscribe to DriftClient
    // This is crucial! It fetches initial market data, oracle data, etc.
    console.log("   Subscribing DriftClient (fetches initial state)...");
    const subscribeSucceeded = await driftClient.subscribe();
    if (!subscribeSucceeded) {
      throw new Error("DriftClient failed to subscribe.");
    }
    console.log("   DriftClient subscribed successfully.");

    // --- Test Drift Connection ---

    // a) Check if Drift User Account exists for this wallet
    console.log("\n   Checking for existing Drift UserAccount...");
    let userAccount: UserAccount | null = null;
    try {
      userAccount = driftClient.getUser().getUserAccount();
      console.log(
        `   ✅ Found UserAccount data for subAccountId: ${userAccount.subAccountId}`
      );
    } catch (error) {
      console.log(
        `   🟡 UserAccount not found or error fetching. (Error: ${
          error instanceof Error ? error.message : String(error)
        })`
      );
      console.log(
        `   Hint: You might need to initialize the user account on Drift first.`
      );
      console.log(`   Example: await driftClient.initializeUserAccount();`);
    }

    // b) Fetch available Perp Markets
    console.log("\n   Fetching available Perp Markets...");
    const perpMarketAccounts = driftClient.getPerpMarketAccounts();
    if (perpMarketAccounts && perpMarketAccounts.length > 0) {
      console.log(`   ✅ Found ${perpMarketAccounts.length} Perp Market(s).`);
      // Optionally list them:
      // perpMarketAccounts.forEach(market => {
      //     console.log(`      - Market Index ${market.marketIndex}: ${convertToSymbol(market.name)}`);
      // });
    } else {
      console.log(
        "   🟡 No Perp Markets data found (this is unexpected after successful subscribe)."
      );
    }

    // c) Fetch available Spot Markets (similar test)
    console.log("\n   Fetching available Spot Markets...");
    const spotMarketAccounts = driftClient.getSpotMarketAccounts();
    if (spotMarketAccounts && spotMarketAccounts.length > 0) {
      console.log(`   ✅ Found ${spotMarketAccounts.length} Spot Market(s).`);
      // Spot Market 0 is typically Quote (USDC), Market 1 is usually SOL
    } else {
      console.log(
        "   🟡 No Spot Markets data found (this is unexpected after successful subscribe)."
      );
    }

    console.log("\n✅ Drift Protocol Connection Test Completed!");

    // Unsubscribe when done (important for cleanup)
    console.log("\n   Unsubscribing DriftClient...");
    await driftClient.unsubscribe();
    console.log("   DriftClient unsubscribed.");
  } catch (error) {
    console.error("\n❌ Error during Drift connection or test:");
    if (error instanceof Error) {
      console.error(`   Message: ${error.message}`);
    } else {
      console.error("   An unknown error occurred:", error);
    }
    process.exit(1); // Exit with error code
  }
}

// Execute the async function
checkDriftConnection();

// Helper function to convert byte array market names to readable strings (optional)
// function convertToSymbol(bytes: number[]): string {
//     return Buffer.from(bytes).toString('utf8').trim();
// }
