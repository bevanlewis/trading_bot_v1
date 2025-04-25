import { Keypair } from "@solana/web3.js";
// Import the function that handles loading the keypair using .env
import { loadKeypair } from "./config"; // Assuming config.ts is in the same directory

// Define the expected public key from the rule
const expectedPublicKey = "bot1EPKHw9PN9oS5ix4XPwdWDg8M3thqnquE2bsu2Lt";

console.log("Attempting to load keypair using configuration from .env...");

try {
  // Use the centralized function to load the keypair
  // This function reads the path from .env and handles file reading/parsing
  const keypair: Keypair = loadKeypair();

  // Get the public key as a base58 string from the loaded keypair
  const derivedPublicKey = keypair.publicKey.toBase58();

  // We don't need to log the derived key here because loadKeypair already does it.
  // console.log(`Derived Public Key:  ${derivedPublicKey}`);
  console.log(`Expected Public Key: ${expectedPublicKey}`);

  // Compare the derived public key with the expected one
  if (derivedPublicKey === expectedPublicKey) {
    console.log(
      "\n✅ Success! The derived public key matches the expected public key."
    );
  } else {
    console.error(
      "\n❌ Error! The derived public key does NOT match the expected public key."
    );
    console.error(`   Expected: ${expectedPublicKey}`);
    console.error(`   Derived:  ${derivedPublicKey}`); // Still useful to show mismatch
  }
} catch (error) {
  // Catch errors potentially thrown by loadKeypair (e.g., env var missing, file not found)
  console.error("\n❌ An error occurred during keypair validation:");
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
  } else {
    console.error("   An unknown error occurred.");
  }
  // Exit with an error code to indicate failure
  process.exit(1);
}
