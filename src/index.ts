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
    await execLoop(clients, initSide);
  }
};

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

let isTradingEnabled = true;

async function checkAndPauseIfTradingDisabled() {
  if (!isTradingEnabled) {
    logger.error(`Trading disabled. Pausing trading operations.`);
    await sleep(180000);
    isTradingEnabled = true;
  }
}

async function execLoop(
  clients: { [key: string]: IClient },
  initSide: idex.OrderSide
) {
  let markets: ExtendedIDEXMarket[] = [];
  let side: idex.OrderSide = initSide;
  markets = await fetchMarkets();
  // const marketsSubscription = markets.map(
  //   (m) => `${m.baseAsset}-${m.quoteAsset}`
  // );

  // const handler = new WebSocketHandler(marketsSubscription, markets);
  // await handler.initWebSocket();

  while (true) {
    await checkAndPauseIfTradingDisabled();
    try {
      for (const [accountKey, client] of Object.entries(clients)) {
        await checkAndPauseIfTradingDisabled();
        let updatedMarkets = markets;
        let cancelledOrders: boolean = false;
        for (const market of updatedMarkets) {
          await checkAndPauseIfTradingDisabled();
          const marketID = `${market.baseAsset}-${market.quoteAsset}`;
          let totalOrdersCount: number;
          let currentOrderCount: number = 0;
          try {
            let openPositions: idex.RestResponseGetPositions;
            let openOrders: idex.RestResponseGetOrders;
            let orderBook: idex.RestResponseGetOrderBookLevel2;
            [openPositions, openOrders, orderBook] = await fetchData(
              client,
              marketID
            );

            market.indexPrice = orderBook.indexPrice;

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

            let runMarket: boolean = true;
            // @ts-ignore
            ({ runMarket, side } = validateOrderSide(
              orderBook,
              side,
              openPositions,
              market
            ));

            const quantity = Number(market.makerOrderMinimum);

            const orderParams = generateOrderTemplate(
              side === idex.OrderSide.buy
                ? Number(market.indexPrice) * 0.999999
                : Number(market.indexPrice) * 1.000000,
              quantity,
              Number(market.takerOrderMinimum),
              market.quantityRes,
              market.priceRes,
              market.iterations,
              market.priceIncrement,
              marketID,
              side
            );

            const orderStartTime = Date.now();
            logger.debug(JSON.stringify(orderParams, null, 2));
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
                // logger.debug(JSON.stringify(orderParam, null, 2));
                const order = await CreateOrder(
                  client,
                  orderParam,
                  accountKey,
                  marketID
                ).then(() => {
                  currentOrderCount++;
                });
                let sideIdentifier =
                  side === idex.OrderSide.buy ? "BUY " : "SELL";

                if (orderParam.type.includes("market")) {
                  sideIdentifier = sideIdentifier === "BUY " ? "SELL" : "BUY ";
                }

                let price = orderParam.price || "market";
                logger.debug(
                  `${accountKey} ${marketID} ${sideIdentifier} order for at ${price}. ${totalOrdersCount}`
                );

                process.env.COOLDOWN === "true" &&
                  (await sleep(Number(process.env.COOLDOWN_PER_ORDER) * 1000));
              }
            }
            const orderEndTime = Date.now();
            const orderDuration = (orderEndTime - orderStartTime) / 1000;
            const ordersPerSecond =
              orderDuration > 0 ? currentOrderCount / orderDuration : 0;
            logger.info(
              `OPS ${accountKey} ${marketID}: ${ordersPerSecond.toFixed(2)}`
            );
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
            await sleep(5000);
          }

          process.env.COOLDOWN === "true" &&
            (await sleep(Number(process.env.COOLDOWN_PER_MARKET) * 1000));
          side =
            side === idex.OrderSide.buy
              ? idex.OrderSide.sell
              : idex.OrderSide.buy;
          logger.info(
            `Finished processing market ${marketID} for ${accountKey}.`
          );
          logger.info(
            `Account ${accountKey} placed ${currentOrderCount} orders.`
          );
        }
        const cooldownMessage =
          process.env.COOLDOWN === "true"
            ? `CD for ${process.env.COOLDOWN_PER_ACCOUNT}s`
            : "";
        logger.info(
          `Finished processing markets for ${accountKey}. ${cooldownMessage}`
        );
        side =
          side === idex.OrderSide.buy
            ? idex.OrderSide.sell
            : idex.OrderSide.buy;
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

function cancelUntil(accountKey: string, client: IClient) {
  const cancelTimeout = 180000

  logger.info(
    `Cancelling orders for ${accountKey} in ${cancelTimeout / 1000}s.`
  );

  setTimeout(async () => {
    try {
      await client.RestAuthenticatedClient.cancelOrders({
        ...client.getWalletAndNonce,
      });
      logger.info(`Cancelled orders for ${accountKey}.`);
    } catch (e) {
      logger.error(`Error cancelling orders for ${accountKey}`);
    }
  }, cancelTimeout);
}

// function calculateBestPrice(bestAsk: any, bestBid: any, indexPrice: string) {
//   const parsedBestBid = Number(bestBid) > 0 ? Number(bestBid) : 0;
//   const parsedBestAsk = Number(bestAsk) > 0 ? Number(bestAsk) : 0;
//   const parsedIndexPrice = Number(indexPrice);

//   const bidWeight = Number(process.env.BEST_BID_WEIGHT) || 0.25;
//   const askWeight = Number(process.env.BEST_ASK_WEIGHT) || 0.25;
//   const indexWeight = Number(process.env.INDEX_PRICE_WEIGHT) || 0.5;

//   if (parsedBestBid === 0 && parsedBestAsk === 0) {
//     return parsedIndexPrice.toFixed(8);
//   }

//   let totalWeight = indexWeight;
//   let totalValue = indexWeight * parsedIndexPrice;

//   if (parsedBestBid > 0) {
//     totalWeight += bidWeight;
//     totalValue += bidWeight * parsedBestBid;
//   }

//   if (parsedBestAsk > 0) {
//     totalWeight += askWeight;
//     totalValue += askWeight * parsedBestAsk;
//   }

//   return (totalValue / totalWeight).toFixed(8);
// }

function validateOrderSide(
  orderBook: idex.RestResponseGetOrderBookLevel2,
  side: string,
  openPositions: any,
  market: ExtendedIDEXMarket
) {
  const indexPrice = Number(market.indexPrice);

  const weightFactorToIncludeInSideCalculation = 0.00111;
  const weightFactorToIncludeInTotalValueCalculation = 0.00222;
  const maxPriceDeviation = 0.001;

  const bidsCalculation = calculateMarketMetrics(
    orderBook.bids,
    indexPrice,
    weightFactorToIncludeInSideCalculation,
    "weight"
  );
  const asksCalculation = calculateMarketMetrics(
    orderBook.asks,
    indexPrice,
    weightFactorToIncludeInSideCalculation,
    "weight"
  );
  const totalBidsValue = calculateMarketMetrics(
    orderBook.bids,
    indexPrice,
    weightFactorToIncludeInTotalValueCalculation,
    "totalValue"
  ).totalValue;
  const totalAsksValue = calculateMarketMetrics(
    orderBook.asks,
    indexPrice,
    weightFactorToIncludeInTotalValueCalculation,
    "totalValue"
  ).totalValue;

  const bidsWeight = bidsCalculation.weight * 1.01;
  const asksWeight = asksCalculation.weight * 0.99;

  if (bidsWeight > (bidsWeight + asksWeight) / 2) {
    side = idex.OrderSide.sell;
  } else {
    side = idex.OrderSide.buy;
  }

  logger.debug(
    `Bids Weight: ${bidsWeight}, Asks Weight: ${asksWeight}, Index Price: ${indexPrice}`
  );
  if (bidsCalculation.averagePrice > indexPrice) {
    side = idex.OrderSide.sell;
  } else if (asksCalculation.averagePrice < indexPrice) {
    side = idex.OrderSide.buy;
  }
  logger.debug(
    `Average Bid Price: ${bidsCalculation.averagePrice}, Average Ask Price: ${asksCalculation.averagePrice} within ${weightFactorToIncludeInSideCalculation} of index price ${indexPrice}`
  );

  let runMarket = true;

  if (side === idex.OrderSide.sell && totalBidsValue < 10000) {
    runMarket = false;
  } else if (side === idex.OrderSide.buy && totalAsksValue < 10000) {
    runMarket = false;
  }

  if (orderBook.asks.length < 20 || orderBook.bids.length < 20) {
    if (
      orderBook.asks.length < 20 &&
      orderBook.asks.length < orderBook.bids.length
    ) {
      side = idex.OrderSide.sell;
    } else if (
      orderBook.bids.length < 20 &&
      orderBook.bids.length < orderBook.asks.length
    ) {
      side = idex.OrderSide.buy;
    }
  }

  if (
    asksCalculation.averagePrice > indexPrice * (1 + maxPriceDeviation) ||
    bidsCalculation.averagePrice < indexPrice * (1 - maxPriceDeviation)
  ) {
    side =
      asksCalculation.averagePrice > indexPrice * (1 + maxPriceDeviation)
        ? idex.OrderSide.sell
        : idex.OrderSide.buy;
  }

  const bestBid =
    orderBook.bids.length > 0 ? Number(orderBook.bids[0][0]) : null;
  const bestAsk =
    orderBook.asks.length > 0 ? Number(orderBook.asks[0][0]) : null;

  if (bestAsk && bestAsk > indexPrice * (1 + maxPriceDeviation)) {
    side = idex.OrderSide.sell;
  } else if (bestBid && bestBid < indexPrice * (1 - maxPriceDeviation)) {
    side = idex.OrderSide.buy;

    logger.info(
      `${
        side === "buy"
          ? `BUY  orders at ${market.indexPrice}, IP: ${indexPrice}`
          : `SELL orders at ${market.indexPrice}, IP: ${indexPrice}`
      }`
    );
  }
  return { runMarket, side };
}

function calculateMarketMetrics(
  orders: any,
  indexPrice: number,
  weightFactor: number,
  mode: "weight" | "totalValue"
) {
  const filteredOrders = orders.filter(
    ([price, _]: [string, string]) =>
      Math.abs(Number(price) - indexPrice) / indexPrice <= weightFactor
  );

  if (mode === "weight") {
    const totalWeight = filteredOrders.reduce(
      (acc: any, [price, quantity]) => {
        acc.total += Number(price) * Number(quantity);
        acc.quantity += Number(quantity);
        return acc;
      },
      { total: 0, quantity: 0 }
    );
    const averagePrice =
      totalWeight.quantity > 0 ? totalWeight.total / totalWeight.quantity : 0;
    return { weight: totalWeight.total, averagePrice };
  } else {
    // mode === 'totalValue'
    const totalValue = filteredOrders.reduce(
      (acc: any, [price, quantity]) => acc + Number(price) * Number(quantity),
      0
    );
    return { totalValue };
  }
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
      isTradingEnabled = true;
    }
    await sleep(1000);
  });
}
