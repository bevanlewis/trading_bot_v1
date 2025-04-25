// src/config.ts
import { Commitment, Connection, Keypair } from "@solana/web3.js";
import { DriftEnv } from "@drift-labs/sdk";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

// Load environment variables from .env file
// Must be called before accessing process.env variables
dotenv.config();

// --- Wallet Loading ---

/**
 * Loads a Solana Keypair from the file path specified in the
 * SOLANA_KEYPAIR_PATH environment variable.
 *
 * @returns {Keypair} The loaded Solana Keypair.
 * @throws {Error} If SOLANA_KEYPAIR_PATH is not set in the .env file.
 * @throws {Error} If the keypair file cannot be read or parsed.
 */
export function loadKeypair(): Keypair {
  const keypairPathEnv = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypairPathEnv) {
    throw new Error(
      "❌ SOLANA_KEYPAIR_PATH environment variable is not set. Please check your .env file."
    );
  }

  // Construct the full path relative to the project root
  const keypairPath = path.resolve(__dirname, "..", keypairPathEnv);
  console.log(
    `Attempting to load keypair from path specified in .env: ${keypairPath}`
  );

  try {
    const keypairFileContent = fs.readFileSync(keypairPath, "utf-8");
    const secretKeyArray = JSON.parse(keypairFileContent);
    const secretKey = Uint8Array.from(secretKeyArray);
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log(
      `✅ Successfully loaded keypair for public key: ${keypair.publicKey.toBase58()}`
    );
    return keypair;
  } catch (error) {
    console.error(`❌ Error loading keypair from ${keypairPath}:`, error);
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        `Keypair file not found at '${keypairPath}'. Check SOLANA_KEYPAIR_PATH in .env.`
      );
    }
    throw new Error(`Failed to load or parse keypair file at ${keypairPath}.`);
  }
}

// --- Environment Configuration ---

// Define the possible environments
export type Environment = "devnet" | "mainnet";

// Get the current environment from .env, defaulting to 'devnet'
const currentEnv = (
  process.env.DRIFT_ENV?.toLowerCase() === "mainnet" ? "mainnet" : "devnet"
) as Environment;

console.log(`⚙️  Configuring for environment: ${currentEnv}`);

// --- Get URLs from Environment Variables (with defaults) ---
const defaultDevnetRpcUrl = "https://api.devnet.solana.com";
const defaultMainnetRpcUrl = "https://api.mainnet-beta.solana.com";

const devnetRpcUrl = process.env.DEVNET_RPC_URL || defaultDevnetRpcUrl;
const mainnetRpcUrl = process.env.MAINNET_RPC_URL || defaultMainnetRpcUrl;
const devnetWsUrl = process.env.DEVNET_WS_URL; // Optional, so no default needed here
const mainnetWsUrl = process.env.MAINNET_WS_URL; // Optional

// Log if default RPC URLs are being used
if (devnetRpcUrl === defaultDevnetRpcUrl && currentEnv === "devnet") {
  console.log(
    `   -> Using default Devnet RPC URL. Set DEVNET_RPC_URL in .env to override.`
  );
}
if (mainnetRpcUrl === defaultMainnetRpcUrl && currentEnv === "mainnet") {
  console.log(
    `   -> Using default Mainnet RPC URL. Set MAINNET_RPC_URL in .env to override.`
  );
}

// Configuration settings specific to each environment
interface EnvironmentConfig {
  driftEnv: DriftEnv;
  rpcUrl: string;
  wsUrl?: string; // Optional WebSocket URL
  solanaCommitment: Commitment; // Transaction confirmation level
}

// Use the loaded URLs (or defaults) in the configs object
const configs: Record<Environment, EnvironmentConfig> = {
  devnet: {
    driftEnv: "devnet",
    rpcUrl: devnetRpcUrl,
    wsUrl: devnetWsUrl, // Use the potentially undefined value
    solanaCommitment: "confirmed", // Reasonably fast confirmation
  },
  mainnet: {
    driftEnv: "mainnet-beta", // Note: Drift uses 'mainnet-beta'
    rpcUrl: mainnetRpcUrl,
    wsUrl: mainnetWsUrl, // Use the potentially undefined value
    solanaCommitment: "confirmed", // Use 'processed' for faster but less final confirmation, 'confirmed' is safer
  },
};

// Export the configuration for the current environment
export const activeConfig: EnvironmentConfig = configs[currentEnv];

// Export a helper function to get a Solana Connection object
export function getSolanaConnection(): Connection {
  console.log(`   Establishing connection to: ${activeConfig.rpcUrl}`);
  return new Connection(activeConfig.rpcUrl, {
    commitment: activeConfig.solanaCommitment,
    wsEndpoint: activeConfig.wsUrl, // Pass WebSocket URL if defined and needed
  });
}

// Example usage (can be removed later)
try {
  const wallet = loadKeypair();
  console.log(`   Bot Wallet Public Key: ${wallet.publicKey.toBase58()}`);
  console.log(`   Using Drift Environment: ${activeConfig.driftEnv}`);
  console.log(`   Using RPC Endpoint: ${activeConfig.rpcUrl}`);
  if (activeConfig.wsUrl) {
    console.log(`   Using WS Endpoint: ${activeConfig.wsUrl}`);
  } else {
    console.log(`   WS Endpoint: Not specified in .env`);
  }
} catch (e) {
  console.error("Initial config loading failed:", e);
}
