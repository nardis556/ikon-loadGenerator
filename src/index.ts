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

function calculateBestPrice(
  bestAsk: string,
  bestBid: string,
  indexPrice: string
) {
  const weightedBid = Number(process.env.BEST_BID_WEIGHT) * Number(bestBid);
  const weightedAsk = Number(process.env.BEST_ASK_WEIGHT) * Number(bestAsk);
  const weightedIndex =
    Number(process.env.INDEX_PRICE_WEIGHT) * Number(indexPrice);
  return (weightedBid + weightedAsk + weightedIndex) / 3;
}

async function handleWsOperation(
  ws: idex.WebSocketClient,
  marketsSubscription: string[],
  markets: ExtendedIDEXMarket[]
) {
  let reconnectionAttempts = 0;
  const maxReconnectionAttempts = 100;
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
          market.bestAsk = message.data.askPrice;
          market.bestBid = message.data.bidPrice;
          market.bestPrice = calculateBestPrice(
            market.bestAsk,
            market.bestBid,
            market.wsIndexPrice
          );
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
            const [openPositions, openOrders, orderBook] = await fetchData(
              client,
              marketID
            );

            if (orderBook.indexPrice) {
              market.wsIndexPrice = orderBook.indexPrice;
            }

            totalOrdersCount = +openOrders.length;
            if (
              totalOrdersCount >= Number(process.env.OPEN_ORDERS) &&
              !cancelledOrders
            ) {
              ({ totalOrdersCount, cancelledOrders } = await CancelOrder(
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
                  ? `placing BUY  orders at ${market.bestPrice}`
                  : `placing SELL orders ${market.bestPrice}`
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
              Number(market.bestPrice),
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
                ({ totalOrdersCount, cancelledOrders } = await CancelOrder(
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
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
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
      logger.error(`Error fetching markets: ${e.message}`);
      await setTimeout(5000);
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
