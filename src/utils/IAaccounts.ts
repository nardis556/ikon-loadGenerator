import * as idex from "@idexio/idex-sdk"

export interface AccountInfo {
  walletAddress: string;
  privateKey: string;
  apiKey: string;
  apiSecret: string;
}

export interface Account {
  [key: string]: AccountInfo;
}

export interface IClient {
  RestAuthenticatedClient: idex.RestAuthenticatedClient;
  RestPublicClient: idex.RestPublicClient;
  getWalletAndNonce: {
    wallet: string;
    nonce: string;
  };
}