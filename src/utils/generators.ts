import * as idex from "@idexio/idex-sdk";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../.env.ORDERS") });

function randomDustQuantity(
  values: number,
  resolution: string,
  market: string
  // type
) {
  let decimalsToKeep = 0;
  let percentageVariation = 20;
  let minFactor = 1;
  let value = values;
  // switch (type) {
  //   case "limit":
  //     value * 1.33333333;
  //     break;
  //   case "market":
  //     value = values;
  //     break;
  //   default:
  //     throw new Error("Unsupported order type");
  // }
  // switch (market) {
  //   case "BTC-USD":
  //     minFactor = 4;
  //   case "ETH-USD":
  //     minFactor = 3;
  //   case "IDEX-USD":
  //     minFactor = 3;
  //   case "SOL-USD":
  //     minFactor = 3;
  //     break;
  //   default:
  //     minFactor == minFactor;
  // }

  switch (resolution) {
    case "0.00000001":
      decimalsToKeep = 8;
      break;
    case "0.00000010":
      decimalsToKeep = 7;
      break;
    case "0.00000100":
      decimalsToKeep = 6;
      break;
    case "0.00001000":
      decimalsToKeep = 5;
      break;
    case "0.00010000":
      decimalsToKeep = 4;
      break;
    case "0.00100000":
      decimalsToKeep = 3;
      break;
    case "0.01000000":
      decimalsToKeep = 2;
      break;
    case "0.10000000":
      decimalsToKeep = 1;
      break;
    case "1.00000000":
      decimalsToKeep = 0;
      break;
    case "10.00000000":
      decimalsToKeep = -1;
      break;
    default:
      throw new Error("Unsupported resolution format");
  }

  const maxVariation = value * percentageVariation;

  let randomizedValue: number, variation: number;
  let attempts = 0;

  do {
    variation = Math.random() * (maxVariation * 2) - maxVariation;
    randomizedValue = value * (minFactor + variation / value);
  } while (randomizedValue < 0 || Math.abs(variation) > maxVariation);

  const factor = Math.pow(10, decimalsToKeep);
  const roundedValue = Math.floor(randomizedValue * factor) / factor;

  const result = roundedValue.toFixed(Math.max(decimalsToKeep, 0));

  return Number(result).toFixed(8);
}

function randomDust(value: number, resolution: string) {
  let decimalsToKeep = 0;
  let percentageVariation = 0.000011111;

  switch (resolution) {
    case "0.00000001":
      decimalsToKeep = 8;
      break;
    case "0.00000010":
      decimalsToKeep = 7;
      break;
    case "0.00000100":
      decimalsToKeep = 6;
      break;
    case "0.00001000":
      decimalsToKeep = 5;
      break;
    case "0.00010000":
      decimalsToKeep = 4;
      break;
    case "0.00100000":
      decimalsToKeep = 3;
      break;
    case "0.01000000":
      decimalsToKeep = 2;
      break;
    case "0.10000000":
      decimalsToKeep = 1;
      break;
    case "1.00000000":
      decimalsToKeep = 0;
      percentageVariation = 0.0005;
      break;
    case "10.00000000":
      percentageVariation = 0.0005;
      decimalsToKeep = -1;
      break;
    default:
      throw new Error("Unsupported resolution format");
  }

  const maxVariation = value * percentageVariation;

  const variation = Math.random() * (maxVariation * 2) - maxVariation;

  const randomizedValue = Math.max(0, value + variation);

  const factor = Math.pow(10, decimalsToKeep);
  const roundedValue = Math.floor(randomizedValue * factor) / factor;

  const result = roundedValue.toFixed(Math.max(decimalsToKeep, 0));

  return Number(Number(result).toFixed(Math.max(decimalsToKeep, 0))).toFixed(8);
}

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

    // TODO - move price variation depending on the side to this function isntead of index
    // ------ index already processes price variation from index depending on the side
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
      quantity: randomDustQuantity(
        Number(takerOrderMinimum) *
          ((1 + Math.random() * Number(process.env.QUANTITY_ALPHA_FACTOR)) *
            (1 + Math.random() * Number(process.env.QUANTITY_BETA_FACTOR))),
        quantityRes,
        market
      ),
      price: randomDust(adjustedPrice, priceRes),
      selfTradePrevention: "cb",
    };
  } else if (random < weights.limit + weights.market) {
    order = {
      market: market,
      side: side,
      type: idex.OrderType.market,
      quantity: randomDustQuantity(
        Number(takerOrderMinimum) *
          (1 + Math.random() * Number(process.env.QUANTITY_ALPHA_FACTOR)), //*
        // Number(process.env.QUANTITY_BETA_FACTOR),
        quantityRes,
        market
      ),
      selfTradePrevention: "cb",
    };
  } else {
    const triggerPriceModifier = Math.random() > 0.5 ? 1 : -1;
    const triggerPrice =
      adjustedPrice +
      triggerPriceModifier * weights.triggerPriceFactor * adjustedPrice;

    if (random < weights.limit + weights.market + weights.stopMarket) {
      order = {
        market: market,
        side: side,
        type:
          Math.random() > 0.5
            ? idex.OrderType.stopLossMarket
            : idex.OrderType.takeProfitMarket,
        quantity: randomDustQuantity(
          Number(takerOrderMinimum) *
            (1 + Math.random() * Number(process.env.QUANTITY_ALPHA_FACTOR)), //*
          // Number(process.env.QUANTITY_BETA_FACTOR),
          quantityRes,
          market
        ),
        triggerPrice: randomDust(triggerPrice, priceRes),
        triggerType:
          Math.random() > 0.5 ? idex.TriggerType.last : idex.TriggerType.index,
        selfTradePrevention: "cb",
      };
    } else {
      order = {
        market: market,
        side: side,
        type:
          Math.random() > 0.5
            ? idex.OrderType.stopLossLimit
            : idex.OrderType.takeProfitLimit,
        quantity: randomDustQuantity(
          Number(takerOrderMinimum) *
            ((1 + Math.random() * Number(process.env.QUANTITY_ALPHA_FACTOR)) *
              (1 + Math.random() * Number(process.env.QUANTITY_BETA_FACTOR))),
          quantityRes,
          market
        ),
        price: randomDust(adjustedPrice, priceRes),
        triggerPrice: randomDust(triggerPrice, priceRes),
        triggerType:
          Math.random() > 0.5 ? idex.TriggerType.last : idex.TriggerType.index,
        selfTradePrevention: "cb",
      };
    }
  }
  return order;
}
