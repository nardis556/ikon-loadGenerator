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
  const ws = await wsClient();
  await ws.connect();
  await handleWsOperation(ws, marketsSubscription, markets);
}

async function handleWsOperation(
  ws: idex.WebSocketClient,
  marketsSubscription: string[],
  markets: ExtendedIDEXMarket[]
) {
  let reconnectionAttempts = 0;
  const maxReconnectionAttempts = 5;
  let isReconnecting = false;

  function subscribe() {
    ws.subscribePublic(
      // @ts-ignore
      [idex.SubscriptionName.l1orderbook],
      marketsSubscription
    );
  }

  subscribe();

  ws.onConnect(() => {
    reconnectionAttempts = 0;
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
    if (!isReconnecting && reconnectionAttempts < maxReconnectionAttempts) {
      isReconnecting = true;
      reconnectionAttempts++;
      await setTimeout(1000 * reconnectionAttempts);
      ws.disconnect();
      await ws.connect();
      subscribe();
      isReconnecting = false;
    } else if (reconnectionAttempts >= maxReconnectionAttempts) {
      logger.error("Max reconnection attempts reached, stopping reconnection.");
    }
  });

  ws.onDisconnect(async (e) => {
    logger.debug(
      `onDisconnect in wsOb function: ${JSON.stringify(e, null, 2)}`
    );
    if (!isReconnecting && reconnectionAttempts < maxReconnectionAttempts) {
      isReconnecting = true;
      reconnectionAttempts++;
      await setTimeout(1000 * reconnectionAttempts);
      ws.disconnect();
      await ws.connect();
      subscribe();
      isReconnecting = false;
    } else if (reconnectionAttempts >= maxReconnectionAttempts) {
      logger.error("Max reconnection attempts reached, stopping reconnection.");
    }
  });
}

const marketData = {};

function initializeMarketData(marketID: string, accountKey: string) {
  if (!marketData[marketID]) {
    marketData[marketID] = {};
  }
  if (!marketData[marketID][accountKey]) {
    marketData[marketID][accountKey] = {
      openPositions: [],
      openOrders: [],
      orderBook: { bids: [], asks: [] },
    };
  }
}

async function pollData(
  client: IClient,
  marketID: string,
  accountKey: string,
  key: string,
  fetchFunction: () => Promise<any>
) {
  while (true) {
    try {
      const data = await fetchFunction();
      marketData[marketID][accountKey][key] = data;
    } catch (error) {
      logger.error(
        `Error polling ${key} for market ${marketID}: ${JSON.stringify(
          error.response ? error.response.data : error,
          null,
          2
        )}`
      );
      await setTimeout(1000);
      initializeMarketData(marketID, accountKey);
    }
    await setTimeout(10000);
  }
}

async function startPolling(
  client: IClient,
  marketID: string,
  accountKey: string
) {
  initializeMarketData(marketID, accountKey);
  ["openPositions", "openOrders", "orderBook"].forEach((key) => {
    pollData(client, marketID, accountKey, key, () => {
      switch (key) {
        case "openPositions":
          return client.RestAuthenticatedClient.getPositions({
            market: marketID,
            ...client.getWalletAndNonce,
          }).catch(async (error) => {
            logger.error(
              `Error fetching open positions: ${
                (error.response ? error.response?.data : error, null, 2)
              }`
            );
            await setTimeout(1000);
          });
        case "openOrders":
          return client.RestAuthenticatedClient.getOrders({
            ...client.getWalletAndNonce,
            limit: 1000,
          }).catch(async (error) => {
            logger.error(
              `Error fetching open orders: ${
                (error.response ? error.response?.data : error, null, 2)
              }`
            );
            await setTimeout(1000);
          });
        case "orderBook":
          return client.RestPublicClient.getOrderBookLevel2({
            market: marketID,
            limit: 200,
          }).catch(async (error) => {
            logger.error(
              `Error fetching orderbook: ${
                (error.response ? error.response?.data : error, null, 2)
              }`
            );
            await setTimeout(1000);
          });
      }
    });
  });
}

async function execLoop(
  clients: { [key: string]: IClient },
  initSide: idex.OrderSide
) {
  let markets = await fetchMarkets();
  const marketsSubscription = markets.map(
    (m) => `${m.baseAsset}-${m.quoteAsset}`
  );
  await wsHandler(marketsSubscription, markets);

  for (const market of markets) {
    const marketID = `${market.baseAsset}-${market.quoteAsset}`;
    for (const [accountKey, client] of Object.entries(clients)) {
      logger.info(`Starting polling for ${accountKey} on market ${marketID}`);
      startPolling(client, marketID, accountKey);
      await setTimeout(100);
    }
  }

  logger.info(`Finished polling for all markets.`);
  await setTimeout(1000);

  while (true) {
    try {
      let side = initSide;
      for (const [accountKey, client] of Object.entries(clients)) {
        let updatedMarkets = markets;
        let cancelledOrders: boolean = false;
        for (const market of updatedMarkets) {
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;

          try {
            const { openPositions, openOrders, orderBook } =
              marketData[marketID] && marketData[marketID][accountKey]
                ? marketData[marketID][accountKey]
                : {
                    openPositions: [],
                    openOrders: [],
                    orderBook: { bids: [], asks: [] },
                  };

            if (orderBook.indexPrice) {
              market.wsIndexPrice = orderBook.indexPrice;
            }

            let totalOrdersCount: number;

            totalOrdersCount = +openOrders.length;
            let alreadyCancelled = false;

            if (
              totalOrdersCount >= Number(process.env.OPEN_ORDERS) &&
              !cancelledOrders
            ) {
              ({ totalOrdersCount, cancelledOrders } = CancelOrder(
                client,
                totalOrdersCount,
                accountKey,
                cancelledOrders,
                marketID
              ));
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
              if (
                !runMarket &&
                orderParam.type.toLowerCase().includes("market")
              ) {
                continue;
              }
              if (orderParam.quantity < Number(market.makerOrderMinimum)) {
                orderParam.quantity = market.makerOrderMinimum;
              }
              if (
                totalOrdersCount >= Number(process.env.OPEN_ORDERS) &&
                !cancelledOrders
              ) {
                ({ totalOrdersCount, cancelledOrders } = CancelOrder(
                  client,
                  totalOrdersCount,
                  accountKey,
                  cancelledOrders,
                  marketID
                ));
                break;
              } else {
                totalOrdersCount++;
                logger.debug(JSON.stringify(orderParam, null, 2));
                const order = await CreateOrder(
                  client,
                  orderParam,
                  accountKey,
                  marketID
                );

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
              `Error handling market operations for ${accountKey} on market ${marketID}: ${JSON.stringify(
                e.response ? e.response?.data : e,
                null,
                2
              )}`
            );
            await setTimeout(5000);
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
      logger.error(
        `Error fetching markets: ${JSON.stringify(
          e.response ? e.response?.data : e,
          null,
          2
        )}`
      );
      await setTimeout(5000);
      continue;
    }
  }
}

main().catch((error) => {
  logger.error("Error during main function:", error);
});

function CancelOrder(
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
      await setTimeout(1000);
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
    await setTimeout(1000);
  });
}
