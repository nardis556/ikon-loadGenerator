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
import { setTimeout } from "timers/promises";
import { generateOrderTemplate } from "./utils/generators";
import { wsClient } from "./init";
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

  await execLoop(clients, initSide as idex.OrderSide);
};

async function wsHandler(
  marketsSubscription: string[],
  markets: ExtendedIDEXMarket[]
) {
  let disconnect = false;
  const ws = await wsClient();
  ws.connect(true);
  function subscribe() {
    ws.subscribePublic(
      // @ts-ignore
      [idex.SubscriptionName.l1orderbook],
      marketsSubscription
    );
    disconnect = false;
  }
  ws.onConnect(() => {
    subscribe();
  });
  ws.onMessage((message) => {
    if (message.type === idex.SubscriptionName.l1orderbook) {
      markets.forEach((market) => {
        if (
          `${market.baseAsset}-${market.quoteAsset}` === message.data.market
        ) {
          market.wsIndexPrice = message.data.indexPrice;
        }
      });
    }
  });

  ws.onError(async (error) => {
    logger.error(`onError in wsOb function: ${JSON.stringify(error, null, 2)}`);
    disconnect = true;
    while (disconnect) {
      subscribe();
      await setTimeout(1000);
    }
  });
  ws.onDisconnect(async (e) => {
    logger.debug(
      `onDisconnect in wsOb function: ${JSON.stringify(e, null, 2)}`
    );
    disconnect = true;
    while (disconnect) {
      subscribe();
      await setTimeout(1000);
    }
  });
}

async function execLoop(
  clients: { [key: string]: IClient },
  initSide: idex.OrderSide
) {
  let markets: ExtendedIDEXMarket[] = [];
  let side: idex.OrderSide = initSide;
  markets = await fetchMarkets();
  const marketsSubscription = markets.map(
    (m) => `${m.baseAsset}-${m.quoteAsset}`
  );

  await wsHandler(marketsSubscription, markets);

  while (true) {
    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        let updatedMarkets = markets;
        let cancelledOrders: boolean = false;
        for (const market of updatedMarkets) {
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          let totalOrdersCount: number;
          try {
            const [openPositions, openOrders, orderBook] = await Promise.all([
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

            totalOrdersCount = +openOrders.length;
            if (
              totalOrdersCount >= Number(process.env.OPEN_ORDERS) &&
              !cancelledOrders
            ) {
              retry(() =>
                client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                  market: marketID,
                })
              )
                .then((res) => {
                  totalOrdersCount -= res.length;
                  logger.info(
                    `Cancelled ${res.length} orders for ${accountKey} due to limit exceedance.`
                  );
                  cancelledOrders = true;
                })
                .catch(async (e) => {
                  logger.error(
                    `Error cancelling orders for ${accountKey} on market ${marketID}: ${
                      e.respose ? e.response?.data || e.response : e
                    }`
                  );
                  await setTimeout(1000);
                });
            }

            const calculateWeight = (orders: any) =>
              orders.reduce(
                (acc: any, [price, quantity]) =>
                  acc + Number(price) * Number(quantity),
                0
              );

            const bidsWeight = calculateWeight(orderBook.bids) * 0.95;
            const asksWeight = calculateWeight(orderBook.asks) * 1.05;

            if (bidsWeight > (bidsWeight + asksWeight) / 2) {
              side = idex.OrderSide.sell;
            } else {
              side = idex.OrderSide.buy;
            }

            let runMarket = true;

            if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) > 0 &&
              Math.abs(Number(openPositions[0].quantity)) >
                Number(market.maximumPositionSize) / 2
            ) {
              side = idex.OrderSide.sell;
              runMarket = false;
            } else if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) < 0 &&
              Math.abs(Number(openPositions[0].quantity)) <
                Number(market.maximumPositionSize) / 2
            ) {
              side = idex.OrderSide.buy;
              runMarket = false;
            }

            logger.info(
              `${
                side === "buy"
                  ? `placing BUY  orders at ${market.wsIndexPrice}`
                  : `placing SELL orders ${market.wsIndexPrice}`
              }`
            );

            const quantity =
              Number(market.makerOrderMinimum) *
              Number(process.env.QUANTITY_ALPHA_FACTOR) *
              (1 +
                Math.floor(
                  Math.random() * Number(process.env.QUANTITY_BETA_FACTOR)
                ));

            const orderParams = generateOrderTemplate(
              Number(market.wsIndexPrice),
              quantity,
              Number(market.takerOrderMinimum),
              market.quantityRes,
              market.priceRes,
              market.iterations,
              market.priceIncrement,
              marketID,
              side
            );

            for (const orderParam of orderParams) {
              if (!runMarket && orderParam.type.includes("market")) {
                continue;
              }
              if (orderParam.quantity < Number(market.makerOrderMinimum)) {
                orderParam.quantity = market.makerOrderMinimum;
              }
              if (
                totalOrdersCount >= Number(process.env.OPEN_ORDERS) &&
                !cancelledOrders
              ) {
                retry(() =>
                  client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                    // market: previousMarket,
                  })
                )
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
                    await setTimeout(1000);
                  });
                break;
              } else {
                totalOrdersCount++;
                logger.debug(JSON.stringify(orderParam, null, 2));
                const order = client.RestAuthenticatedClient.createOrder({
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
                  await setTimeout(1000);
                });

                logger.debug(JSON.stringify(order, null, 2));
                let sideIdentifier =
                  side === idex.OrderSide.buy ? "BUY " : "SELL";

                if (orderParam.type.includes("market")) {
                  sideIdentifier = sideIdentifier === "BUY " ? "SELL" : "BUY ";
                }

                let price = orderParam.price || "market";
                logger.info(
                  `${accountKey} ${marketID} ${sideIdentifier} order for at ${price}. ${totalOrdersCount}`
                );

                process.env.COOLDOWN === "true" &&
                  (await setTimeout(
                    Number(process.env.COOLDOWN_PER_ORDER) * 1000
                  ));
              }
            }
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
          }

          process.env.COOLDOWN === "true" &&
            (await setTimeout(Number(process.env.COOLDOWN_PER_MARKET) * 1000));
          side =
            side === idex.OrderSide.buy
              ? idex.OrderSide.sell
              : idex.OrderSide.buy;
        }
        const cooldownMessage =
          process.env.COOLDOWN === "true"
            ? `cooldown for ${process.env.COOLDOWN_PER_ACCOUNT} seconds`
            : "";
        logger.info(
          `Finished processing markets for ${accountKey}. ${cooldownMessage}`
        );
        side =
          side === idex.OrderSide.buy
            ? idex.OrderSide.sell
            : idex.OrderSide.buy;
        process.env.COOLDOWN === "true" &&
          (await setTimeout(Number(process.env.COOLDOWN_PER_ACCOUNT) * 1000));
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      continue;
    }
  }
}

main().catch((error) => {
  logger.error("Error during main function:", error);
});

/** OLD CODE
import { fetchAccounts } from "./accountsParser";
import { fetchMarkets, initializeAccounts, initializeCancels } from "./init";
import { clientBuilder } from "./utils/clientBuilder";
import * as idex from "@idexio/idex-sdk";
import { IClient } from "./utils/IAaccounts";
import logger from "./utils/logger";
import { retry } from "./utils/retry";
import dotenv from "dotenv";
import path from "path";
import { setTimeout } from "timers/promises";
import { generateOrderTemplate } from "./utils/generators";
// import { db } from "./utils/mysqlConnector";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.ORDERS") });

const main = async () => {
  logger.info("Starting main function");
  let initSide: idex.OrderSide = process.env.SIDE as idex.OrderSide;
  const accounts = fetchAccounts();
  const clients: { [key: string]: IClient } = {};

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

  await execLoop(clients, initSide as idex.OrderSide);
};

main().catch((error) => {
  logger.error("Error during main function:", error);
});

async function execLoop(
  clients: { [key: string]: IClient },
  initSide: idex.OrderSide
) {
  let side: idex.OrderSide = initSide;
  while (true) {
    try {
      const markets = await fetchMarkets();
      for (const [accountKey, client] of Object.entries(clients)) {
        for (const market of markets) {
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          let totalOrdersCount: number;
          try {
            const openPositions = await retry(() =>
              client.RestAuthenticatedClient.getPositions({
                market: marketID,
                ...client.getWalletAndNonce,
              })
            );

            const openOrders = await retry(() =>
              client.RestAuthenticatedClient.getOrders({
                ...client.getWalletAndNonce,
                limit: 1000,
              })
            );

            totalOrdersCount = +openOrders.length;

            if (totalOrdersCount >= Number(process.env.OPEN_ORDERS)) {
              const cancelledOrders = await retry(() =>
                client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                  market: marketID,
                })
              );
              totalOrdersCount -= cancelledOrders.length;
              logger.info(
                `Cancelled ${cancelledOrders.length} orders for ${accountKey} due to limit exceedance.`
              );
            }

            // temp
            const orderBook = await retry(() =>
              client.RestPublicClient.getOrderBookLevel2({
                market: marketID,
                limit: 1000,
              })
            );

            const calculateWeight = (orders: any) =>
              orders.reduce(
                (acc: any, [price, quantity]) =>
                  acc + Number(price) * Number(quantity),
                0
              );

            let obIndicator: boolean;
            let posIndicator: boolean;

            const bidsWeight = calculateWeight(orderBook.bids);
            const asksWeight = calculateWeight(orderBook.asks);

            if (bidsWeight > (bidsWeight + asksWeight) / 2) {
              side = idex.OrderSide.sell;
            } else {
              side = idex.OrderSide.buy;
            }

            if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) > 0 &&
              Math.abs(Number(openPositions[0].quantity)) >
                Number(market.maximumPositionSize) / 2
            ) {
              side = idex.OrderSide.sell;
            } else if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) < 0 &&
              Math.abs(Number(openPositions[0].quantity)) <
                Number(market.maximumPositionSize) / 2
            ) {
              side = idex.OrderSide.buy;
            }

            logger.info(
              `${
                side === "buy"
                  ? "placing BUY  orders"
                  : "placing SELL orders"
              }`
            );

            // "test"

            const quantity =
              Number(market.makerOrderMinimum) *
              Number(process.env.QUANTITY_ALPHA_FACTOR) *
              (1 +
                Math.floor(
                  Math.random() * Number(process.env.QUANTITY_BETA_FACTOR)
                ));

            const orderParams = generateOrderTemplate(
              Number(market.indexPrice),
              quantity,
              Number(market.takerOrderMinimum),
              market.quantityRes,
              market.priceRes,
              market.iterations,
              market.priceIncrement,
              marketID,
              side
            );

            for (const orderParam of orderParams) {
              if (orderParam.quantity < Number(market.makerOrderMinimum)) {
                orderParam.quantity = market.makerOrderMinimum;
              }
              if (totalOrdersCount >= Number(process.env.OPEN_ORDERS)) {
                const cancelledOrders = await retry(() =>
                  client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                    // market: previousMarket,
                  })
                );
                totalOrdersCount -= cancelledOrders.length;
                logger.info(
                  `Cancelled ${cancelledOrders.length} orders for ${accountKey} due to limit exceedance.`
                );
                break;
              } else {
                totalOrdersCount++;
                logger.debug(JSON.stringify(orderParam, null, 2));
                const order = client.RestAuthenticatedClient.createOrder({
                  ...orderParam,
                  ...client.getWalletAndNonce,
                });

                logger.debug(JSON.stringify(order, null, 2));
                let sideIdentifier =
                  side === idex.OrderSide.buy ? "BUY " : "SELL";

                if (orderParam.type.includes("market")) {
                  sideIdentifier = sideIdentifier === "BUY " ? "SELL" : "BUY ";
                }

                let price = orderParam.price || "market";
                logger.info(
                  `${accountKey} ${marketID} ${sideIdentifier} order for at ${price}. ${totalOrdersCount}`
                );

                process.env.COOLDOWN === "true" &&
                  (await setTimeout(
                    Number(process.env.COOLDOWN_PER_ORDER) * 1000
                  ));
              }
            }
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
          }

          process.env.COOLDOWN === "true" &&
            (await setTimeout(Number(process.env.COOLDOWN_PER_MARKET) * 1000));
          side =
            side === idex.OrderSide.buy
              ? idex.OrderSide.sell
              : idex.OrderSide.buy;
        }
        const cooldownMessage =
          process.env.COOLDOWN === "true"
            ? `cooldown for ${process.env.COOLDOWN_PER_ACCOUNT} seconds`
            : "";
        logger.info(
          `Finished processing markets for ${accountKey}. ${cooldownMessage}`
        );
        side =
          side === idex.OrderSide.buy
            ? idex.OrderSide.sell
            : idex.OrderSide.buy;
        process.env.COOLDOWN === "true" &&
          (await setTimeout(Number(process.env.COOLDOWN_PER_ACCOUNT) * 1000));
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      continue;
    }
  }
}
 */

/**
async function execLoop(
  clients: { [key: string]: IClient },
  initSide: idex.OrderSide
) {
  let markets: ExtendedIDEXMarket[] = [];
  let side: idex.OrderSide = initSide;
  markets = await fetchMarkets();
  const marketsSubscription = markets.map(
    (m) => `${m.baseAsset}-${m.quoteAsset}`
  );

  await wsHandler(marketsSubscription, markets);

  while (true) {
    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        let updatedMarkets = markets;
        for (const market of updatedMarkets) {
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          let totalOrdersCount: number;
          try {
            const [openPositions, openOrders, orderBook] = await Promise.all([
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

            totalOrdersCount = +openOrders.length;

            if (totalOrdersCount >= Number(process.env.OPEN_ORDERS)) {
              const cancelledOrders = await retry(() =>
                client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                  market: marketID,
                })
              );
              totalOrdersCount -= cancelledOrders.length;
              logger.info(
                `Cancelled ${cancelledOrders.length} orders for ${accountKey} due to limit exceedance.`
              );
            }

            const calculateWeight = (orders: any) =>
              orders.reduce(
                (acc: any, [price, quantity]) =>
                  acc + Number(price) * Number(quantity),
                0
              );

            let obIndicator: boolean;
            let posIndicator: boolean;

            const bidsWeight = calculateWeight(orderBook.bids);
            const asksWeight = calculateWeight(orderBook.asks);

            if (bidsWeight > (bidsWeight + asksWeight) / 2) {
              side = idex.OrderSide.sell;
            } else {
              side = idex.OrderSide.buy;
            }

            let runMarket = true;

            if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) > 0 &&
              Math.abs(Number(openPositions[0].quantity)) >
                Number(market.maximumPositionSize) / 2
            ) {
              side = idex.OrderSide.sell;
              runMarket = false;
            } else if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) < 0 &&
              Math.abs(Number(openPositions[0].quantity)) <
                Number(market.maximumPositionSize) / 2
            ) {
              side = idex.OrderSide.buy;
              runMarket = false;
            }

            logger.info(
              `${
                side === "buy"
                  ? `placing BUY  orders at ${market.wsIndexPrice}`
                  : `placing SELL orders ${market.wsIndexPrice}`
              }`
            );

            // "test"

            const quantity =
              Number(market.makerOrderMinimum) *
              Number(process.env.QUANTITY_ALPHA_FACTOR) *
              (1 +
                Math.floor(
                  Math.random() * Number(process.env.QUANTITY_BETA_FACTOR)
                ));

            const orderParams = generateOrderTemplate(
              Number(market.wsIndexPrice),
              quantity,
              Number(market.takerOrderMinimum),
              market.quantityRes,
              market.priceRes,
              market.iterations,
              market.priceIncrement,
              marketID,
              side
            );

            for (const orderParam of orderParams) {
              if (!runMarket && orderParam.type.includes("market")) {
                continue;
              }
              if (orderParam.quantity < Number(market.makerOrderMinimum)) {
                orderParam.quantity = market.makerOrderMinimum;
              }
              if (totalOrdersCount >= Number(process.env.OPEN_ORDERS)) {
                const cancelledOrders = await retry(() =>
                  client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                    // market: previousMarket,
                  })
                );
                totalOrdersCount -= cancelledOrders.length;
                logger.info(
                  `Cancelled ${cancelledOrders.length} orders for ${accountKey} due to limit exceedance.`
                );
                break;
              } else {
                totalOrdersCount++;
                logger.debug(JSON.stringify(orderParam, null, 2));
                const order = client.RestAuthenticatedClient.createOrder({
                  ...orderParam,
                  ...client.getWalletAndNonce,
                }).catch((e) => {
                  logger.error(
                    `Error creating order for ${accountKey} on market ${marketID}: ${e.message}`
                  );
                });

                logger.debug(JSON.stringify(order, null, 2));
                let sideIdentifier =
                  side === idex.OrderSide.buy ? "BUY " : "SELL";

                if (orderParam.type.includes("market")) {
                  sideIdentifier = sideIdentifier === "BUY " ? "SELL" : "BUY ";
                }

                let price = orderParam.price || "market";
                logger.info(
                  `${accountKey} ${marketID} ${sideIdentifier} order for at ${price}. ${totalOrdersCount}`
                );

                process.env.COOLDOWN === "true" &&
                  (await setTimeout(
                    Number(process.env.COOLDOWN_PER_ORDER) * 1000
                  ));
              }
            }
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
          }

          process.env.COOLDOWN === "true" &&
            (await setTimeout(Number(process.env.COOLDOWN_PER_MARKET) * 1000));
          side =
            side === idex.OrderSide.buy
              ? idex.OrderSide.sell
              : idex.OrderSide.buy;
        }
        const cooldownMessage =
          process.env.COOLDOWN === "true"
            ? `cooldown for ${process.env.COOLDOWN_PER_ACCOUNT} seconds`
            : "";
        logger.info(
          `Finished processing markets for ${accountKey}. ${cooldownMessage}`
        );
        side =
          side === idex.OrderSide.buy
            ? idex.OrderSide.sell
            : idex.OrderSide.buy;
        process.env.COOLDOWN === "true" &&
          (await setTimeout(Number(process.env.COOLDOWN_PER_ACCOUNT) * 1000));
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      continue;
    }
  }
}
 */
