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

  ({ previousMarket, side } = await execLoop(
    clients,
    previousMarket,
    side as idex.OrderSide
  ));
};

main().catch((error) => {
  logger.error("Error during main function:", error);
});

async function execLoop(
  clients: { [key: string]: IClient },
  previousMarket: string,
  side: idex.OrderSide
) {
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
                `Cancelled ${cancelledOrders.length} orders for ${accountKey} on market ${marketID} due to limit exceedance.`
              );
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
                    market: previousMarket,
                  })
                );
                totalOrdersCount -= cancelledOrders.length;
                logger.info(
                  `Cancelled ${cancelledOrders.length} orders for ${accountKey} on market ${previousMarket} due to limit exceedance.`
                );
                break;
              } else {
                totalOrdersCount++;
                const order = await retry(() => {
                  return client.RestAuthenticatedClient.createOrder({
                    ...orderParam,
                    ...client.getWalletAndNonce,
                  });
                });
                let sideIdentifier =
                  side === idex.OrderSide.buy ? "BUY " : "SELL";
                let price = orderParam.price || "market";
                logger.info(
                  `${accountKey} ${marketID} ${sideIdentifier} order for at ${price}. ${totalOrdersCount}`
                );
              }
            }

            previousMarket = marketID;
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${marketID}: ${e.message}`
            );
          }

          // Ensure we switch sides for the next market
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
  return { previousMarket, side };
}
