import * as idex from "@idexio/idex-sdk";
import { setTimeout } from "timers/promises";
import { wsClient, ExtendedIDEXMarket } from "../init";
import logger from "../utils/logger";

class WebSocketHandler {
  private ws: idex.WebSocketClient;
  private marketsSubscription: string[];
  private markets: ExtendedIDEXMarket[];
  private reconnectionAttempts: number = 0;
  private maxReconnectionAttempts: number = 1000;
  private isReconnecting: boolean = false;

  constructor(marketsSubscription: string[], markets: ExtendedIDEXMarket[]) {
    this.marketsSubscription = marketsSubscription;
    this.markets = markets;
  }

  async initWebSocket() {
    this.ws = await wsClient();
    this.setupEventListeners();
    await this.ws.connect();
    this.subscribe();
  }

  private setupEventListeners() {
    this.ws.onConnect(() => {
      this.reconnectionAttempts = 0;
      logger.info("WebSocket connected.");
    });

    this.ws.onMessage((message: any) => this.handleMessage(message));

    this.ws.onError(async (error) => this.handleError(error));

    this.ws.onDisconnect(async (e) => this.handleDisconnect(e));
  }

  private subscribe() {
    this.ws.subscribePublic(
      [
        {
          name: idex.SubscriptionName.l1orderbook,
        },
      ],
      this.marketsSubscription
    );
  }

  private async handleError(error: any) {
    logger.error(`WebSocket error: ${JSON.stringify(error, null, 2)}`);
    if (
      !this.isReconnecting &&
      this.reconnectionAttempts < this.maxReconnectionAttempts
    ) {
      this.isReconnecting = true;
      this.reconnectionAttempts++;
      await this.attemptReconnection();
    } else if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
      logger.error("Max reconnection attempts reached, stopping reconnection.");
    }
  }

  private async handleDisconnect(e: any) {
    logger.error(`WebSocket disconnected: ${JSON.stringify(e, null, 2)}`);
    if (
      !this.isReconnecting &&
      this.reconnectionAttempts < this.maxReconnectionAttempts
    ) {
      this.isReconnecting = true;
      this.reconnectionAttempts++;
      await this.attemptReconnection();
    }
  }

  private async attemptReconnection() {
    await setTimeout(1000 * this.reconnectionAttempts);
    await this.ws.connect();
    this.subscribe();
    this.isReconnecting = false;
  }

  private handleMessage(message: any) {
    if (message.type === idex.SubscriptionName.l1orderbook) {
      this.markets.forEach((market) => {
        if (
          `${market.baseAsset}-${market.quoteAsset}` === message.data.market
        ) {
          market.indexPrice = message.data.indexPrice;
          market.wsIndexPrice = message.data.indexPrice;
          market.bestAsk = message.data.askPrice;
          market.bestBid = message.data.bidPrice;
          market.bestPrice = this.calculateBestPrice(
            market.bestAsk,
            market.bestBid,
            market.wsIndexPrice
          );
        }
      });
    }
  }
  private calculateBestPrice(
    bestAsk: string,
    bestBid: string,
    indexPrice: string
  ) {
    const parsedBestBid = Number(bestBid) || 0;
    const parsedBestAsk = Number(bestAsk) || 0;
    const parsedIndexPrice = Number(indexPrice);

    const bidWeight = Number(process.env.BEST_BID_WEIGHT) || 0.25;
    const askWeight = Number(process.env.BEST_ASK_WEIGHT) || 0.25;
    const indexWeight = Number(process.env.INDEX_PRICE_WEIGHT) || 0.5;

    if (parsedBestBid === 0 && parsedBestAsk === 0) {
      return parsedIndexPrice.toFixed(8);
    }

    let totalWeight = indexWeight;
    let totalValue = indexWeight * parsedIndexPrice;

    if (parsedBestBid > 0) {
      totalWeight += bidWeight;
      totalValue += bidWeight * parsedBestBid;
    }

    if (parsedBestAsk > 0) {
      totalWeight += askWeight;
      totalValue += askWeight * parsedBestAsk;
    }

    return (totalValue / totalWeight).toFixed(8);
  }
}
