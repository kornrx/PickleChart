import { MarketSymbol } from '../src/types/market';

/** Everything the paper-trading stack is allowed to touch lives here. */
export interface TradingConfig {
  /** Symbols the collector subscribes to and the strategy may trade. */
  symbols: MarketSymbol[];
  /** Starting paper equity in USDT. */
  startingEquity: number;
  /** Binance USDⓈ-M VIP0 fees. Taker crosses the spread, maker rests in the book. */
  takerFeeBps: number;
  makerFeeBps: number;
  /** How often the strategy is evaluated, in ms. Ticks arrive far faster than this. */
  evalIntervalMs: number;
  /** Order-book snapshots are heavy; store at most one per symbol per interval. */
  bookSnapshotIntervalMs: number;
  /** How many ticks past a resting limit an aggressor must trade before it fills. */
  fillThroughTicks: number;
  funding: {
    /**
     * Schedule used only when no measured settlements exist for a symbol.
     * Real schedules differ per symbol — BTCUSDT every 8h, XAUUSDT every 4 —
     * so run `npm run fetch-funding` and let the measured table take over.
     */
    fallbackIntervalMs: number;
    /** Fallback rate per settlement, as a fraction of notional. */
    fallbackRate: number;
  };
  risk: RiskConfig;
  db: { path: string };
  ws: { port: number };
}

export interface RiskConfig {
  /** Fraction of equity risked between entry and stop on a single trade. */
  riskPerTrade: number;
  /** Hard cap on notional as a multiple of equity (paper leverage ceiling). */
  maxLeverage: number;
  /** No more than this many positions open at once, across all symbols. */
  maxOpenPositions: number;
  /** Realised loss in a UTC day, as a fraction of the day's opening equity, that halts new entries. */
  maxDailyLoss: number;
  /** Peak-to-trough equity drawdown that trips the kill switch for the rest of the run. */
  maxDrawdown: number;
  /** Reject entries whose notional falls under the exchange minimum. */
  minNotional: number;
  /** Cool-off after a losing trade before the same symbol may be re-entered. */
  cooldownMs: number;
  /**
   * Expected profit must be at least this multiple of the round-trip fee.
   * Without it, a tight stop plus the leverage cap produces trades whose cost
   * dwarfs the risk taken — mathematically unwinnable regardless of edge.
   */
  minRewardToFee: number;
  /**
   * Smallest share of the intended risk a capped trade may still carry. The
   * leverage cap shrinks size but not notional, so fees stay at full size while
   * risk falls; below this share the trade is no longer the one the strategy
   * asked for. A mild trim is fine — a collapse to a few percent is not.
   */
  minRiskAfterCap: number;
}

export const DEFAULT_CONFIG: TradingConfig = {
  symbols: ['XAUUSDT', 'BTCUSDT'],
  startingEquity: 10_000,
  takerFeeBps: 5,
  makerFeeBps: 2,
  evalIntervalMs: 250,
  bookSnapshotIntervalMs: 1_000,
  fillThroughTicks: 1,
  funding: { fallbackIntervalMs: 8 * 3_600_000, fallbackRate: 0.0001 },
  risk: {
    riskPerTrade: 0.005,
    maxLeverage: 5,
    maxOpenPositions: 2,
    maxDailyLoss: 0.03,
    maxDrawdown: 0.15,
    minNotional: 5,
    cooldownMs: 60_000,
    minRewardToFee: 1.5,
    minRiskAfterCap: 0.5,
  },
  db: { path: 'data/picklechart.db' },
  ws: { port: 8787 },
};

/** Env overrides, so a run can be retuned without editing the file. */
export function loadConfig(): TradingConfig {
  const c: TradingConfig = structuredClone(DEFAULT_CONFIG);
  const num = (v: string | undefined, fallback: number) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  if (process.env.PC_SYMBOLS) {
    c.symbols = process.env.PC_SYMBOLS.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean) as MarketSymbol[];
  }
  c.startingEquity = num(process.env.PC_EQUITY, c.startingEquity);
  c.risk.riskPerTrade = num(process.env.PC_RISK_PER_TRADE, c.risk.riskPerTrade);
  c.risk.maxDailyLoss = num(process.env.PC_MAX_DAILY_LOSS, c.risk.maxDailyLoss);
  c.risk.maxDrawdown = num(process.env.PC_MAX_DRAWDOWN, c.risk.maxDrawdown);
  c.risk.minRewardToFee = num(process.env.PC_MIN_REWARD_TO_FEE, c.risk.minRewardToFee);
  c.fillThroughTicks = num(process.env.PC_FILL_THROUGH_TICKS, c.fillThroughTicks);
  c.funding.fallbackRate = num(process.env.PC_FUNDING_RATE, c.funding.fallbackRate);
  c.db.path = process.env.PC_DB ?? c.db.path;
  c.ws.port = num(process.env.PC_WS_PORT, c.ws.port);

  return c;
}
