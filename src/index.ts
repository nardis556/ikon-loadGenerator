import { fetchAccounts } from "./accountsParser";
import { fetchMarkets, initializeAccounts, initializeCancels } from "./init";
import { clientBuilder } from "./utils/clientBuilder";
import * as idex from "@idexio/idex-sdk";
import EventEmitter from "events";
import { initClient } from "./init";
import { IClient } from "./utils/IAaccounts";
import logger from "./utils/logger";
import { retry } from "./utils/retry";
import dotenv from "dotenv";
import { ExtendedIDEXMarket } from "../src/init";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { generateOrderTemplate } from "./utils/generators";

// import { db } from "./utils/mysqlConnector";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.ORDERS") });

const main = async () => {
  logger.info("Starting main function");
  let initSide: idex.OrderSide = process.env.SIDE as idex.OrderSide;
  const accounts = fetchAccounts();
  const clients: { [key: string]: IClient } = {};
  const clientInit = await initClient();

  for (const [accountKey, accountInfo] of Object.entries(accounts)) {
    try {
      const client = await clientBuilder(
        accountInfo.apiKey,
        accountInfo.apiSecret,
        accountInfo.privateKey
      );
      clients[accountKey] = client;
    } catch (e) {
      logger.error(
        `Error creating client for account ${accountKey}: ${e.message}`
      );
      continue;
    }
  }

  if (process.env.INITIALIZE_ACCOUNTS === "true") {
    await initializeAccounts(accounts, clients);
  }

  if (process.env.INITIALIZE_CANCELS === "true") {
    await initializeCancels(accounts, clients);
  }

  if (process.env.EXECUTE_ORDERS === "true") {
    await execLoop(clients);
  }
};

async function fetchData(client: IClient, marketID: string): Promise<any> {
  return await Promise.all([
    // retry(() =>
    //   client.RestAuthenticatedClient.getPositions({
    //     market: marketID,
    //     ...client.getWalletAndNonce,
    //   })
    // ),
    retry(() =>
      client.RestAuthenticatedClient.getOrders({
        ...client.getWalletAndNonce,
        limit: Number(process.env.OPEN_ORDERS),
      })
    ),
    retry(() =>
      client.RestPublicClient.getOrderBookLevel2({
        market: marketID,
        limit: 1000,
      })
    ),
  ]);
}

function adjustValueToResolution(value, resolution) {
  let decimalsToKeep = 0;

  // Determine the number of decimals to keep based on the resolution
  switch (resolution) {
    case "0.00000001":
      decimalsToKeep = 8;
      break;
    case "0.00000010":
      decimalsToKeep = 7;
      break;
    case "0.00000100":
      decimalsToKeep = 6;
      break;
    case "0.00001000":
      decimalsToKeep = 5;
      break;
    case "0.00010000":
      decimalsToKeep = 4;
      break;
    case "0.00100000":
      decimalsToKeep = 3;
      break;
    case "0.01000000":
      decimalsToKeep = 2;
      break;
    case "0.10000000":
      decimalsToKeep = 1;
      break;
    case "1.00000000":
      decimalsToKeep = 0;
      break;
    case "10.00000000":
      decimalsToKeep = -1;
      break;
    default:
      throw new Error("Unsupported resolution format");
  }

  const factor = Math.pow(10, decimalsToKeep);
  const adjustedValue = Math.floor(value * factor) / factor;

  const val = adjustedValue.toFixed(Math.max(decimalsToKeep, 0));
  return Number(val).toFixed(8);
}

async function execLoop(clients: { [key: string]: IClient }) {
  let markets = await fetchMarkets();

  const numberOfLevels = 9;
  const stepPercentage = 0.00111;
  let previousMarket: string = null;

  while (true) {
    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        for (const market of markets) {
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          try {
            let [getOrders, orderBook] = await fetchData(client, marketID);
            const indexPrice = parseFloat(orderBook.indexPrice);
            const priceResolution = market.priceRes;
            const quantityResolution = market.quantityRes;
            let totalOrders = getOrders.length;

            previousMarket = marketID;

            for (let level = 0; level < numberOfLevels; level++) {
              const priceIncrement = indexPrice * stepPercentage * (level + 1);

              const buyPrice = adjustValueToResolution(
                indexPrice - priceIncrement,
                priceResolution
              );
              const sellPrice = adjustValueToResolution(
                indexPrice + priceIncrement,
                priceResolution
              );

              const buyParams = {
                market: marketID,
                type: "limit",
                side: "buy",
                price: buyPrice,
                quantity: adjustValueToResolution(
                  parseFloat(market.makerOrderMinimum) * 25,
                  quantityResolution
                ),
              };

              if (totalOrders < Number(process.env.OPEN_ORDERS)) {
                CreateOrder(client, { ...buyParams }, accountKey, marketID);
                totalOrders++;
              } else {
                client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                });
              }

              const sellParams = {
                market: marketID,
                type: "limit",
                side: "sell",
                price: sellPrice,
                quantity: adjustValueToResolution(
                  parseFloat(market.makerOrderMinimum) * 25,
                  quantityResolution
                ),
              };

              if (totalOrders < Number(process.env.OPEN_ORDERS)) {
                CreateOrder(client, { ...sellParams }, accountKey, marketID);
                totalOrders++;
              } else {
                client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                });
              }

              await sleep(500);
            }
            logger.info(
              `Processed loop for ${accountKey} on market ${marketID}`
            );
            setTimeout(async () => {
              logger.info(
                `Timeout finish, cancelling orders for market ${marketID}`
              );
              try {
                await client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                  market: marketID,
                });
                logger.info(
                  `Cancelled orders for ${accountKey} on market ${marketID}`
                );
              } catch (e) {
                logger.error(
                  `Error cancelling orders for ${accountKey} on market ${marketID}: ${e.message}`
                );
              }
            }, 60000);
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
            await sleep(5000);
          }
          await sleep(5000);
        }
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      await sleep(5000);
      continue;
    }
  }
}

main().catch((error) => {
  logger.error("Error during main function:", error);
});

async function CancelOrder(
  client: IClient,
  totalOrdersCount: number,
  accountKey: string,
  cancelledOrders: boolean,
  marketID: string
) {
  client.RestAuthenticatedClient.cancelOrders({
    ...client.getWalletAndNonce,
    // market: previousMarket,
  })
    .then((res) => {
      totalOrdersCount -= res.length;
      logger.info(
        `Cancelled ${res.length} orders for ${accountKey} due to limit exceedance.`
      );
      cancelledOrders = true;
    })
    .catch(async (e) => {
      logger.error(
        `Error cancelling orders for ${accountKey} on market ${marketID}: ${JSON.stringify(
          e.response ? e.response?.data || e.response : e,
          null,
          2
        )}`
      );
      await sleep(1000);
    });
  return { totalOrdersCount, cancelledOrders };
}

async function CreateOrder(
  client: IClient,
  orderParam: any,
  accountKey: string,
  marketID: string
) {
  client.RestAuthenticatedClient.createOrder({
    ...orderParam,
    ...client.getWalletAndNonce,
  }).catch(async (e) => {
    logger.error(
      `Error creating order for ${accountKey} on market ${marketID}: ${JSON.stringify(
        e.response ? e.response?.data || e.response : e,
        null,
        2
      )}`
    );
    if (e.response?.data && e.response?.data.code === "TRADING_DISABLED") {
      logger.error(`Trading disabled terminating process.`);
      process.exit();
    }
    await sleep(1000);
  });
}
