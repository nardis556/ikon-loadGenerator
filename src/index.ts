import { fetchAccounts } from "./accountsParser";
import { fetchMarkets, initializeAccounts, initializeCancels } from "./init";
import { clientBuilder } from "./utils/clientBuilder";
import * as idex from "@idexio/idex-sdk-ikon";
import { IClient } from "./utils/IAaccounts";
import logger from "./utils/logger";
import { retry } from "./utils/retry";
import dotenv from "dotenv";
import path from "path";
import { generateOrderTemplate } from "./utils/generators";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.ORDERS") });

const main = async () => {
  logger.info("Starting main function");
  let side: idex.OrderSide = process.env.SIDE as idex.OrderSide;
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

  while (true) {
    try {
      const markets = await fetchMarkets();
      for (const [accountKey, client] of Object.entries(clients)) {
        let totalOrdersCount = 0;

        for (const market of markets) {
          try {
            const openPositions = await retry(() =>
              client.RestAuthenticatedClient.getPositions({
                market: `${market.baseAsset}-${market.quoteAsset}`,
                ...client.getWalletAndNonce,
              })
            );

            const openOrders = await retry(() =>
              client.RestAuthenticatedClient.getOrders({
                ...client.getWalletAndNonce,
                limit: 1000,
              })
            );

            totalOrdersCount += openOrders.length; // Update total order count

            if (totalOrdersCount > 240) {
              if (!previousMarket) {
                previousMarket = `${market.baseAsset}-${market.quoteAsset}`;
              }
              const cancelledOrders = await retry(() =>
                client.RestAuthenticatedClient.cancelOrders({
                  ...client.getWalletAndNonce,
                  market: previousMarket,
                })
              );

              if (cancelledOrders && cancelledOrders.length) {
                totalOrdersCount -= cancelledOrders.length;
                logger.info(
                  `Cancelled ${cancelledOrders.length} orders for ${accountKey} on market ${previousMarket}.`
                );
              } else {
                logger.info(
                  `No orders cancelled for ${accountKey} on market ${previousMarket}.`
                );
              }
            }

            if (
              openPositions.length !== 0 &&
              Number(openPositions[0].maximumQuantity) > 0
            ) {
              side = idex.OrderSide.sell;
            } else if (
              openPositions.length !== 0 &&
              Number(openPositions[0].maximumQuantity) < 0
            ) {
              side = idex.OrderSide.buy;
            }

            let quantity =
              Number(market.makerOrderMinimum) *
              Number(process.env.QUANTITY_ALPHA_FACTOR) *
              (1 *
                (1 +
                  Math.floor(
                    Math.random() * Number(process.env.QUANTITY_BETA_FACTOR)
                  )));

            const orderParams = generateOrderTemplate(
              Number(market.indexPrice),
              quantity,
              market.quantityRes,
              market.priceRes,
              market.iterations,
              market.priceIncrement,
              `${market.baseAsset}-${market.quoteAsset}`,
              side
            );

            for (const orderParam of orderParams) {
              if (orderParam.quantity < Number(market.makerOrderMinimum)) {
                orderParam.quantity = market.makerOrderMinimum;
              }
              const order = await retry(() => {
                return client.RestAuthenticatedClient.createOrder({
                  ...orderParam,
                  ...client.getWalletAndNonce,
                });
              });
              totalOrdersCount++;
              logger.info(
                `Created ${orderParam.side} order for ${accountKey} on market ${market.baseAsset}-${market.quoteAsset}: ${order.orderId}`
              );
              if (totalOrdersCount >= 240) {
                logger.warn(`Approaching order limit for ${accountKey}`);
                break;
              }
            }

            previousMarket = `${market.baseAsset}-${market.quoteAsset}`;
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${market.baseAsset}-${market.quoteAsset}: ${e.message}`
            );
          }
          side =
            side === idex.OrderSide.buy
              ? idex.OrderSide.sell
              : idex.OrderSide.buy;
        }
      }
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
    }
  }
};

main().catch((error) => {
  logger.error("Error during main function:", error);
});
