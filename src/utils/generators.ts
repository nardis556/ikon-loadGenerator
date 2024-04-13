import * as idex from "@idexio/idex-sdk-ikon";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../.env.ORDERS") });

/**
 *
 * @param value value to generate random dust for 1
 * @param resolution resolution to generate dust for. e.g. "0.00000001" would be 8 decimals to randomize
 * @returns random dust value
 */

export function randomDust(value: number, resolution: string) {
  const valueParts = String(value).split(".");
  const valueInt = valueParts[0];
  let valueDec = valueParts[1] || "0";

  const stepSizeParts = resolution.split(".");
  const stepDec = stepSizeParts[1] || "0";
  const zeroCount = stepDec.length - stepDec.replace(/0+$/, "").length;

  if (zeroCount === 8) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const randInt = Math.floor(value) + Math.floor(Math.random() * magnitude);
    const result = randInt.toFixed(8);
    return result;
  }

  const nonZeroDecimals = stepDec.length - zeroCount;

  const maxRandom = 10 ** nonZeroDecimals;
  let randomDec = Math.floor(Math.random() * maxRandom);

  const randomDecStr = String(randomDec).padStart(nonZeroDecimals, "0");

  const resultDec = randomDecStr + "0".repeat(zeroCount);
  const result = parseFloat(valueInt + "." + resultDec);

  return result.toFixed(stepDec.length);
}

/**
 *
 * @param midPrice
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
  midPrice: number,
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
    triggerPriceFactor: parseFloat(process.env.TRIGGER_PRICE_FACTOR) || 0.01,
  };

  const limitOrderValidation =
    parseFloat(process.env.LIMIT_ORDER_VALIDATION) || 0.4;
  const lowerBound = midPrice * (1 - limitOrderValidation);
  const upperBound = midPrice * (1 / (1 - limitOrderValidation));

  const weightTotal =
    weights.limit + weights.market + weights.stopMarket + weights.stopLimit;

  for (let i = 0; i < iterations; i++) {
    const random = Math.random() * weightTotal;
    let adjustedPrice =
      midPrice + i * priceIncrement * (side === "sell" ? 1 : -1);

    if (side === "buy") {
      adjustedPrice = Math.max(lowerBound, Math.min(adjustedPrice, midPrice));
    } else {
      adjustedPrice = Math.min(upperBound, Math.max(adjustedPrice, midPrice));
    }

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
        side: side === "sell" ? "buy" : "sell",
        type: idex.OrderType.market,
        quantity: randomDust(quantity, quantityRes),
      };
    } else {
      const triggerPriceModifier = Math.random() > 0.5 ? 1 : -1;
      const triggerPrice =
        adjustedPrice +
        triggerPriceModifier * weights.triggerPriceFactor * adjustedPrice;

      if (random < weights.limit + weights.market + weights.stopMarket) {
        order = {
          market: market,
          side: side === "sell" ? "buy" : "sell",
          type:
            Math.random() > 0.5
              ? idex.OrderType.stopLossMarket
              : idex.OrderType.takeProfitMarket,
          quantity: randomDust(quantity, quantityRes),
          triggerPrice: randomDust(triggerPrice, priceRes),
          triggerType:
            Math.random() > 0.5
              ? idex.TriggerType.last
              : idex.TriggerType.index,
        };
      } else {
        order = {
          market: market,
          side: side,
          type:
            Math.random() > 0.5
              ? idex.OrderType.stopLossLimit
              : idex.OrderType.takeProfitLimit,
          quantity: randomDust(quantity, quantityRes),
          price: randomDust(adjustedPrice, priceRes),
          triggerPrice: randomDust(triggerPrice, priceRes),
          triggerType:
            Math.random() > 0.5
              ? idex.TriggerType.last
              : idex.TriggerType.index,
        };
      }
    }

    endpoints.push(order);
  }
  return endpoints;
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
