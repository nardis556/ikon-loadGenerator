import * as idex from "@idexio/idex-sdk-ikon";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../.env.MARKETS") });

/**
 *
 * @param value value to generate random dust for 1
 * @param resolution resolution to generate dust for. e.g. "0.00000001" would be 8 decimals to randomize
 * @returns random dust value
 */

export function randomDust(value: number, resolution: string) {
  const valueParts = String(value).split(".");
  const valueInt = valueParts[0];
  const valueDec = valueParts[1] || "0";

  const stepSizeParts = resolution.split(".");
  const stepDec = stepSizeParts[1] || "0";
  const zeroCount = stepDec.length - stepDec.replace(/0+$/, "").length;

  if (zeroCount === 8) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const randInt = Math.floor(value) + Math.floor(Math.random() * magnitude);
    const result = randInt.toFixed(8);
    return result;
  }

  const nonZeroDecimals = 8 - zeroCount;
  const fixedDec = valueDec.slice(0, nonZeroDecimals - 1);

  let dust = Math.floor(
    Math.random() * 10 ** (nonZeroDecimals - fixedDec.length)
  );
  while (dust === 0) {
    dust = Math.floor(
      Math.random() * 10 ** (nonZeroDecimals - fixedDec.length)
    );
  }

  const dustString = String(dust).padStart(
    nonZeroDecimals - fixedDec.length,
    "0"
  );

  const trailingZeros = "0".repeat(zeroCount);

  const result = valueInt + "." + fixedDec + dustString + trailingZeros;
  return Math.max(0, parseFloat(result)).toFixed(8);
}

/**
 *
 * @param adjustedMidprice
 * @param quantity
 * @param quantityRes
 * @param priceRes
 * @param iterations
 * @param priceIncrement
 * @param market
 * @param side
 * @returns
 */
export function generateOrderTemplate(
  adjustedMidprice: number,
  quantity: number,
  quantityRes: string,
  priceRes: string,
  iterations: number,
  priceIncrement: number,
  market: string,
  side: idex.OrderSide
) {
  let endpoints = [];

  const weights = {
    limit: parseInt(process.env.LIMIT_ORDER_FACTOR, 10) || 90,
    market: parseInt(process.env.MARKET_ORDER_FACTOR, 10) || 3,
    stopMarket: parseInt(process.env.STOP_MARKET_ORDER_FACTOR, 10) || 3,
    stopLimit: parseInt(process.env.STOP_LIMIT_ORDER_FACTOR, 10) || 3,
  };

  const weightTotal =
    weights.limit + weights.market + weights.stopMarket + weights.stopLimit;

  for (let i = 0; i < iterations; i++) {
    const random = Math.random() * weightTotal;
    const adjustedPrice =
      adjustedMidprice + i * priceIncrement * (side === "sell" ? 1 : -1);

    let order: any;
    if (random < weights.limit) {
      order = {
        market: market,
        side: side,
        type: idex.OrderType.limit,
        quantity: randomDust(quantity, quantityRes),
        price: randomDust(adjustedPrice, priceRes),
      };
    } else if (random < weights.limit + weights.market) {
      order = {
        market: market,
        side: side,
        type: idex.OrderType.market,
        quantity: randomDust(quantity, quantityRes),
      };
    } else if (random < weights.limit + weights.market + weights.stopMarket) {
      order = {
        market: market,
        side: side,
        type: idex.OrderType.stopLossMarket,
        quantity: randomDust(quantity, quantityRes),
      };
    } else {
      order = {
        market: market,
        side: side,
        type: idex.OrderType.stopLossLimit,
        quantity: randomDust(quantity, quantityRes),
        price: randomDust(adjustedPrice, priceRes),
      };
    }

    endpoints.push(order);
  }
  return endpoints;
}

/**
 *
 * @param side
 * @param midprice
 * @param slippage
 * @returns
 */
export function adjustedMidprice(
  side: idex.OrderSide,
  midprice: string,
  slippage: number
) {
  let midPrice = parseFloat(midprice);
  return side === "buy"
    ? midPrice * slippage
    : midprice + midPrice * (1 - slippage);
}

/**
 *
 * @param min
 * @param max
 * @returns
 */
export function getRandomNumber(min: number, max: number) {
  if (min > max) {
    [min, max] = [max, min];
  }
  return Math.random() * (max - min) + min;
}