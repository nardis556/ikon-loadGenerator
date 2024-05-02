import mysql, { Connection, ConnectionOptions } from "mysql2/promise";
import dotenv from "dotenv";
import logger from "./logger";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const connectionOptions: ConnectionOptions = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
};

export class db {
  private connection: Connection | null = null;

  async connect(): Promise<void> {
    try {
      this.connection = await mysql.createConnection(connectionOptions);
      logger.debug("Successfully connected to the database.");
    } catch (error) {
      logger.error(`Error while connecting to the database: ${error}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      logger.debug("Connection to the database has been closed.");
    }
  }

  async write(query: string, values: any[]): Promise<void> {
    if (!this.connection) {
      throw new Error("Not connected to the database.");
    }

    try {
      await this.connection.query(query, values);
      logger.debug("Data has been written to the database successfully.");
    } catch (error) {
      logger.error(`Error while writing to the database: ${error}`);
      throw error;
    }
  }

  async writeToCreateOrder(
    datetime: string,
    wallet: string,
    orderId: string,
    // orderObject: object
  ): Promise<void> {
    const query = `
      INSERT INTO ${process.env.MYSQL_CREATE_ORDER_TABLE} (timestamp, wallet, orderId)
      VALUES (?, ?, ?);
    `;

    const values = [datetime, wallet, orderId];
    // const values = [datetime, wallet, orderId, JSON.stringify(orderObject)];

    await this.write(query, values);
  }

  async writeToErrorFromRetry(
    datetime: string,
    onRetry: number,
    object: object
  ): Promise<void> {
    const query = `
      INSERT INTO ${process.env.MYSQL_ERRORS_TABLE} (datetime, onRetry, errorObject)
      VALUES (?, ?);
    `;

    const values = [datetime, onRetry ,JSON.stringify(object)];
    // const values = [datetime, wallet, orderId, JSON.stringify(orderObject)];

    await this.write(query, values);
  }
}
