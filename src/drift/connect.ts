//* This is the main file for connecting to Drift and testing the connection.

// src/drift/connect.ts
import {
  DriftClient,
  Wallet,
  UserAccount,
  BulkAccountLoader,
} from "@drift-labs/sdk";
import { Keypair } from "@solana/web3.js";
// import { getSolanaConnection, loadKeypair, activeConfig } from "../config";

// --- Refactored: Function to Test Drift Connection (Accepts DriftClient) ---
/**
 * Performs checks using a pre-initialized and subscribed DriftClient.
 * @param driftClient An initialized and subscribed DriftClient instance.
 */
export async function testDriftConnection(driftClient: DriftClient) {
  console.log(`\n--- Testing Drift Connection (using existing client) ---`);
  // REMOVED: Initialization, subscription, unsubscription logic
  try {
    // Use the passed driftClient
    if (!driftClient.isSubscribed) {
      console.error(
        "\n❌ DriftClient is not subscribed. Cannot perform tests."
      );
      return;
    }

    // Log wallet from the client
    console.log(
      `   Wallet Public Key: ${driftClient.wallet.publicKey.toBase58()}`
    );
    console.log(`   Using Environment: ${driftClient.env}`);
    console.log(
      `   Using Connection Endpoint: ${driftClient.connection.rpcEndpoint}`
    );

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
  } catch (error) {
    console.error("\n❌ Error during Drift connection test:", error);
  } finally {
    // REMOVED: Unsubscribe logic here
    console.log("---------------------------------------------");
  }
}

// Helper function to convert byte array market names to readable strings (optional)
// function convertToSymbol(bytes: number[]): string {
//     return Buffer.from(bytes).toString('utf8').trim();
// }
