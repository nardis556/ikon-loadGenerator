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
// import { generateOrderTemplate } from "./utils/generators";
// import { position } from "@chakra-ui/react";
// import { createLogger } from "winston";

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

// interface BatchCall {}

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

let isTradingEnabled = true;

async function checkAndPauseIfTradingDisabled() {
  if (!isTradingEnabled) {
    logger.error(`Trading disabled. Pausing trading operations.`);
    await sleep(180000);
    isTradingEnabled = true;
  }
}

// async function execLoop(clients: { [key: string]: IClient }) {
async function execLoop(clients: { [key: string]: IClient }) {
  let markets = await fetchMarkets();

  while (true) {
    await checkAndPauseIfTradingDisabled();

    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        await checkAndPauseIfTradingDisabled();

        for (const market of markets) {
          await checkAndPauseIfTradingDisabled();

          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          try {
            // let openPositions: idex.RestResponseGetPositions;
            // let getOrders: idex.RestResponseGetOrders;
            let orderBook: idex.RestResponseGetOrderBookLevel2;
            [orderBook] = await fetchData(client, marketID);
            const indexPrice = Number(orderBook.indexPrice);

            const {
              weightedPrice: weightedBuyPrice,
              accumulatedQuantity: totalBuyQuantity,
            } = calculateLimitWeight(orderBook.bids, indexPrice, true);

            const {
              weightedPrice: weightedSellPrice,
              accumulatedQuantity: totalSellQuantity,
            } = calculateLimitWeight(orderBook.asks, indexPrice, false);

            logger.info(
              `Weighted buyPrice : ${weightedBuyPrice.toFixed(
                8
              )} | Quantity: ${totalBuyQuantity.toFixed(8)}`
            );
            logger.info(
              `Weighted sellPrice: ${weightedSellPrice.toFixed(
                8
              )} | Quantity: ${totalSellQuantity.toFixed(8)}`
            );

            let orderParams: any = null;
            if (totalBuyQuantity > totalSellQuantity) {
              orderParams = createOrderParams(
                marketID,
                "sell",
                indexPrice,
                totalBuyQuantity,
                market
              );
            } else if (totalSellQuantity > totalBuyQuantity) {
              orderParams = createOrderParams(
                marketID,
                "buy",
                indexPrice,
                totalSellQuantity,
                market
              );
            }

            orderParams &&
              logger.debug(
                `Order Params: ${JSON.stringify(orderParams, null, 2)}`
              );

            if (orderParams !== null) {
              await CreateOrder(
                client,
                orderParams.params,
                accountKey,
                marketID
              );
              logger.info(
                `Created ${orderParams.params.side} order for ${accountKey} on market ${marketID}`
              );
              logger.info(
                `Market: ${marketID} | INDEX ${indexPrice} p${orderParams.params.price} q${orderParams.params.quantity}`
              );
            } else {
              logger.info(
                `No orders to create for ${accountKey} on market ${marketID}`
              );
            }

            await retry(() =>
              client.RestAuthenticatedClient.cancelOrders({
                ...client.getWalletAndNonce,
              })
            );
            process.env.COOLDOWN === "true" &&
              (await sleep(Number(process.env.COOLDOWN_PER_ORDER) * 1000));
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
            await sleep(2000);
          }
          process.env.COOLDOWN === "true" &&
            (await sleep(Number(process.env.COOLDOWN_PER_MARKET) * 1000));
        }
        process.env.COOLDOWN === "true" &&
          (await sleep(Number(process.env.COOLDOWN_PER_ACCOUNT) * 1000));
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      await sleep(5000);
      continue;
    }
  }
}

function calculateLimitWeight(orders: any, indexPrice: any, isBids: any) {
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
      logger.error(`Trading disabled. Pausing trading operations.`);
      isTradingEnabled = false;
    }
    await sleep(1000);
  });
}

function createOrderParams(
  marketId: string,
  side: idex.OrderSide,
  price: number,
  quantity: number,
  market: ExtendedIDEXMarket
) {
  side === "buy" ? (price = price * 1.000001) : (price = price * 0.999999);
  let setQuantity: string;
  switch (true) {
    case quantity > Number(market.maximumPositionSize):
      setQuantity = market.maximumPositionSize;
      break;
    case quantity < Number(market.makerOrderMinimum):
      setQuantity = market.makerOrderMinimum;
      break;
    default:
      setQuantity = adjustValueToResolution(quantity, market.quantityRes);
      break;
  }

  const params = {
    market: marketId,
    type: "limit",
    side: side,
    price: adjustValueToResolution(price.toString(), market.priceRes),
    quantity: setQuantity,
    timeInForce: idex.TimeInForce.ioc,
  };
  return { params };
}
