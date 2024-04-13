import { fetchAccounts } from "./accountsParser";
import { fetchMarkets, initializeAccounts, initializeCancels } from "./init";
import { clientBuilder } from "./utils/clientBuilder";
import * as idex from "@idexio/idex-sdk-ikon";
import { IClient } from "./utils/IAaccounts";
import { setTimeout } from "timers/promises";
import logger from "./utils/logger";
import { retry } from "./utils/retry";
import dotenv from "dotenv";
import path from "path";
import { generateOrderTemplate } from "./utils/generators";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const main = async () => {
  logger.info("Starting main function");
  let side: idex.OrderSide = process.env.SIDE as idex.OrderSide;
  let previousMarket: string = "";
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
      for (const market of markets) {
        for (const [accountKey, client] of Object.entries(clients)) {
          try {
            await setTimeout(Number(process.env.COOLDOWN_PER_MARKET) * 1000); // Delay before processing each market
            const openPositions = await retry(() =>
              client.RestAuthenticatedClient.getPositions({
                market: `${market.baseAsset}-${market.quoteAsset}`,
                ...client.getWalletAndNonce,
              })
            );

            const openOrders = await retry(() =>
              client.RestAuthenticatedClient.getOrders({
                ...client.getWalletAndNonce,
              })
            );

            if (openOrders.length > 200) {
              if (previousMarket) {
                await retry(() =>
                  client.RestAuthenticatedClient.cancelOrders({
                    ...client.getWalletAndNonce,
                    market: previousMarket,
                  })
                );
              }
              continue;
            }

            if (openPositions.length !== 0) {
              const netQuantity = Number(openPositions[0].maximumQuantity);
              side = netQuantity > 0 ? idex.OrderSide.sell : idex.OrderSide.buy;
            }

            let quantity =
              Number(market.makerOrderMinimum) *
              (1.5 + 0.1 * Math.floor(Math.random() * 12));
            quantity = Math.max(quantity, Number(market.makerOrderMinimum));

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
              await retry(() =>
                client.RestAuthenticatedClient.createOrder({
                  ...orderParam,
                  ...client.getWalletAndNonce,
                })
              );
              await setTimeout(Number(process.env.COOLDOWN_PER_ORDER) * 1000);
            }

            // await setTimeout(Number(process.env.COOLDOWN_PER_ACCOUNT) * 1000)
            previousMarket = `${market.baseAsset}-${market.quoteAsset}`;
          } catch (e) {
            logger.error(
              `Error handling market operations for ${accountKey} on market ${market.baseAsset}-${market.quoteAsset}: ${e.message}`
            );
          }
        }
        // await setTimeout(Number(process.env.COOLDOWN_PER_MARKET) * 1000);
      }
      side =
        side === idex.OrderSide.buy ? idex.OrderSide.sell : idex.OrderSide.buy;
    } catch (e) {
      logger.error(`Error fetching markets: ${e.message}`);
      await setTimeout(Number(process.env.COOLDOWN_PER_MARKET) * 1000);
    }
  }
};

main().catch((error) => {
  logger.error("Error during main function:", error);
});
