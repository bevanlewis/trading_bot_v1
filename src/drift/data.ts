import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  convertToNumber,
  PRICE_PRECISION,
  QUOTE_PRECISION,
  OraclePriceData,
  PerpMarketAccount,
  User,
  PerpPosition,
  BASE_PRECISION,
  Order,
  isVariant,
} from "@drift-labs/sdk";
import { Buffer } from "buffer";

// --- Helper Function to Convert Bytes to String ---
export function bytesToString(bytes: number[]): string {
  // Filter out null bytes (0x00) which are often used for padding
  const filteredBytes = bytes.filter((b) => b !== 0);
  // Convert the byte array to a UTF-8 string
  return Buffer.from(filteredBytes).toString("utf8").trim();
}

/**
 * Fetches the oracle price data for a given perp market index.
 *
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @param marketIndex The index of the perp market.
 * @returns The formatted oracle price data or null if not available.
 */
export function getOraclePriceData(
  driftClient: DriftClient,
  marketIndex: number
): {
  price: number;
  slot: number;
  confidence: number;
} | null {
  console.log(`   Fetching oracle price for market index: ${marketIndex}`);

  if (!driftClient.isSubscribed) {
    console.error("❌ DriftClient is not subscribed. Cannot fetch price data.");
    return null;
  }

  // Use the documented method to get oracle data directly
  const oraclePriceData: OraclePriceData | undefined =
    driftClient.getOracleDataForPerpMarket(marketIndex);

  if (!oraclePriceData) {
    // Updated error message: removed attempt to access .oracle
    console.error(
      `❌ Oracle price data not available for market index ${marketIndex}. DriftClient state might be missing the required oracle data.`
    );
    return null;
  }

  // Extract data from the OraclePriceData object
  const price = oraclePriceData.price;
  const confidence = oraclePriceData.confidence;
  const slot = oraclePriceData.slot.toNumber(); // Slot comes from the OraclePriceData itself

  const priceNumber = convertToNumber(price, PRICE_PRECISION);
  const confidenceNumber = convertToNumber(confidence, PRICE_PRECISION);

  console.log(`   ✅ Oracle price: ${priceNumber}`);

  return {
    price: priceNumber,
    slot: slot,
    confidence: confidenceNumber,
  };
}

// --- Function to Get Market Name ---
/**
 * Fetches the name of a perp market given its index.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @param marketIndex The index of the perp market.
 * @returns The market name (e.g., "SOL-PERP") or null if not found.
 */
export function getMarketName(
  driftClient: DriftClient,
  marketIndex: number
): string | null {
  if (!driftClient.isSubscribed) {
    console.error(
      "❌ DriftClient is not subscribed. Cannot fetch market name."
    );
    return null;
  }

  const perpMarketAccount = driftClient.getPerpMarketAccount(marketIndex);
  if (!perpMarketAccount) {
    console.error(`❌ Perp market account not found for index ${marketIndex}.`);
    return null;
  }

  // Access the 'name' property (byte array) and convert it
  const marketName = bytesToString(perpMarketAccount.name);
  console.log(`   ✅ Market Name for index ${marketIndex}: ${marketName}`);
  return marketName;
}

// --- Function to Get Account State ---
/**
 * Fetches key account state metrics like collateral and leverage.
 * NOTE: Margin requirement calculation removed due to type issues.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @returns An object with account state values or null if user not found.
 */
export function getAccountState(driftClient: DriftClient): {
  totalCollateral: number;
  freeCollateral: number;
  leverage: number;
} | null {
  console.log("   Fetching account state...");

  if (!driftClient.isSubscribed) {
    console.error(
      "❌ DriftClient is not subscribed. Cannot fetch account state."
    );
    return null;
  }

  const user = driftClient.getUser();

  if (!user.isSubscribed) {
    console.error(
      "❌ User object is not subscribed. Account data might be missing."
    );
  }

  try {
    const totalCollateral = user.getTotalCollateral();
    const freeCollateral = user.getFreeCollateral();
    const leverage = user.getLeverage();

    // Convert BN values to numbers
    const accountState = {
      totalCollateral: convertToNumber(totalCollateral, QUOTE_PRECISION),
      freeCollateral: convertToNumber(freeCollateral, QUOTE_PRECISION),
      leverage: convertToNumber(leverage, QUOTE_PRECISION),
    };

    console.log(`   ✅ Account state fetched (excluding margin req).`);
    return accountState;
  } catch (error) {
    console.error("❌ Error fetching account state details:", error);
    if (
      error instanceof Error &&
      error.message.includes("UserAccount not found")
    ) {
      console.log("   Hint: User account might not exist on Drift yet.");
    }
    return null;
  }
}

// --- Function to Get Open Perp Positions ---
/**
 * Fetches the user's current open perpetual positions.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @returns An array of formatted position objects or null on error.
 */
export function getOpenPositions(driftClient: DriftClient): Array<{
  marketIndex: number;
  marketName: string;
  baseAssetAmount: number;
  quoteAssetAmount: number;
  entryPrice: number;
  pnl: number;
  fundingRate: number;
}> | null {
  console.log("   Fetching open positions...");

  if (!driftClient.isSubscribed) {
    console.error("❌ DriftClient is not subscribed. Cannot fetch positions.");
    return null;
  }

  const user = driftClient.getUser();

  if (!user.isSubscribed) {
    console.error(
      "❌ User object is not subscribed. Position data might be missing."
    );
  }

  try {
    const positions = user.getActivePerpPositions();

    if (positions.length === 0) {
      console.log("   ✅ No open perp positions found.");
      return [];
    }

    const formattedPositions = positions.map((position) => {
      const marketIndex = position.marketIndex;
      const marketName =
        getMarketName(driftClient, marketIndex) || `Market ${marketIndex}`;
      // Use getUnrealizedPnl for more accurate PnL including funding
      const pnl = user.getUnrealizedPNL(false, marketIndex);
      const market = driftClient.getPerpMarketAccount(marketIndex);
      // Funding rate calculation might need refinement or helper
      const fundingRate = market
        ? convertToNumber(market.amm.lastFundingRate, QUOTE_PRECISION) *
          100 *
          24
        : 0; // Example: daily rate %

      return {
        marketIndex: marketIndex,
        marketName: marketName,
        baseAssetAmount: convertToNumber(
          position.baseAssetAmount,
          BASE_PRECISION
        ),
        quoteAssetAmount: convertToNumber(
          position.quoteAssetAmount,
          QUOTE_PRECISION
        ),
        entryPrice: convertToNumber(
          position.quoteEntryAmount.div(position.baseAssetAmount.abs()),
          PRICE_PRECISION
        ), // Calculate entry price
        pnl: convertToNumber(pnl, QUOTE_PRECISION),
        fundingRate: fundingRate, // This is simplified
      };
    });

    console.log(`   ✅ Found ${formattedPositions.length} open position(s).`);
    return formattedPositions;
  } catch (error) {
    console.error("❌ Error fetching open positions:", error);
    return null;
  }
}

// --- Function to Get Open Orders ---
/**
 * Fetches the user's current open orders.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @returns An array of formatted order objects or null on error.
 */
export function getOpenOrders(driftClient: DriftClient): Array<{
  orderId: number;
  status: string;
  orderType: string;
  marketType: string;
  marketIndex: number;
  marketName: string;
  direction: string;
  baseAssetAmount: number;
  price: number;
  reduceOnly: boolean;
  postOnly: boolean;
}> | null {
  console.log("   Fetching open orders...");

  if (!driftClient.isSubscribed) {
    console.error("❌ DriftClient is not subscribed. Cannot fetch orders.");
    return null;
  }

  const user = driftClient.getUser();

  if (!user.isSubscribed) {
    console.error(
      "❌ User object is not subscribed. Order data might be missing."
    );
  }

  try {
    const orders = user.getOpenOrders();

    if (orders.length === 0) {
      console.log("   ✅ No open orders found.");
      return [];
    }

    const formattedOrders = orders.map((order) => {
      const marketIndex = order.marketIndex;
      const marketType = isVariant(order.marketType, "perp") ? "PERP" : "SPOT";
      const marketName =
        getMarketName(driftClient, marketIndex) || `Market ${marketIndex}`;
      const direction = isVariant(order.direction, "long") ? "Long" : "Short";
      const orderType = Object.keys(order.orderType)[0]; // Get the name of the order type variant
      const status = Object.keys(order.status)[0]; // Get the name of the status variant

      return {
        orderId: order.orderId,
        status: status,
        orderType: orderType,
        marketType: marketType,
        marketIndex: marketIndex,
        marketName: marketName,
        direction: direction,
        baseAssetAmount: convertToNumber(order.baseAssetAmount, BASE_PRECISION),
        price: convertToNumber(order.price, PRICE_PRECISION),
        reduceOnly: order.reduceOnly,
        postOnly: order.postOnly,
      };
    });

    console.log(`   ✅ Found ${formattedOrders.length} open order(s).`);
    return formattedOrders;
  } catch (error) {
    console.error("❌ Error fetching open orders:", error);
    return null;
  }
}

// --- Refactored: Function to Fetch Single Market Info (Accepts DriftClient) ---
/**
 * Fetches and displays name and oracle price for a specific market index
 * using a pre-initialized DriftClient.
 * @param driftClient An initialized and subscribed DriftClient instance.
 * @param targetMarketIndex The index of the perp market to fetch.
 */
export async function fetchSingleMarketInfo(
  driftClient: DriftClient,
  targetMarketIndex: number
) {
  console.log(
    `\n--- Fetching Single Market Info (Market ${targetMarketIndex}) ---`
  );
  try {
    if (!driftClient.isSubscribed) {
      console.error(
        "\n❌ DriftClient is not subscribed. Cannot fetch market info."
      );
      return;
    }

    // Fetch and Display Market Name & Price (pass driftClient to helpers)
    console.log(
      `Attempting to fetch name for market index ${targetMarketIndex}...`
    );
    const marketName = getMarketName(driftClient, targetMarketIndex);
    const marketDisplayName = marketName
      ? marketName
      : `Market ${targetMarketIndex}`;
    console.log(`Attempting to fetch price for ${marketDisplayName}...`);
    const priceData = getOraclePriceData(driftClient, targetMarketIndex);

    if (marketName && priceData) {
      console.log(`\n--- Data for ${marketDisplayName} ---`);
      console.log(`   Market Index: ${targetMarketIndex}`);
      console.log(`   Oracle Price: ${priceData.price.toFixed(4)}`);
      console.log(
        `   Confidence Interval: ±${priceData.confidence.toFixed(4)}`
      );
      console.log(`   Slot: ${priceData.slot}`);
      console.log("----------------------------- ");
    } else {
      console.log(
        `\nCould not fetch complete market data for Market Index ${targetMarketIndex}.`
      );
    }
  } catch (error) {
    console.error("\n❌ Error fetching single market info:", error);
  } finally {
    console.log("---------------------------------------");
  }
}

// --- Refactored: Function to Fetch Account State, Positions, and Orders (Accepts DriftClient) ---
/**
 * Fetches and displays account state, open positions, and open orders
 * using a pre-initialized DriftClient.
 * @param driftClient An initialized and subscribed DriftClient instance.
 */
export async function fetchAccountAndPositions(driftClient: DriftClient) {
  console.log("\n--- Fetching Account State, Positions & Orders ---");
  try {
    if (!driftClient.isSubscribed) {
      console.error("\n❌ DriftClient is not subscribed. Cannot fetch data.");
      return;
    }

    // Fetch and Display Account State (pass driftClient)
    console.log(`\nAttempting to fetch account state...`);
    const accountState = getAccountState(driftClient);

    if (accountState) {
      console.log("\n--- Account State --- ");
      console.log(
        `   Total Collateral: $${accountState.totalCollateral.toFixed(4)}`
      );
      console.log(
        `   Free Collateral: $${accountState.freeCollateral.toFixed(4)}`
      );
      console.log(`   Leverage: ${accountState.leverage.toFixed(4)}x`);
      console.log("---------------------");
    } else {
      console.log("   Could not fetch account state.");
    }

    // Fetch and Display Open Positions (pass driftClient)
    console.log(`\nAttempting to fetch open positions...`);
    const openPositions = getOpenPositions(driftClient);

    if (openPositions && openPositions.length > 0) {
      console.log("\n--- Open Positions --- ");
      openPositions.forEach((pos) => {
        console.log(`  Market: ${pos.marketName} (${pos.marketIndex})`);
        console.log(`    Size: ${pos.baseAssetAmount.toFixed(4)} Base`);
        console.log(`    Entry Price: $${pos.entryPrice.toFixed(4)}`);
        console.log(`    Unrealized PnL: $${pos.pnl.toFixed(4)}`);
        // console.log(`    Funding Rate (approx daily %): ${pos.fundingRate.toFixed(6)}%`);
        console.log("    ---");
      });
      console.log("----------------------");
    } else if (openPositions) {
      console.log("   No open positions.");
    } else {
      console.log("   Could not fetch open positions.");
    }

    // Fetch and Display Open Orders (pass driftClient)
    console.log(`\nAttempting to fetch open orders...`);
    const openOrders = getOpenOrders(driftClient);

    if (openOrders && openOrders.length > 0) {
      console.log("\n--- Open Orders --- ");
      openOrders.forEach((order) => {
        console.log(`  Order ID: ${order.orderId} (${order.status})`);
        console.log(
          `    Market: ${order.marketName} (${order.marketType} ${order.marketIndex})`
        );
        console.log(`    Type: ${order.orderType}`);
        console.log(`    Side: ${order.direction}`);
        console.log(`    Size: ${order.baseAssetAmount.toFixed(4)}`);
        console.log(`    Price: $${order.price.toFixed(4)}`);
        console.log(
          `    ReduceOnly: ${order.reduceOnly}, PostOnly: ${order.postOnly}`
        );
        console.log("    ---");
      });
      console.log("-------------------");
    } else if (openOrders) {
      console.log("   No open orders.");
    } else {
      console.log("   Could not fetch open orders.");
    }
  } catch (error) {
    console.error("\n❌ Error fetching account/position data:", error);
  } finally {
    console.log("--------------------------------------------------");
  }
}
