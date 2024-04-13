import logger from "./logger.ts";
import { setTimeout } from "timers/promises";

export async function retry<T>(
  fn: () => Promise<T>,
  exitOnFail: boolean = false,
  maxRetries: number = 5,
  delay: number = 1000
): Promise<T> {
  let error: Error | null | any = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.response) {
        error = e.response.data;
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

  throw new Error(
    `Function failed after ${maxRetries} attempts. Last error: ${JSON.stringify(
      error,
      null,
      2
    )}`
  );
}
