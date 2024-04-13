import * as idex from "@idexio/idex-sdk-ikon";
import { v1 as uuidv1 } from "uuid";
import logger from "./logger.ts";
const ethers = require("ethers");
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const env: any = process.env;

let hasEnv = true;

const ENV_VARS: any = [
  "WALLET_PRIVATE_KEY",
  "API_KEY",
  "API_SECRET",
  "BASE_URL",
  "EXCHANGE_CONTRACT",
  "CHAIN_ID",
  "SANDBOX",
  "WSS",
];

for (let i = 0; i < ENV_VARS.length; i++) {
  if (!env[ENV_VARS[i]]) {
    logger.debug(`Missing env var: ${ENV_VARS[i]}`);
    hasEnv = false;
  }
}

if (!hasEnv) {
  logger.error(
    "Missing required env vars, please update your .env file with the missing values. If env vars is already set, please cd to `src` and rerun the script."
  );
  process.exit(1);
}

const chainIdToNum: number = Number(env.CHAIN_ID);
const sandboxToBool: boolean = env.SANDBOX === "true";

export interface IClient {
  client: idex.RestAuthenticatedClient;
  wallet: {
    wallet: string;
    nonce: string;
  };
}

export const clientBuilder = async (
  apiKey: string,
  apiSecret: string,
  walletPrivateKey: string
): Promise<IClient> => {
  const client = new idex.RestAuthenticatedClient({
    apiKey: apiKey,
    apiSecret: apiSecret,
    walletPrivateKey: walletPrivateKey,
    baseURL: process.env.BASE_URL,
    chainId: chainIdToNum,
    sandbox: sandboxToBool,
    exchangeContractAddress: process.env.EXCHANGE_CONTRACT_ADDRESS,
  });

  const wallet = {
    wallet: ethers.computeAddress(walletPrivateKey),
    get nonce() {
      return uuidv1();
    },
  };

  return {
    client,
    wallet: {
      wallet: wallet.wallet,
      nonce: wallet.nonce,
    },
  } satisfies IClient;
};
