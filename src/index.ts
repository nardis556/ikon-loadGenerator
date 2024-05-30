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
import { position } from "@chakra-ui/react";
import { createLogger } from "winston";

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

interface BatchCall {}

async function fetchData(client: IClient, marketID: string): Promise<any> {
  return await Promise.all([
    // retry(() =>
    //   client.RestAuthenticatedClient.getPositions({
    //     market: marketID,
    //     ...client.getWalletAndNonce,
    //   })
    // ),
    // retry(() =>
    //   client.RestAuthenticatedClient.getOrders({
    //     ...client.getWalletAndNonce,
    //     limit: Number(process.env.OPEN_ORDERS),
    //   })
    // ),
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
// async function execLoop(clients: { [key: string]: IClient }) {
async function execLoop(clients: { [key: string]: IClient }) {
  let markets = await fetchMarkets();

  const percentageVariation = 0.0000123;

  while (true) {
    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        for (const market of markets) {
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          try {
            // let openPositions: idex.RestResponseGetPositions;
            // let getOrders: idex.RestResponseGetOrders;
            let orderBook: idex.RestResponseGetOrderBookLevel2;
            [orderBook] = await fetchData(client, marketID);
            const indexPrice = Number(orderBook.indexPrice);
            const midPrice =
              (Number(orderBook.bids[0][0]) + Number(orderBook.asks[0][0])) / 2;
            const priceDifference = indexPrice - midPrice;

            let isBids = priceDifference > 0;

            const {
              weightedPrice: weightedBuyPrice,
              accumulatedQuantity: totalBuyQuantity,
            } = calculateLimitWeight(orderBook.bids, indexPrice, isBids);

            const {
              weightedPrice: weightedSellPrice,
              accumulatedQuantity: totalSellQuantity,
            } = calculateLimitWeight(orderBook.asks, indexPrice, !isBids);

            logger.info(
              `Weighted Buy Price up to index: ${weightedBuyPrice}, Total Buy Quantity: ${totalBuyQuantity}`
            );
            logger.info(
              `Weighted Sell Price up to index: ${weightedSellPrice}, Total Sell Quantity: ${totalSellQuantity}`
            );

            const sellParams = createOrderParams(
              marketID,
              indexPrice,
              market,
              market.quantityRes,
              indexPrice,
              totalBuyQuantity,
              totalSellQuantity
            );

            const buyParams = createOrderParams(
              marketID,
              indexPrice,
              market,
              market.quantityRes,
              indexPrice,
              totalBuyQuantity,
              totalSellQuantity
            );

            if (isBids && Number(sellParams.sellParams.price) !== 0) {
              CreateOrder(
                client,
                sellParams.sellParams,
                accountKey,
                marketID
              ).then(async () => {
                await sleep(5000);
                retry(() =>
                  client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                  })
                );
              });
            } else if (!isBids && Number(buyParams.buyParams.price) !== 0) {
              CreateOrder(
                client,
                buyParams.buyParams,
                accountKey,
                marketID
              ).then(async () => {
                await sleep(5000);
                retry(() =>
                  client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                  })
                );
              });
            }

            await retry(() =>
              client.RestAuthenticatedClient.cancelOrders({
                ...client.getWalletAndNonce,
              })
            );
            await sleep(5000);
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
            await sleep(2000);
          }
          await sleep(2000);
        }
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      await sleep(5000);
      continue;
    }
  }
}

function calculateLimitWeight(orders, indexPrice, isBids) {
  let accumulatedWeight = 0;
  let accumulatedQuantity = 0;

  if (isBids) {
    for (let i = 0; i < orders.length; i++) {
      const [price, quantity] = orders[i];
      if (Number(price) >= indexPrice) {
        accumulatedWeight += Number(price) * Number(quantity);
        accumulatedQuantity += Number(quantity);
      } else {
        break;
      }
    }
  } else {
    for (let i = 0; i < orders.length; i++) {
      const [price, quantity] = orders[i];
      if (Number(price) <= indexPrice) {
        accumulatedWeight += Number(price) * Number(quantity);
        accumulatedQuantity += Number(quantity);
      } else {
        break;
      }
    }
  }

  const weightedPrice =
    accumulatedQuantity > 0 ? accumulatedWeight / accumulatedQuantity : 0;
  return { weightedPrice, accumulatedQuantity };
}

main().catch((error) => {
  logger.error("Error during main function:", error);
});

async function CreateOrder(
  client: IClient,
  orderParam: any,
  accountKey: string,
  marketID: string
) {
  logger.debug(JSON.stringify(orderParam, null, 2));
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
      logger.error(`Trading disabled.`);
      await sleep(120000);
    }
    await sleep(1000);
  });
}

function createOrderParams(
  marketID: string,
  buyPrice: any,
  market: ExtendedIDEXMarket,
  quantityResolution: string,
  sellPrice: any,
  buyQuantity: any,
  sellQuantity: any
) {
  const buyParams = {
    market: marketID,
    type: "limit",
    side: "sell",
    price: adjustValueToResolution(
      parseFloat((Number(buyPrice) * 0.99999).toString()),
      market.priceRes
    ),
    quantity:
      sellQuantity > Number(market.maximumPositionSize)
        ? market.maximumPositionSize
        : adjustValueToResolution(parseFloat(sellQuantity), quantityResolution),
  };

  const sellParams = {
    market: marketID,
    type: "limit",
    side: "buy",
    price: adjustValueToResolution(
      parseFloat((Number(sellPrice) * 1.00001).toString()),
      market.priceRes
    ),
    quantity:
    sellQuantity > Number(market.maximumPositionSize)
        ? market.maximumPositionSize
        : adjustValueToResolution(parseFloat(sellQuantity), quantityResolution),
  };
  return { buyParams, sellParams };
}
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
