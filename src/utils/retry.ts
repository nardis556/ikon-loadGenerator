import logger from "./logger.ts";
import { setTimeout } from "timers/promises";
// import { db } from "./mysqlConnector.ts";

// const database = new db()

export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  delay: number = 1000
): Promise<T> {
  let error: Error | null | any = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.response) {
        error = e.response.data;
        // const datetime = new Date()
        //   .toISOString()
        //   .slice(0, 19)
        //   .replace("T", " ");
        // await database.writeToErrorFromRetry(datetime, i, error)
      } else if (e.code) {
        error = e.code;
      }
      logger.debug(
        `Attempt ${i + 1} of ${maxRetries} failed. Retrying in ${delay}ms.`
      );
      logger.error(JSON.stringify(error, null, 2));
      await setTimeout(delay);
    }
  }

  const datetime = new Date().toISOString().slice(0, 19).replace("T", " ");

  // await database.writeToErrorFromRetry(datetime, 9, error)

  logger.error(
    `Function failed after ${maxRetries} attempts. Last error: ${JSON.stringify(
      error,
      null,
      2
    )}`
  );
}
