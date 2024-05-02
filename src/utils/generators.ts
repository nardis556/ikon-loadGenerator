import * as idex from "@idexio/idex-sdk";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../.env.ORDERS") });

/**
 * PREVIOUS LOGIC
 * PREVIOUS LOGIC
 * PREVIOUS LOGIC
 * NOT VIABLE FOR PRICES THAT ARE 1 DIGIT INTEGERS
 */
export function randomDustQuantity(value: number, resolution: string) {
  const valueParts = String(value).split(".");
  const valueInt = valueParts[0];
  let valueDec = valueParts[1] || "0";

  const stepSizeParts = resolution.split(".");
  const stepDec = stepSizeParts[1] || "0";
  const zeroCount = stepDec.length - stepDec.replace(/0+$/, "").length;

  
  if (resolution === "10.00000000") {
    const decimalPlaces = resolution.split('.')[1].length;

    let valueInt = Math.floor(value);
    valueInt = valueInt - (valueInt % 10);

    const zeros = '0'.repeat(decimalPlaces);

    return `${valueInt}.${zeros}`;
  }


  if (zeroCount === 8) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const randInt = Math.floor(value) + Math.floor(Math.random() * magnitude);
    const result = randInt.toFixed(8);
    return result;
  }

  if (zeroCount < 3) {
    const decimalPlaces = resolution.split('.')[1].length;
    const fixedDecimals = resolution.indexOf('1') - 2;
    const randomizeDecimals = decimalPlaces - fixedDecimals;

    const valueString = value.toFixed(decimalPlaces);
    const fixedPart = valueString.substring(0, fixedDecimals + 2);
    const randomPart = Math.floor(Math.random() * (10 ** randomizeDecimals)).toString().padStart(randomizeDecimals, '0');

    return fixedPart + randomPart
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

  if (resolution === "0.00000100") {
    return Number(value.toFixed(6)).toFixed(8)
  }

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

  let resultDec = randomDecStr + "0".repeat(zeroCount);

  if (valueInt.length === 1 && nonZeroDecimals >= 3) {
    const thirdDecimal = parseInt(valueDec[2] || "0");
    let randomizedThird = Math.floor(Math.random() * (thirdDecimal + 1));
    resultDec =
      valueDec.substring(0, 2) +
      randomizedThird.toString() +
      "0".repeat(zeroCount + stepDec.length - 3);
  }

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
  takerOrderMinimum: number,
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

    let order: any = orderSelection(
      random,
      weights,
      market,
      side,
      quantity,
      quantityRes,
      adjustedPrice,
      priceRes,
      takerOrderMinimum
    );

    endpoints.push(order);
  }
  return endpoints;
}

function orderSelection(
  random: number,
  weights: {
    limit: number;
    market: number;
    stopMarket: number;
    stopLimit: number;
    triggerPriceFactor: number;
  },
  market: string,
  side: string,
  quantity: number,
  quantityRes: string,
  adjustedPrice: number,
  priceRes: string,
  takerOrderMinimum: number
) {
  let order: any;
  if (random < weights.limit) {
    order = {
      market: market,
      side: side,
      type: idex.OrderType.limit,
      quantity: randomDustQuantity(quantity, quantityRes),
      price: randomDust(adjustedPrice, priceRes),
    };
  } else if (random < weights.limit + weights.market) {
    order = {
      market: market,
      side: side === "sell" ? "buy" : "sell",
      type: idex.OrderType.market,
      quantity: randomDustQuantity(
        Number(takerOrderMinimum) *
        Number(process.env.QUANTITY_ALPHA_FACTOR) *
        (1 *
          (1 +
            Math.floor(
              Math.random() * Number(process.env.QUANTITY_BETA_FACTOR)
            ))),
        quantityRes
      ),
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
        quantity: randomDustQuantity(
          Number(takerOrderMinimum) *
          Number(process.env.QUANTITY_ALPHA_FACTOR) *
          (1 *
            (1 +
              Math.floor(
                Math.random() * Number(process.env.QUANTITY_BETA_FACTOR)
              ))),
          quantityRes
        ),
        triggerPrice: randomDust(triggerPrice, priceRes),
        triggerType:
          Math.random() > 0.5 ? idex.TriggerType.last : idex.TriggerType.index,
      };
    } else {
      order = {
        market: market,
        side: side,
        type:
          Math.random() > 0.5
            ? idex.OrderType.stopLossLimit
            : idex.OrderType.takeProfitLimit,
        quantity: randomDustQuantity(quantity, quantityRes),
        price: randomDust(adjustedPrice, priceRes),
        triggerPrice: randomDust(triggerPrice, priceRes),
        triggerType:
          Math.random() > 0.5 ? idex.TriggerType.last : idex.TriggerType.index,
      };
    }
  }
  return order;
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
