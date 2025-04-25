//* This file is used to validate the keypair.

import { Keypair } from "@solana/web3.js";
// Import the functions that handle loading the keypair and the expected key
import {
  loadKeypair,
  expectedPublicKey as expectedPublicKeyFromEnv,
} from "../config"; // Updated import path

console.log("Attempting to load keypair using configuration from .env...");

// Check if the expected public key was loaded from the environment
if (!expectedPublicKeyFromEnv) {
  console.error(
    "\n❌ Error! The EXPECTED_PUBLIC_KEY environment variable is not set in your .env file."
  );
  process.exit(1);
}

console.log(`Expected Public Key (from .env): ${expectedPublicKeyFromEnv}`);

try {
  // Use the centralized function to load the keypair
  // This function reads the path from .env and handles file reading/parsing
  const keypair: Keypair = loadKeypair();

  // Get the public key as a base58 string from the loaded keypair
  const derivedPublicKey = keypair.publicKey.toBase58();

  // Compare the derived public key with the one loaded from .env
  if (derivedPublicKey === expectedPublicKeyFromEnv) {
    console.log(
      "\n✅ Success! The derived public key matches the expected public key from .env."
    );
  } else {
    console.error(
      "\n❌ Error! The derived public key does NOT match the expected public key from .env."
    );
    console.error(`   Expected: ${expectedPublicKeyFromEnv}`);
    console.error(`   Derived:  ${derivedPublicKey}`);
    process.exit(1); // Exit with error if mismatch
  }
} catch (error) {
  // Catch errors potentially thrown by loadKeypair (e.g., SOLANA_KEYPAIR_PATH missing, file not found)
  console.error("\n❌ An error occurred during keypair validation:");
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
  } else {
    console.error("   An unknown error occurred.");
  }
  // Exit with an error code to indicate failure
  process.exit(1);
}
