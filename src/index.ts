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
    retry(() =>
      client.RestAuthenticatedClient.getPositions({
        market: marketID,
        ...client.getWalletAndNonce,
      })
    ),
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

const reviveBotAfter = Number(process.env.REVIVE_BOT_AFTER) || 180000;

async function checkAndPauseIfTradingDisabled() {
  if (!isTradingEnabled) {
    logger.error(`Trading disabled. Pausing trading operations.`);
    await sleep(reviveBotAfter * 1000);
    isTradingEnabled = true;
  }
}
// async function execLoop(clients: { [key: string]: IClient }) {
async function execLoop(clients: { [key: string]: IClient }) {
  let markets = await fetchMarkets();

  const numberOfLevels = 10;
  const orderStepSize = Number(process.env.ORDER_STEP_SIZE) || 0.000333;
  const undesiredPositionStepPercentage =
    Number(process.env.UNDESIRED_STEP_SIZE) || 0.000666;

  while (true) {
    await checkAndPauseIfTradingDisabled();
    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        await checkAndPauseIfTradingDisabled();
        for (const market of markets) {
          await checkAndPauseIfTradingDisabled();
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          try {
            let [openPositions, getOrders, orderBook] = await fetchData(
              client,
              marketID
            );
            const indexPrice = parseFloat(orderBook.indexPrice);
            const priceResolution = market.priceRes;
            const quantityResolution = market.quantityRes;
            let totalOrders = getOrders.length;

            let posQuantity = parseFloat(openPositions[0]?.quantity || "0");
            logger.debug(`Position Quantity for ${marketID}: ${posQuantity}`);

            let lastBuyPrice = indexPrice;
            let lastSellPrice = indexPrice;

            for (let level = 0; level < numberOfLevels; level++) {
              let buyPrice: any, sellPrice: any;

              if (level === 0) {
                buyPrice = adjustValueToResolution(
                  indexPrice -
                    (posQuantity > 0
                      ? indexPrice * undesiredPositionStepPercentage
                      : indexPrice * orderStepSize),
                  priceResolution
                );
                sellPrice = adjustValueToResolution(
                  indexPrice +
                    (posQuantity < 0
                      ? indexPrice * undesiredPositionStepPercentage
                      : indexPrice * orderStepSize),
                  priceResolution
                );
                lastBuyPrice = buyPrice;
                lastSellPrice = sellPrice;
              } else {
                const adjustedBuyDifference = parseFloat(
                  (indexPrice * orderStepSize).toFixed(
                    priceResolution.length - 2
                  )
                );
                const adjustedSellDifference = parseFloat(
                  (indexPrice * orderStepSize).toFixed(
                    priceResolution.length - 2
                  )
                );

                buyPrice = adjustValueToResolution(
                  parseFloat(lastBuyPrice.toString()) - adjustedBuyDifference,
                  priceResolution
                );
                sellPrice = adjustValueToResolution(
                  parseFloat(lastSellPrice.toString()) + adjustedSellDifference,
                  priceResolution
                );

                if (buyPrice === lastBuyPrice && adjustedBuyDifference !== 0) {
                  buyPrice = parseFloat(
                    (
                      lastBuyPrice -
                      Math.sign(adjustedBuyDifference) *
                        Math.pow(10, -priceResolution.length + 2)
                    ).toFixed(priceResolution.length - 2)
                  );
                }
                if (
                  sellPrice === lastSellPrice &&
                  adjustedSellDifference !== 0
                ) {
                  sellPrice = parseFloat(
                    (
                      lastSellPrice +
                      Math.sign(adjustedSellDifference) *
                        Math.pow(10, -priceResolution.length + 2)
                    ).toFixed(priceResolution.length - 2)
                  );
                }

                lastBuyPrice = buyPrice;
                lastSellPrice = sellPrice;
              }

              const { buyParams, sellParams } = createOrderParams(
                marketID,
                buyPrice,
                market,
                quantityResolution,
                sellPrice
              );

              logger.debug(`Buy: ${buyPrice}, Sell: ${sellPrice}`);
              logger.debug(`INDEX PRICE: ${indexPrice}`);
              logger.debug(`Buy: ${buyPrice} | Sell: ${sellPrice}`);
              logger.debug(
                `Quantity: ${buyParams.quantity} | ${sellParams.quantity}`
              );
              logger.debug(
                `Buy price diff from indexPrice: ${
                  indexPrice - buyParams.price
                }`
              );
              logger.debug(
                `Sell price diff from indexPrice: ${
                  sellParams.price - indexPrice
                }`
              );

              if (totalOrders < Number(process.env.OPEN_ORDERS)) {
                await CreateOrder(client, buyParams, accountKey, marketID);
                await CreateOrder(client, sellParams, accountKey, marketID);
                totalOrders += 2;
              } else {
                await retry(() => {
                  return client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                    market: marketID,
                  });
                });
                break;
              }

              process.env.COOLDOWN === "true" &&
                (await sleep(Number(process.env.COOLDOWN_PER_ORDER) * 1000));
            }
            logger.info(
              `Processed loop for ${accountKey} on market ${marketID}`
            );
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
        cancelUntil(accountKey, client);
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

function createOrderParams(
  marketID: string,
  buyPrice: any,
  market: ExtendedIDEXMarket,
  quantityResolution: string,
  sellPrice: any
) {
  const buyParams = {
    market: marketID,
    type: "limit",
    side: "buy",
    price: buyPrice,
    quantity: adjustValueToResolution(
      parseFloat(market.makerOrderMinimum) *
        (1 + Math.random() * Number(process.env.QUANTITY_ALPHA_FACTOR) * 10),
      quantityResolution
    ),
    // selfTradePrevention: idex.SelfTradePrevention.cb,
    // timeInForce: idex.TimeInForce.gtx,
  };

  const sellParams = {
    market: marketID,
    type: "limit",
    side: "sell",
    price: sellPrice,
    quantity: adjustValueToResolution(
      parseFloat(market.makerOrderMinimum) *
        (1 + Math.random() * Number(process.env.QUANTITY_ALPHA_FACTOR) * 10),
      quantityResolution
    ),
  };
  return { buyParams, sellParams };
}

function cancelUntil(accountKey: string, client: IClient) {
  const cancelTimeout = (Number(process.env.CANCEL_TIMEOUT) * 1000) | 180000;

  logger.info(
    `Cancelling orders for ${accountKey} in ${cancelTimeout / 1000}s.`
  );

  setTimeout(async () => {
    try {
      retry(() => {
        return client.RestAuthenticatedClient.cancelOrders({
          ...client.getWalletAndNonce,
        });
      });
      logger.info(`Cancelled orders for ${accountKey}.`);
    } catch (e) {
      logger.error(`Error cancelling orders for ${accountKey}`);
      e.reponse && logger.error(e.response.data ? e.response.data : e.response);
    }
  }, cancelTimeout);
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
      isTradingEnabled = false;
    } else if (
      e.response?.data &&
      e.response?.data.code === "MAXIMUM_POSITION_SIZE_EXCEEDED"
    ) {
      logger.error(`Maximum position size exceeded.`);
    }
    await sleep(1000);
  });
}
