import winston from "winston";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import path from "path";
import fs from "fs";

const logsDir = path.resolve(__dirname, "../../logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const showLogs = process.env.SHOW_LOGS === "true";
const saveLogs = process.env.SAVE_LOGS === "true";
const logFilePath = path.join(logsDir, "output.log");

const customFormat = winston.format.printf(({ level, message, timestamp }) => {
  return `${level}: ${timestamp} -> ${message}`;
});

const customLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6
};

const logger = winston.createLogger({
  levels: customLevels,
  format: winston.format.combine(
    winston.format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    customFormat
  ),
  transports: [],
  silent: process.env.LOGGING === "disable",
});

const logLevel = process.env.LOGGING || "info";

if (showLogs) {
  logger.add(
    new winston.transports.Console({
      level: logLevel,
      format: winston.format.combine(winston.format.colorize(), customFormat),
    })
  );
}

if (saveLogs) {
  logger.add(
    new winston.transports.File({
      filename: logFilePath,
      level: logLevel,
      format: winston.format.combine(customFormat),
    })
  );
}

export default logger;
