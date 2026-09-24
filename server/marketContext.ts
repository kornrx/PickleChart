import { ASSET_MAP, Candle, MarketSymbol, OrderBookState, RawTrade, Timeframe } from '../src/types/market';
import { CandleAggregator } from '../src/services/candleAggregator';
import { LiquidityEngine } from '../src/services/liquidityEngine';
import { TradeClusterEngine } from '../src/services/tradeClusterEngine';
import { Position } from './paperBroker';
import { BookImbalance, FlowStats, StrategyContext } from './strategy/types';

export interface MarketContextOptions {
  symbol: MarketSymbol;
  timeframe?: Timeframe;
  /** Rolling window the aggressor flow statistics are computed over. */
  flowWindowMs?: number;
  /** Trades older than this are dropped from the rolling tape. */
  tapeWindowMs?: number;
  onCandles?: (candles: Candle[]) => void;
}

/**
 * One symbol's analytical state, driven tick by tick.
 *
 * This is the same stack the chart runs on — `LiquidityEngine`,
 * `CandleAggregator` and `TradeClusterEngine` are imported straight from
 * `src/services`, so what the strategy reacts to is exactly what is drawn on
 * screen. Live trading and backtesting both go through here, which is what
 * keeps replayed results honest.
 */
export class MarketContext {
  readonly symbol: MarketSymbol;
  readonly tickSize: number;

  private liquidity: LiquidityEngine;
  private aggregator: CandleAggregator;
  private cluster: TradeClusterEngine;

  private book: OrderBookState | null = null;
  private tape: RawTrade[] = [];
  private lastPrice = 0;
  private lastTradeTs = 0;
  private flowWindowMs: number;
  private tapeWindowMs: number;

  constructor(opts: MarketContextOptions) {
    const asset = ASSET_MAP[opts.symbol];
    this.symbol = opts.symbol;
    this.tickSize = asset?.tickSize ?? 0.01;
    this.flowWindowMs = opts.flowWindowMs ?? 30_000;
    this.tapeWindowMs = opts.tapeWindowMs ?? 120_000;

    this.liquidity = new LiquidityEngine(this.tickSize);
    this.cluster = new TradeClusterEngine(asset?.defaultBigTradeThreshold ?? 2.0);
    this.aggregator = new CandleAggregator(opts.timeframe ?? '1s', (candles) => {
      this.liquidity.processCandles(candles);
      opts.onCandles?.(candles);
    });
  }

  /** Seed with REST history so the strategy is not blind for its first minutes. */
  seed(candles: Candle[], trades: RawTrade[]) {
    if (candles.length > 0) {
      this.aggregator.setCandles(candles);
      this.liquidity.processCandles(candles);
    }
    if (trades.length > 0) {
      this.cluster.setHistoricalTrades(trades);
      this.liquidity.setHistoricalTrades(trades);
      this.tape = trades.slice(-5000);
      const last = trades[trades.length - 1];
      this.lastPrice = last.price;
      this.lastTradeTs = last.time;
    }
  }

  onBook(book: OrderBookState) {
    this.book = book;
    this.liquidity.processOrderBook(book, this.lastPrice || undefined);
  }

  onTrade(trade: RawTrade) {
    this.lastPrice = trade.price;
    this.lastTradeTs = trade.time;
    this.aggregator.processTrade(trade);
    this.liquidity.processTrade(trade);
    this.cluster.processTrade(trade);

    this.tape.push(trade);
    const cutoff = trade.time - this.tapeWindowMs;
    if (this.tape.length > 200 && this.tape[0].time < cutoff) {
      this.tape = this.tape.filter((t) => t.time >= cutoff);
    }
  }

  getCandles(): Candle[] {
    return this.aggregator.getCandles();
  }

  getLastPrice(): number {
    return this.lastPrice;
  }

  getBook(): OrderBookState | null {
    return this.book;
  }

  /** Aggressor flow over the trailing window — the delta the tape panel shows. */
  computeFlow(now: number): FlowStats {
    const from = now - this.flowWindowMs;
    let buyVolume = 0;
    let sellVolume = 0;
    let tradeCount = 0;
    for (let i = this.tape.length - 1; i >= 0; i--) {
      const t = this.tape[i];
      if (t.time < from) break;
      if (t.side === 'buy') buyVolume += t.qty;
      else sellVolume += t.qty;
      tradeCount++;
    }
    const total = buyVolume + sellVolume;
    return {
      buyVolume,
      sellVolume,
      delta: buyVolume - sellVolume,
      deltaRatio: total > 0 ? (buyVolume - sellVolume) / total : 0,
      tradeCount,
      windowMs: this.flowWindowMs,
    };
  }

  computeImbalance(): BookImbalance | null {
    if (!this.book || this.book.bids.length === 0 || this.book.asks.length === 0) return null;
    const bidVolume = this.book.bids.reduce((s, l) => s + l.qty, 0);
    const askVolume = this.book.asks.reduce((s, l) => s + l.qty, 0);
    const total = bidVolume + askVolume;
    return {
      bidVolume,
      askVolume,
      ratio: total > 0 ? (bidVolume - askVolume) / total : 0,
      spread: this.book.bestAsk - this.book.bestBid,
      midPrice: (this.book.bestAsk + this.book.bestBid) / 2,
    };
  }

  buildContext(now: number, position: Position | undefined): StrategyContext {
    return {
      symbol: this.symbol,
      now,
      lastPrice: this.lastPrice,
      tickSize: this.tickSize,
      candles: this.aggregator.getCandles(),
      book: this.book,
      recentTrades: this.tape,
      bigTrades: this.cluster.getBigTrades(),
      limitWalls: this.liquidity.getLimitWalls(),
      liquidityPools: this.liquidity.getLiquidityPools(),
      sweptEvents: this.liquidity.getSweptEvents(),
      flow: this.computeFlow(now),
      imbalance: this.computeImbalance(),
      position,
    };
  }

  /** Wall clock is meaningless in replay; the strategy clock follows the tape. */
  getClock(): number {
    return this.lastTradeTs;
  }
}
