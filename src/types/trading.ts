import { MarketSymbol } from './market';

/**
 * Wire format between the paper-trading server and this UI.
 *
 * Both sides import these, so a change to the protocol breaks the typecheck
 * instead of silently producing a panel that renders stale or missing fields.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'filled' | 'resting' | 'cancelled' | 'rejected';
export type ExitReason = 'stop_loss' | 'take_profit' | 'strategy_exit' | 'kill_switch' | 'session_end';
export type TradeDirection = 'long' | 'short';

export interface OrderRecord {
  id: string;
  symbol: string;
  ts: number;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  fillPrice?: number;
  status: OrderStatus;
  fee: number;
  reason?: string;
}

export interface Position {
  symbol: string;
  direction: TradeDirection;
  qty: number;
  entryPrice: number;
  entryTs: number;
  stopLoss?: number;
  /** The stop as it stood at entry. Kept so R survives break-even and trailing moves. */
  initialStopLoss?: number;
  takeProfit?: number;
  entryReason?: string;
  entryFee: number;
  /** Funding paid (positive) or received (negative) while this position has been open. */
  fundingPaid: number;
  unrealizedPnl: number;
  markPrice: number;
  maxFavorable: number;
  maxAdverse: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  direction: TradeDirection;
  qty: number;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  grossPnl: number;
  fees: number;
  /** Funding settled over the life of the trade; a cost when positive. */
  funding: number;
  netPnl: number;
  rMultiple?: number;
  exitReason: ExitReason;
  entryReason?: string;
}

export interface StrategySignal {
  symbol: MarketSymbol;
  ts: number;
  direction: TradeDirection;
  reason: string;
  stopLoss: number;
  takeProfit: number;
  confidence?: number;
  entryType: OrderType;
  limitPrice?: number;
  detail?: Record<string, unknown>;
}

export interface RiskState {
  killSwitch: boolean;
  killReason?: string;
  peakEquity: number;
  dayAnchorEquity: number;
  dayKey: string;
  dailyPnl: number;
  drawdown: number;
}

export interface EngineStats {
  tradesClosed: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  maxDrawdown: number;
  signalsSeen: number;
  signalsTaken: number;
}

export interface EngineSnapshot {
  runId: string;
  mode: 'live-paper' | 'backtest';
  ts: number;
  equity: number;
  startingEquity: number;
  realized: number;
  unrealized: number;
  fees: number;
  funding: number;
  positions: Position[];
  risk: RiskState;
  strategy: string;
  symbols: MarketSymbol[];
  lastPrices: Record<string, number>;
  recentOrders: OrderRecord[];
  recentSignals: Array<{ signal: StrategySignal; accepted: boolean; rejectedBy?: string }>;
  closedTrades: ClosedTrade[];
  stats: EngineStats;
  /** True while the strategy is allowed to open new positions. */
  armed: boolean;
}

/** Commands the UI may send back over the same socket. */
export type TradingCommand = 'arm' | 'disarm' | 'flatten' | 'reset_kill_switch';
