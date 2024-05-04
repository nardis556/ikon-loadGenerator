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
  let previousMarket: string;
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
  // const database = new db();

  // if (process.env.WRITE_TO_DB === "true") {
  //   await database.connect();
  // }

  await execLoop(
    clients,
    previousMarket,
    initSide as idex.OrderSide
    // database
  );
};

main().catch((error) => {
  logger.error("Error during main function:", error);
});

async function execLoop(
  clients: { [key: string]: IClient },
  previousMarket: string,
  initSide: idex.OrderSide
  // database: db
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
                Number(market.maximumPositionSize) / 1.5
            ) {
              side = idex.OrderSide.sell;
            } else if (
              openPositions.length !== 0 &&
              Number(openPositions[0].quantity) < 0 &&
              Math.abs(Number(openPositions[0].quantity)) <
                Number(market.maximumPositionSize) / 1.5
            ) {
              side = idex.OrderSide.buy;
            }

            logger.info(
              `${
                side === "buy"
                  ? "Asks outweighs bids, placing BUY  orders"
                  : "Bids outweighs asks, placing SELL orders"
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
                // const order = await retry(() => {
                //   return client.RestAuthenticatedClient.createOrder({
                //     ...orderParam,
                //     ...client.getWalletAndNonce,
                //   });
                // });

                const order = client.RestAuthenticatedClient.createOrder({
                  ...orderParam,
                  ...client.getWalletAndNonce,
                });

                logger.debug(JSON.stringify(order, null, 2));
                // const datetime = new Date(order.time)
                //   .toISOString()
                //   .slice(0, 19)
                //   .replace("T", " ");

                // process.env.WRITE_TO_DB === "true" &&
                //   (await database.writeToCreateOrder(
                //     datetime,
                //     client.getWalletAndNonce.wallet,
                //     order.orderId
                //     // order
                //   ));
                let sideIdentifier =
                  side === idex.OrderSide.buy ? "BUY " : "SELL";

                console.log(`build is working`);

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

            previousMarket = marketID;
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
          }

          const cooldownMessage =
            process.env.COOLDOWN === "true"
              ? `cooldown for ${process.env.COOLDOWN_PER_MARKET} seconds`
              : "";
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
    }
  }
  return { previousMarket, side };
}
