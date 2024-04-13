import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.MARKETS") });
import { clientBuilder } from "./utils/clientBuilder.ts";
import logger from "./utils/logger.ts";
import { IDEXMarket } from "@idexio/idex-sdk-ikon";

const initAuth = {
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
};

const envMarkets = process.env.MARKETS ? process.env.MARKETS.split(",") : [];

const fetchMarkets = async (): Promise<IDEXMarket[]> => {
  try {
    const client = await clientBuilder(
      initAuth.apiKey,
      initAuth.apiSecret,
      initAuth.walletPrivateKey
    );
    const markets = await client.client.public.getMarkets();

    const filteredMarkets = markets.filter((market) =>
      envMarkets.includes(`${market.baseAsset}-${market.quoteAsset}`)
    );

    const marketSymbols = filteredMarkets.map(
      (market) => `\n${market.baseAsset}-${market.quoteAsset}`
    );
    logger.info(`Fetched ${marketSymbols}\nmarkets.`);
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
    process.exit(1);
  }
};

export default {
  fetchMarkets,
};

fetchMarkets().catch(console.error);
