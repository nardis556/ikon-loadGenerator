import dotenv from "dotenv";
import path from "path";
import { clientBuilder } from "./utils/clientBuilder.ts";
import logger from "./utils/logger.ts";
import { IDEXMarket } from "@idexio/idex-sdk";
import * as idex from "@idexio/idex-sdk";
import { retry } from "./utils/retry.ts";
import { ethers } from "ethers";
import { AccountInfo } from "../src/utils/IAaccounts";
import { IClient } from "../src/utils/IAaccounts";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.ORDERS") });

export interface ExtendedIDEXMarket extends IDEXMarket {
  priceRes: string;
  quantityRes: string;
  priceIncrement: number;
  iterations: number;
  wsIndexPrice: any;
  bestPrice: any;
  bestBid: any;
  bestAsk: any;
}

const initAuth = {
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
};

// Fetch markets from .env.ORDERS
const envMarkets = process.env.MARKETS ? process.env.MARKETS.split(",") : [];
const priceIncrements = parseMarketConfig(process.env.PRICE_INCREMENT);
const iterationsConfig = parseMarketConfig(process.env.ITERATIONS);

function parseMarketConfig(configStr: string): { [key: string]: string } {
  return configStr.split(",").reduce((acc, cur) => {
    const [key, value] = cur.split(":");
    acc[key] = value;
    return acc;
  }, {});
}

export const fetchMarkets = async (): Promise<ExtendedIDEXMarket[]> => {
  try {
    const client = await clientBuilder(
      initAuth.apiKey,
      initAuth.apiSecret,
      initAuth.walletPrivateKey
    );
    const markets = await retry(() => client.RestPublicClient.getMarkets());

    const filteredMarkets = markets
      .filter((market: IDEXMarket) =>
        envMarkets.includes(`${market.baseAsset}-${market.quoteAsset}`)
      )
      .map(
        (market): ExtendedIDEXMarket => ({
          ...market,
          priceRes: market.tickSize,
          quantityRes: market.stepSize,
          priceIncrement: parseFloat(
            priceIncrements[`${market.baseAsset}-${market.quoteAsset}`] ||
              "0.01"
          ),
          iterations: parseInt(
            iterationsConfig[`${market.baseAsset}-${market.quoteAsset}`] ||
              "25",
            10
          ),
          wsIndexPrice: market.indexPrice,
          bestPrice: market.indexPrice,
          bestBid: market.indexPrice,
          bestAsk: market.indexPrice,
        })
      );

    const marketSymbols = filteredMarkets.map(
      (market) => `${market.baseAsset}-${market.quoteAsset}`
    );
    logger.info(`Fetched ${marketSymbols.join(", ")} markets.`);
    logger.debug(JSON.stringify(filteredMarkets, null, 2));
    return filteredMarkets;
  } catch (e) {
    logger.error(
      `Failed to fetch markets. Data: ${JSON.stringify(
        e.response ? e.response.data : e,
        null,
        2
      )}`
    );
    logger.error(`Stack: ${e.stack}`);
    throw new Error(`Failed to fetch markets. Error: ${e}`);
  }
};

export async function wsClient(): Promise<idex.WebSocketClient> {
  try {
    const wsOptions = {
      auth: {
        apiKey: process.env.API_KEY,
        apiSecret: process.env.API_SECRET,
        wallet: ethers.computeAddress(process.env.WALLET_PRIVATE_KEY),
      },
      baseWebSocketURL: process.env.WSS,
      sandbox: true,
      shouldReconnectAutomatically: true,
    };

    const client = new idex.WebSocketClient(wsOptions);
    return client satisfies idex.WebSocketClient;
  } catch (error) {
    logger.error(`Error creating WS client: ${JSON.stringify(error, null, 2)}`);
  }
}

export async function initializeAccounts(
  accounts: Record<string, AccountInfo>,
  clients: { [key: string]: IClient }
) {
  let client: IClient;
  for (const [accountKey, accountInfo] of Object.entries(accounts)) {
    try {
      client = await clientBuilder(
        accountInfo.apiKey,
        accountInfo.apiSecret,
        accountInfo.privateKey
      );
      await retry(() =>
        client.RestAuthenticatedClient.associateWallet({
          wallet: client.getWalletAndNonce.wallet,
          nonce: client.getWalletAndNonce.nonce,
        })
      );
      clients[accountKey] = client;
      logger.info(
        `Wallet successfully associated for ${accountKey} with wallet ${client.getWalletAndNonce.wallet}`
      );
    } catch (e) {
      logger.error(`
      Failed to associate wallet for ${accountKey}: ${e.message}`);
    }
  }
}

export async function initializeCancels(
  accounts: Record<string, AccountInfo>,
  clients: { [key: string]: IClient }
) {
  let client: IClient;
  for (const [accountKey, accountInfo] of Object.entries(accounts)) {
    try {
      client = await clientBuilder(
        accountInfo.apiKey,
        accountInfo.apiSecret,
        accountInfo.privateKey
      );
      await retry(() =>
        client.RestAuthenticatedClient.cancelOrders({
          wallet: client.getWalletAndNonce.wallet,
          nonce: client.getWalletAndNonce.nonce,
        })
      );
      clients[accountKey] = client;
      logger.info(
        `Orders for ${accountKey} successfully cancelled orders for wallet ${client.getWalletAndNonce.wallet}`
      );
    } catch (e) {
      logger.error(`
      Failed to cancel orders for wallet ${client.getWalletAndNonce.wallet} for ${accountKey}: ${e.message}`);
    }
  }
}

export const initClient = async (): Promise<IClient> => {
  try {
    const client = await clientBuilder(
      initAuth.apiKey,
      initAuth.apiSecret,
      initAuth.walletPrivateKey
    );
    return client;
  } catch (e) {
    logger.error(
      `Failed to create client. Data: ${JSON.stringify(
        e.response ? e.response.data : e,
        null,
        2
      )}`
    );
  }
};

/**
import dotenv from "dotenv";
import path from "path";
import { clientBuilder } from "./utils/clientBuilder.ts";
import logger from "./utils/logger.ts";
import { IDEXMarket } from "@idexio/idex-sdk";
import { retry } from "./utils/retry.ts";
import { AccountInfo } from "../src/utils/IAaccounts";
import { IClient } from "../src/utils/IAaccounts";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.ORDERS") });

interface ExtendedIDEXMarket extends IDEXMarket {
  priceRes: string;
  quantityRes: string;
  priceIncrement: number;
  iterations: number;
}

const initAuth = {
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
};

// Fetch markets from .env.ORDERS
const envMarkets = process.env.MARKETS ? process.env.MARKETS.split(",") : [];
const priceIncrements = parseMarketConfig(process.env.PRICE_INCREMENT);
const iterationsConfig = parseMarketConfig(process.env.ITERATIONS);

function parseMarketConfig(configStr: string): { [key: string]: string } {
  return configStr.split(",").reduce((acc, cur) => {
    const [key, value] = cur.split(":");
    acc[key] = value;
    return acc;
  }, {});
}

export const fetchMarkets = async (): Promise<ExtendedIDEXMarket[]> => {
  try {
    const client = await clientBuilder(
      initAuth.apiKey,
      initAuth.apiSecret,
      initAuth.walletPrivateKey
    );
    const markets = await retry(() => client.RestPublicClient.getMarkets());

    const filteredMarkets = markets
      .filter((market: IDEXMarket) =>
        envMarkets.includes(`${market.baseAsset}-${market.quoteAsset}`)
      )
      .map(
        (market): ExtendedIDEXMarket => ({
          ...market,
          priceRes: market.tickSize,
          quantityRes: market.stepSize,
          priceIncrement: parseFloat(
            priceIncrements[`${market.baseAsset}-${market.quoteAsset}`] ||
            "0.01"
          ),
          iterations: parseInt(
            iterationsConfig[`${market.baseAsset}-${market.quoteAsset}`] ||
            "25",
            10
          ),
        })
      );

    const marketSymbols = filteredMarkets.map(
      (market) => `${market.baseAsset}-${market.quoteAsset}`
    );
    logger.info(`Fetched ${marketSymbols.join(", ")} markets.`);
    logger.debug(JSON.stringify(filteredMarkets, null, 2))
    return filteredMarkets;
  } catch (e) {
    logger.error(
      `Failed to fetch markets. Data: ${JSON.stringify(
        e.response ? e.response.data : e,
        null,
        2
      )}`
    );
    logger.error(`Stack: ${e.stack}`);
    throw new Error(`Failed to fetch markets. Error: ${e}`);
  }
};

export async function initializeAccounts(
  accounts: Record<string, AccountInfo>,
  clients: { [key: string]: IClient }
) {
  let client: IClient;
  for (const [accountKey, accountInfo] of Object.entries(accounts)) {
    try {
      client = await clientBuilder(
        accountInfo.apiKey,
        accountInfo.apiSecret,
        accountInfo.privateKey
      );
      await retry(() =>
        client.RestAuthenticatedClient.associateWallet({
          wallet: client.getWalletAndNonce.wallet,
          nonce: client.getWalletAndNonce.nonce,
        })
      );
      clients[accountKey] = client;
      logger.debug(
        `Wallet successfully associated for ${accountKey} with wallet ${client.getWalletAndNonce.wallet}`
      );
    } catch (e) {
      logger.error(`
      Failed to associate wallet for ${accountKey}: ${e.message}`);
    }
  }
}

export async function initializeCancels(
  accounts: Record<string, AccountInfo>,
  clients: { [key: string]: IClient }
) {
  let client: IClient;
  for (const [accountKey, accountInfo] of Object.entries(accounts)) {
    try {
      client = await clientBuilder(
        accountInfo.apiKey,
        accountInfo.apiSecret,
        accountInfo.privateKey
      );
      await retry(() =>
        client.RestAuthenticatedClient.cancelOrders({
          wallet: client.getWalletAndNonce.wallet,
          nonce: client.getWalletAndNonce.nonce,
        })
      );
      clients[accountKey] = client;
      logger.debug(
        `Orders for ${accountKey} successfully cancelled orders for wallet ${client.getWalletAndNonce.wallet}`
      );
    } catch (e) {
      logger.error(`
      Failed to cancel orders for wallet ${client.getWalletAndNonce.wallet} for ${accountKey}: ${e.message}`);
    }
  }
}

export const testClient = async (): Promise<IClient> => {
  try {
    const client = await clientBuilder(
      initAuth.apiKey,
      initAuth.apiSecret,
      initAuth.walletPrivateKey
    );
    return client;
  } catch (e) {
    logger.error(
      `Failed to create client. Data: ${JSON.stringify(
        e.response ? e.response.data : e,
        null,
        2
      )}`
    );
  }
};
 */
