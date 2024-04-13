export interface AccountInfo {
  walletAddress: string;
  privateKey: string;
  apiKey: string;
  apiSecret: string;
}

export interface Account {
  [key: string]: AccountInfo;
}
