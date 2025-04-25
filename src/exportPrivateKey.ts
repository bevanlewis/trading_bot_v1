//* This file is used to export the private key so that it can be used by common wallets.

// src/exportPrivateKey.ts
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
// Import the function that handles loading the keypair using .env
import { loadKeypair } from "./config"; // Make sure dotenv.config() is called inside config.ts

console.log("Attempting to load keypair using configuration from .env...");

try {
  // Use the centralized function to load the keypair
  // This reads SOLANA_KEYPAIR_PATH from .env and loads the Keypair object
  const keypair: Keypair = loadKeypair();

  // The Keypair object's secretKey property holds the full 64 bytes (priv + pub)
  const fullKeyPairUint8Array = keypair.secretKey;

  // Validate the array length (should be 64 bytes)
  if (fullKeyPairUint8Array.length !== 64) {
    // This should technically not happen if loadKeypair worked, but good to check
    throw new Error(
      `Loaded keypair secretKey has unexpected length: ${fullKeyPairUint8Array.length}`
    );
  }

  // --- Encode the full 64-byte array ---
  const fullKeyPairBase58 = bs58.encode(fullKeyPairUint8Array);
  // ---

  // --- Extract and encode the 32-byte private key ---
  // Slice the first 32 bytes from the full 64-byte secretKey array
  const privateKeyUint8Array_32byte = fullKeyPairUint8Array.slice(0, 32);
  const privateKeyBase58_32byte = bs58.encode(privateKeyUint8Array_32byte);

  // --- SECURITY WARNING ---
  console.log("\n\n*****************************************************");
  console.log("**                 SECURITY WARNING!                 **");
  console.log("** The following strings contain private key data.   **");
  console.log("** NEVER share them or store them insecurely.        **");
  console.log("*****************************************************\n");

  console.log(
    "--- Option 1: FULL 64-byte Keypair (Base58 Encoded - This worked for import) ---"
  );
  console.log(fullKeyPairBase58);
  console.log("\n-----------------------------------------------------\n");

  console.log("--- Option 2: 32-byte Private Key Only (Base58 Encoded) ---");
  console.log(privateKeyBase58_32byte);
  console.log("\n*****************************************************\n");
} catch (error) {
  // Catch errors potentially thrown by loadKeypair
  console.error("\n❌ An error occurred during private key export:");
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
  } else {
    console.error("   An unknown error occurred.");
  }
  process.exit(1);
}
