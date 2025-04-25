//* This files is used to check the connection to the Solana blockchain and fetch
//* SOL and USDC balances of the wallet.

// src/solana/connect.ts
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
// Import function to get the address of the associated token account
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getSolanaConnection, loadKeypair, activeConfig } from "../config";

// Define known USDC mint addresses
const USDC_MINT_ADDRESS_DEVNET = new PublicKey(
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
);
const USDC_MINT_ADDRESS_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const USDC_DECIMALS = 6; // USDC typically has 6 decimal places

async function checkBalances() {
  console.log(`Attempting to connect to Solana (${activeConfig.driftEnv})...`);
  console.log(`   RPC Endpoint: ${activeConfig.rpcUrl}`);

  try {
    // Load the bot's keypair
    const wallet = loadKeypair();
    const walletAddress = wallet.publicKey;
    console.log(`   Wallet Public Key: ${walletAddress.toBase58()}`);

    // Establish the Solana connection
    const connection = getSolanaConnection();
    console.log("   Connection object created.");

    // --- Check SOL Balance ---
    console.log("\n   Fetching SOL balance...");
    const balanceLamports = await connection.getBalance(walletAddress);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    console.log(
      `   ✅ SOL Balance: ${balanceSol.toFixed(
        9
      )} SOL (${balanceLamports} Lamports)`
    );

    // Provide SOL airdrop hint if needed
    if (balanceLamports === 0 && activeConfig.driftEnv === "devnet") {
      console.log("\n   Hint: SOL balance is zero. Try airdropping again:");
      console.log(
        `   solana airdrop 1 ${walletAddress.toBase58()} --url ${
          activeConfig.rpcUrl
        }`
      );
    }

    // --- Check USDC Balance (Works for Devnet or Mainnet) ---
    console.log("\n   Fetching USDC balance...");
    try {
      // Select the correct USDC mint address based on the environment
      const usdcMintAddress =
        activeConfig.driftEnv === "mainnet-beta"
          ? USDC_MINT_ADDRESS_MAINNET
          : USDC_MINT_ADDRESS_DEVNET;
      console.log(
        `   Using USDC Mint: ${usdcMintAddress.toBase58()} (${
          activeConfig.driftEnv
        })`
      );

      // Find the Associated Token Account (ATA) for this wallet and the selected USDC mint
      const usdcAtaAddress = getAssociatedTokenAddressSync(
        usdcMintAddress, // Use the selected mint address
        walletAddress
      );
      console.log(`   Derived USDC ATA: ${usdcAtaAddress.toBase58()}`);

      // Get the balance of the ATA
      const usdcAtaInfo = await connection.getTokenAccountBalance(
        usdcAtaAddress,
        "confirmed"
      );

      if (usdcAtaInfo.value.uiAmount !== null) {
        console.log(
          `   ✅ USDC Balance: ${usdcAtaInfo.value.uiAmount.toFixed(
            USDC_DECIMALS
          )} USDC`
        );
      } else {
        console.log(`   ✅ USDC Balance: 0.000000 USDC`);
      }
    } catch (error) {
      // If getTokenAccountBalance throws an error, it usually means the ATA doesn't exist yet
      console.log(
        `   🟡 USDC ATA not found or error fetching balance. Assuming 0 USDC.`
      );
      console.log(
        `      (Error: ${
          error instanceof Error ? error.message : String(error)
        })`
      );
      // Add hint specific to the environment
      if (activeConfig.driftEnv === "devnet") {
        console.log(`   Hint: You may need to use a Devnet faucet first.`);
      } else {
        console.log(
          `   Hint: You may need to receive USDC first for the account to be created.`
        );
      }
    }

    console.log("\n✅ Balance checks complete!");
  } catch (error) {
    console.error("\n❌ Error during connection or balance checks:");
    if (error instanceof Error) {
      console.error(`   Message: ${error.message}`);
    } else {
      console.error("   An unknown error occurred:", error);
    }
    process.exit(1); // Exit with error code
  }
}

// Execute the async function
checkBalances();
