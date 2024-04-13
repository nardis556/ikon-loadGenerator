import * as idex from "@idexio/idex-sdk-ikon";

/**
 *
 * @param value value to generate random dust for 1
 * @param resolution resolution to generate dust for. e.g. "0.00000001" would be 8 decimals to randomize
 * @returns random dust value
 */

function randomDust(value: number, resolution: string) {
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

export function generateOrderTemplate(
  adjustedMidprice: number,
  iterations: number,
  increment: number,
  market: string,
  side: idex.OrderSide,
  quantity: number,
  quantityRes: string,
  priceRes: string
) {
  let endpoints = [];
  for (let i = 0; i < iterations; i++) {
    const adjustedPrice =
      adjustedMidprice + i * increment * (side === "sell" ? 1 : -1);
    const endpoint = {
      method: "createOrder",
      params: {
        wallet: null,
        market: market,
        side: side,
        type: "limit",
        quantity: randomDust(quantity, quantityRes),
        price: randomDust(adjustedPrice, priceRes),
      },
    };
    endpoints.push(endpoint);
  }
  return endpoints;
}

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
