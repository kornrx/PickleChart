import { ASSET_MAP, MarketSymbol, OrderBookState, RawTrade } from '../src/types/market';
import { ClosedTrade, EngineSnapshot, EngineStats, OrderRecord, StrategySignal } from '../src/types/trading';

export type { EngineSnapshot, EngineStats };
import { TradingConfig } from './config';
import { TradeDatabase } from './db';
import { MarketContext } from './marketContext';
import { PaperBroker } from './paperBroker';
import { RiskManager } from './riskManager';
import { Strategy } from './strategy/types';

export interface EngineEvents {
  onSnapshot?: (s: EngineSnapshot) => void;
  onOrder?: (o: OrderRecord) => void;
  onClose?: (t: ClosedTrade) => void;
  onSignal?: (s: StrategySignal, accepted: boolean, rejectedBy?: string) => void;
}

/**
 * Wires market data → strategy → risk → broker, and journals everything.
 *
 * Live trading and backtesting share this class; only the source of ticks
 * differs. Nothing here reads the wall clock — the caller supplies `now`, which
 * is what lets a replay run at full speed without changing strategy behaviour.
 */
export class TradingEngine {
  readonly runId: string;
  readonly mode: 'live-paper' | 'backtest';

  private cfg: TradingConfig;
  private strategy: Strategy;
  private broker: PaperBroker;
  private risk: RiskManager;
  private db: TradeDatabase | null;
  private events: EngineEvents;

  private contexts = new Map<string, MarketContext>();
  private recentOrders: OrderRecord[] = [];
  private recentSignals: Array<{ signal: StrategySignal; accepted: boolean; rejectedBy?: string }> = [];
  private signalsSeen = 0;
  private signalsTaken = 0;
  private lastEquityWrite = 0;
  private armed = true;

  constructor(params: {
    runId: string;
    mode: 'live-paper' | 'backtest';
    config: TradingConfig;
    strategy: Strategy;
    db?: TradeDatabase | null;
    events?: EngineEvents;
    /** Measured funding settlements by symbol, sorted by timestamp. */
    fundingRates?: Map<string, Array<{ ts: number; rate: number }>>;
  }) {
    this.runId = params.runId;
    this.mode = params.mode;
    this.cfg = params.config;
    this.strategy = params.strategy;
    this.db = params.db ?? null;
    this.events = params.events ?? {};

    const tickSize: Record<string, number> = {};
    for (const symbol of this.cfg.symbols) tickSize[symbol] = ASSET_MAP[symbol]?.tickSize ?? 0.01;

    this.broker = new PaperBroker({
      startingEquity: this.cfg.startingEquity,
      takerFeeBps: this.cfg.takerFeeBps,
      makerFeeBps: this.cfg.makerFeeBps,
      tickSize,
      fillThroughTicks: this.cfg.fillThroughTicks,
      funding: {
        fallbackIntervalMs: this.cfg.funding.fallbackIntervalMs,
        fallbackRate: this.cfg.funding.fallbackRate,
        settlementsBetween: (symbol, after, upTo) =>
          (params.fundingRates?.get(symbol) ?? []).filter((s) => s.ts > after && s.ts <= upTo),
      },
      events: {
        onOrder: (o) => this.handleOrder(o),
        onClose: (t) => this.handleClose(t),
      },
    });
    this.risk = new RiskManager(this.cfg.risk, this.cfg.startingEquity, this.cfg.takerFeeBps * 2);
  }

  registerContext(ctx: MarketContext) {
    this.contexts.set(ctx.symbol, ctx);
  }

  getContext(symbol: string): MarketContext | undefined {
    return this.contexts.get(symbol);
  }

  getBroker(): PaperBroker {
    return this.broker;
  }

  /** Stop opening new positions without tearing the run down. */
  setArmed(armed: boolean) {
    this.armed = armed;
  }

  isArmed(): boolean {
    return this.armed;
  }

  resetKillSwitch() {
    this.risk.resetKillSwitch();
    this.risk.update(this.broker.equity, Date.now());
  }

  // --- data in -----------------------------------------------------------

  onBook(symbol: MarketSymbol, book: OrderBookState) {
    this.contexts.get(symbol)?.onBook(book);
    this.broker.updateBook(symbol, book);
  }

  onTrade(symbol: MarketSymbol, trade: RawTrade) {
    this.contexts.get(symbol)?.onTrade(trade);
    // Broker second: brackets must be checked against the engine's updated view.
    this.broker.onTrade(symbol, trade);
  }

  // --- decision loop -----------------------------------------------------

  evaluate(now: number) {
    const equity = this.broker.equity;
    this.risk.update(equity, now);

    for (const [symbol, ctx] of this.contexts) {
      if (ctx.getLastPrice() <= 0) continue;
      const position = this.broker.getPosition(symbol);
      const sctx = ctx.buildContext(now, position);

      if (position) {
        const exit = this.strategy.evaluateExit?.(sctx);
        if (exit?.close) {
          this.broker.close(symbol, now, 'strategy_exit');
        } else if (exit?.newStopLoss != null) {
          position.stopLoss = exit.newStopLoss;
        }
        continue;
      }

      if (!this.armed) continue;

      const signal = this.strategy.evaluateEntry(sctx);
      if (!signal) continue;

      this.signalsSeen++;
      const decision = this.risk.evaluate(signal, {
        equity,
        openPositions: this.broker.getOpenPositionCount(),
        price: sctx.lastPrice,
        now,
      });

      this.recordSignal(signal, decision.approved, decision.rejectedBy);
      if (!decision.approved) continue;

      this.signalsTaken++;
      if (signal.entryType === 'limit' && signal.limitPrice != null) {
        this.broker.openLimit({
          symbol, direction: signal.direction, qty: decision.qty, price: signal.limitPrice,
          ts: now, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, reason: signal.reason,
        });
      } else {
        this.broker.openMarket({
          symbol, direction: signal.direction, qty: decision.qty,
          ts: now, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, reason: signal.reason,
        });
      }
    }

    // Equity curve at most once a second; ticks are far denser than that.
    if (this.db && now - this.lastEquityWrite >= 1000) {
      this.lastEquityWrite = now;
      this.db.insertEquityPoint(this.runId, now, this.broker.equity, this.broker.realized, this.broker.unrealized);
    }
  }

  // --- journalling -------------------------------------------------------

  private handleOrder(o: OrderRecord) {
    this.recentOrders.unshift(o);
    if (this.recentOrders.length > 100) this.recentOrders.pop();
    this.db?.insertOrder(this.runId, o);
    this.events.onOrder?.(o);
  }

  private handleClose(t: ClosedTrade) {
    this.risk.onTradeClosed(t);
    this.db?.insertClosedTrade(this.runId, t);
    this.events.onClose?.(t);
  }

  private recordSignal(signal: StrategySignal, accepted: boolean, rejectedBy?: string) {
    this.recentSignals.unshift({ signal, accepted, rejectedBy });
    if (this.recentSignals.length > 50) this.recentSignals.pop();
    this.db?.insertSignal(this.runId, signal, accepted, rejectedBy);
    this.events.onSignal?.(signal, accepted, rejectedBy);
  }

  // --- reporting ---------------------------------------------------------

  computeStats(): EngineStats {
    const trades = this.broker.getClosedTrades();
    const wins = trades.filter((t) => t.netPnl > 0);
    const losses = trades.filter((t) => t.netPnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
    const rTrades = trades.filter((t) => t.rMultiple != null);

    return {
      tradesClosed: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      avgR: rTrades.length > 0 ? rTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / rTrades.length : 0,
      maxDrawdown: this.risk.getState().drawdown,
      signalsSeen: this.signalsSeen,
      signalsTaken: this.signalsTaken,
    };
  }

  snapshot(now = Date.now()): EngineSnapshot {
    const lastPrices: Record<string, number> = {};
    for (const [symbol, ctx] of this.contexts) lastPrices[symbol] = ctx.getLastPrice();

    return {
      runId: this.runId,
      mode: this.mode,
      ts: now,
      equity: this.broker.equity,
      startingEquity: this.cfg.startingEquity,
      realized: this.broker.realized,
      unrealized: this.broker.unrealized,
      fees: this.broker.fees,
      funding: this.broker.funding,
      positions: this.broker.getPositions(),
      risk: this.risk.getState(),
      strategy: this.strategy.name,
      symbols: this.cfg.symbols,
      lastPrices,
      recentOrders: this.recentOrders.slice(0, 25),
      recentSignals: this.recentSignals.slice(0, 15),
      closedTrades: this.broker.getClosedTrades().slice(-25).reverse(),
      stats: this.computeStats(),
      armed: this.armed,
    };
  }
}
