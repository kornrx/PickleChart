import { RiskConfig } from './config';
import { ClosedTrade, RiskState } from '../src/types/trading';

export type { RiskState };
import { StrategySignal } from './strategy/types';

/** Exchange quantity steps. Sizing is rounded down to these so orders stay valid. */
const QTY_STEP: Record<string, number> = {
  XAUUSDT: 0.01,
  BTCUSDT: 0.001,
  QQQUSDT: 0.01,
  SPYUSDT: 0.01,
};

export interface RiskDecision {
  approved: boolean;
  qty: number;
  /** Which gate turned the signal down, when it was not approved. */
  rejectedBy?: string;
  riskAmount?: number;
}

/**
 * The gate every signal passes through before it can reach the broker.
 *
 * Two separate brakes: a daily loss limit that resets at UTC midnight and lets
 * trading resume the next day, and a peak-to-trough drawdown kill switch that
 * stays latched for the rest of the run and must be cleared deliberately.
 */
export class RiskManager {
  private cfg: RiskConfig;
  private state: RiskState;
  private lastLossAt = new Map<string, number>();

  constructor(cfg: RiskConfig, startingEquity: number, now = Date.now()) {
    this.cfg = cfg;
    this.state = {
      killSwitch: false,
      peakEquity: startingEquity,
      dayAnchorEquity: startingEquity,
      dayKey: RiskManager.dayKey(now),
      dailyPnl: 0,
      drawdown: 0,
    };
  }

  getState(): RiskState {
    return { ...this.state };
  }

  private static dayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  /** Call on every equity update so the brakes see the current curve. */
  update(equity: number, now: number) {
    const key = RiskManager.dayKey(now);
    if (key !== this.state.dayKey) {
      this.state.dayKey = key;
      this.state.dayAnchorEquity = equity;
    }

    this.state.peakEquity = Math.max(this.state.peakEquity, equity);
    this.state.dailyPnl = equity - this.state.dayAnchorEquity;
    this.state.drawdown =
      this.state.peakEquity > 0 ? (this.state.peakEquity - equity) / this.state.peakEquity : 0;

    if (!this.state.killSwitch && this.state.drawdown >= this.cfg.maxDrawdown) {
      this.state.killSwitch = true;
      this.state.killReason = `drawdown ${(this.state.drawdown * 100).toFixed(1)}% >= limit ${(this.cfg.maxDrawdown * 100).toFixed(1)}%`;
    }
  }

  onTradeClosed(t: ClosedTrade) {
    if (t.netPnl < 0) this.lastLossAt.set(t.symbol, t.exitTs);
  }

  /** Clearing the kill switch is a deliberate act — nothing does it automatically. */
  resetKillSwitch() {
    this.state.killSwitch = false;
    this.state.killReason = undefined;
    this.state.peakEquity = 0;
  }

  evaluate(signal: StrategySignal, ctx: { equity: number; openPositions: number; price: number; now: number }): RiskDecision {
    if (this.state.killSwitch) {
      return { approved: false, qty: 0, rejectedBy: `kill switch: ${this.state.killReason ?? 'tripped'}` };
    }

    const dailyLossLimit = -Math.abs(this.cfg.maxDailyLoss * this.state.dayAnchorEquity);
    if (this.state.dailyPnl <= dailyLossLimit) {
      return { approved: false, qty: 0, rejectedBy: `daily loss limit (${this.state.dailyPnl.toFixed(2)} USDT)` };
    }

    if (ctx.openPositions >= this.cfg.maxOpenPositions) {
      return { approved: false, qty: 0, rejectedBy: `max open positions (${this.cfg.maxOpenPositions})` };
    }

    const lastLoss = this.lastLossAt.get(signal.symbol);
    if (lastLoss != null && ctx.now - lastLoss < this.cfg.cooldownMs) {
      const waitS = Math.ceil((this.cfg.cooldownMs - (ctx.now - lastLoss)) / 1000);
      return { approved: false, qty: 0, rejectedBy: `cooldown after loss (${waitS}s left)` };
    }

    const riskPerUnit = Math.abs(ctx.price - signal.stopLoss);
    if (riskPerUnit <= 0) {
      return { approved: false, qty: 0, rejectedBy: 'stop loss at entry price' };
    }

    const riskAmount = ctx.equity * this.cfg.riskPerTrade;
    let qty = riskAmount / riskPerUnit;

    // Never let a wide stop turn into an oversized notional.
    const maxQty = (ctx.equity * this.cfg.maxLeverage) / ctx.price;
    qty = Math.min(qty, maxQty);

    const step = QTY_STEP[signal.symbol] ?? 0.001;
    qty = Math.floor(qty / step) * step;
    qty = Number(qty.toFixed(8));

    if (qty <= 0) {
      return { approved: false, qty: 0, rejectedBy: 'size rounds to zero' };
    }
    if (qty * ctx.price < this.cfg.minNotional) {
      return { approved: false, qty: 0, rejectedBy: `below min notional (${this.cfg.minNotional} USDT)` };
    }

    return { approved: true, qty, riskAmount };
  }
}
