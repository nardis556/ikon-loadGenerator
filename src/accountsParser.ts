import fs from "fs";
import path from "path";
import { AccountInfo, Account } from "./utils/IAaccounts.ts";
import logger from "./utils/logger.ts";

export function fetchAccounts(): Record<string, AccountInfo> {
  const filePath = path.resolve(__dirname, "../.env.ACCOUNTS");
  const fileContent = fs.readFileSync(filePath, "utf8");
  const lines = fileContent.split("\n");
  const accounts: Record<string, AccountInfo> = {};

  lines.forEach((line) => {
    if (line) {
      const [accountKey, data] = line.split("=");
      if (/^ACCOUNT\d+$/i.test(accountKey)) {
        const [walletAddress, privateKey, apiId, secretKey] = data.split(",");
        accounts[accountKey] = {
          walletAddress: walletAddress.trim(),
          privateKey: privateKey.trim(),
          apiKey: apiId.trim(),
          apiSecret: secretKey.trim(),
        };
        logger.info(`Processed ${accountKey} successfully.`);
      } else {
        logger.error(`Invalid account key format: ${accountKey}`);
      }
    }
  });
  logger.info("All accounts have been processed.");
  return accounts satisfies Account;
}
