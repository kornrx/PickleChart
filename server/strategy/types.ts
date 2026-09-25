import { BigTrade, Candle, MarketSymbol, OrderBookState, RawTrade } from '../../src/types/market';
import { LiquidityPool, RestingLimitWall, SweptOrderEvent } from '../../src/types/liquidity';
import { Position, StrategySignal } from '../../src/types/trading';

export type { StrategySignal };

export interface FlowStats {
  /** Aggressor volume over the rolling window, in base asset. */
  buyVolume: number;
  sellVolume: number;
  delta: number;
  /** delta / (buy + sell), in [-1, 1]. Positive means buyers are lifting offers. */
  deltaRatio: number;
  tradeCount: number;
  windowMs: number;
}

export interface BookImbalance {
  bidVolume: number;
  askVolume: number;
  /** (bid - ask) / (bid + ask) across the visible depth, in [-1, 1]. */
  ratio: number;
  spread: number;
  midPrice: number;
}

/** Everything a strategy is allowed to see on a single evaluation. */
export interface StrategyContext {
  symbol: MarketSymbol;
  now: number;
  lastPrice: number;
  tickSize: number;
  candles: Candle[];
  book: OrderBookState | null;
  recentTrades: RawTrade[];
  bigTrades: BigTrade[];
  limitWalls: RestingLimitWall[];
  liquidityPools: LiquidityPool[];
  sweptEvents: SweptOrderEvent[];
  flow: FlowStats;
  imbalance: BookImbalance | null;
  position: Position | undefined;
}

export interface ExitSignal {
  reason: string;
  /** Move the stop without closing — used for break-even and trailing logic. */
  newStopLoss?: number;
  close?: boolean;
}

export interface Strategy {
  readonly name: string;
  /** Minimum candle count before the strategy may fire. */
  readonly warmupCandles: number;
  /** Called only when flat. Return null to stand aside. */
  evaluateEntry(ctx: StrategyContext): StrategySignal | null;
  /** Called only when a position is open. Return null to hold. */
  evaluateExit?(ctx: StrategyContext): ExitSignal | null;
  /** Optional per-run parameter dump, journalled with the run config. */
  describe?(): Record<string, unknown>;
}
