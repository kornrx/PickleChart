import { OrderBookState, RawTrade } from '../src/types/market';
import { ClosedTrade, ExitReason, OrderRecord, OrderSide, Position } from '../src/types/trading';

export type {
  OrderSide, OrderType, OrderStatus, ExitReason, OrderRecord, Position, ClosedTrade,
} from '../src/types/trading';

export interface BrokerEvents {
  onOrder?: (o: OrderRecord) => void;
  onFill?: (o: OrderRecord, position: Position | null) => void;
  onClose?: (t: ClosedTrade) => void;
}

export interface FundingOptions {
  /**
   * Measured settlements in (after, upTo], oldest first.
   *
   * The schedule is read rather than assumed: Binance settles BTCUSDT every
   * eight hours but XAUUSDT every four, so a single interval would have
   * undercharged gold by half.
   */
  settlementsBetween?: (symbol: string, after: number, upTo: number) => Array<{ ts: number; rate: number }>;
  /** Fallback schedule when nothing has been collected for that symbol. */
  fallbackIntervalMs: number;
  /** Fallback rate per settlement, as a fraction of notional. */
  fallbackRate: number;
}

export interface PaperBrokerOptions {
  startingEquity: number;
  takerFeeBps: number;
  makerFeeBps: number;
  /** Price increment per symbol, used by the fill model. */
  tickSize?: Record<string, number>;
  /**
   * How far past a resting limit an aggressor must trade before it fills.
   *
   * Queue position is not modelled, and at the round numbers a grid likes there
   * are usually hundreds of orders ahead. Requiring price to trade *through*
   * the level, rather than merely touch it, is the cheap approximation: a touch
   * that bounces is assumed to have filled the queue in front and not us.
   */
  fillThroughTicks?: number;
  funding?: FundingOptions;
  events?: BrokerEvents;
}

interface RestingOrder extends OrderRecord {
  price: number;
  /** Set when the order is a bracket entry rather than a flat order. */
  bracket?: { stopLoss?: number; takeProfit?: number; entryReason?: string };
}

/**
 * Simulated execution against the real order book.
 *
 * Deliberately pessimistic: market orders walk the visible depth and pay the
 * taker fee, a stop that gaps fills at the gapped price rather than at the stop
 * level, and a resting limit order only fills once an aggressor actually trades
 * through it. Paper results that look good here are not being flattered by the
 * fill model — though real fills still differ, since the book we walk is a
 * 20-level snapshot and queue position is not modelled.
 */
export class PaperBroker {
  private opts: PaperBrokerOptions;
  private positions = new Map<string, Position>();
  private resting = new Map<string, RestingOrder[]>();
  private books = new Map<string, OrderBookState>();
  private lastPrice = new Map<string, number>();

  private realizedPnl = 0;
  private feesPaid = 0;
  private fundingPaid = 0;
  private lastFundingCheck = new Map<string, number>();
  private orderSeq = 0;
  private closedTrades: ClosedTrade[] = [];

  constructor(opts: PaperBrokerOptions) {
    this.opts = opts;
  }

  // --- state -------------------------------------------------------------

  get equity(): number {
    let unrealized = 0;
    for (const p of this.positions.values()) unrealized += p.unrealizedPnl;
    return this.opts.startingEquity + this.realizedPnl + unrealized;
  }

  get realized(): number {
    return this.realizedPnl;
  }

  get unrealized(): number {
    let sum = 0;
    for (const p of this.positions.values()) sum += p.unrealizedPnl;
    return sum;
  }

  get fees(): number {
    return this.feesPaid;
  }

  /** Total funding settled, a cost when positive. */
  get funding(): number {
    return this.fundingPaid;
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getPositions(): Position[] {
    return [...this.positions.values()];
  }

  getOpenPositionCount(): number {
    return this.positions.size;
  }

  getClosedTrades(): ClosedTrade[] {
    return this.closedTrades;
  }

  getRestingOrders(symbol?: string): RestingOrder[] {
    if (symbol) return this.resting.get(symbol) ?? [];
    return [...this.resting.values()].flat();
  }

  // --- market data ingestion --------------------------------------------

  updateBook(symbol: string, book: OrderBookState) {
    this.books.set(symbol, book);
  }

  /**
   * Drive the simulation forward on a real trade print: mark positions to
   * market, fill crossed limit orders, then check brackets. Bracket checks run
   * last so an entry and its stop cannot both trigger on the same tick.
   */
  onTrade(symbol: string, trade: RawTrade) {
    this.lastPrice.set(symbol, trade.price);
    this.settleFunding(symbol, trade);
    this.fillCrossedLimits(symbol, trade);
    this.mark(symbol, trade.price);
    this.checkBrackets(symbol, trade);
  }

  /**
   * Charge funding on every settlement the tape has passed.
   *
   * A grid holds inventory across settlements by design, so leaving this out
   * would quietly hand it free carry — exactly the kind of flattery a backtest
   * must not produce.
   */
  private settleFunding(symbol: string, trade: RawTrade) {
    const cfg = this.opts.funding;
    if (!cfg) return;

    const last = this.lastFundingCheck.get(symbol);
    this.lastFundingCheck.set(symbol, trade.time);
    if (last === undefined) return;

    const position = this.positions.get(symbol);
    if (!position) return;

    const settlements = cfg.settlementsBetween?.(symbol, last, trade.time) ?? [];
    const due = settlements.length > 0 ? settlements : this.syntheticSettlements(cfg, last, trade.time);

    for (const s of due) {
      const notional = position.qty * trade.price;
      // A positive rate is paid by longs to shorts.
      const cost = notional * s.rate * (position.direction === 'long' ? 1 : -1);
      position.fundingPaid += cost;
      this.fundingPaid += cost;
      this.realizedPnl -= cost;
    }
  }

  /** Used only for a symbol with no collected schedule. */
  private syntheticSettlements(cfg: FundingOptions, after: number, upTo: number) {
    const out: Array<{ ts: number; rate: number }> = [];
    const first = Math.floor(after / cfg.fallbackIntervalMs) + 1;
    const last = Math.floor(upTo / cfg.fallbackIntervalMs);
    for (let i = first; i <= last; i++) {
      out.push({ ts: i * cfg.fallbackIntervalMs, rate: cfg.fallbackRate });
    }
    return out;
  }

  private mark(symbol: string, price: number) {
    const p = this.positions.get(symbol);
    if (!p) return;
    p.markPrice = price;
    const dir = p.direction === 'long' ? 1 : -1;
    p.unrealizedPnl = (price - p.entryPrice) * p.qty * dir;
    p.maxFavorable = Math.max(p.maxFavorable, p.unrealizedPnl);
    p.maxAdverse = Math.min(p.maxAdverse, p.unrealizedPnl);
  }

  // --- order entry -------------------------------------------------------

  /**
   * Open a position at market. Returns the order record; status is `rejected`
   * when there is no book to fill against or a position is already open.
   */
  openMarket(params: {
    symbol: string;
    direction: 'long' | 'short';
    qty: number;
    ts: number;
    stopLoss?: number;
    takeProfit?: number;
    reason?: string;
  }): OrderRecord {
    const { symbol, direction, qty, ts } = params;
    const side: OrderSide = direction === 'long' ? 'buy' : 'sell';
    const order: OrderRecord = {
      id: this.nextOrderId(),
      symbol, ts, side, type: 'market', qty, status: 'rejected', fee: 0, reason: params.reason,
    };

    if (this.positions.has(symbol)) {
      order.reason = 'position already open';
      this.opts.events?.onOrder?.(order);
      return order;
    }

    const fill = this.walkBook(symbol, side, qty);
    if (fill == null) {
      order.reason = 'no book liquidity';
      this.opts.events?.onOrder?.(order);
      return order;
    }

    const fee = this.feeFor(fill.price * fill.qty, 'taker');
    order.status = 'filled';
    order.fillPrice = fill.price;
    order.qty = fill.qty;
    order.fee = fee;
    this.feesPaid += fee;
    this.realizedPnl -= fee; // debited immediately, so equity reflects cost from the moment of entry

    const position: Position = {
      symbol,
      direction,
      qty: fill.qty,
      entryPrice: fill.price,
      entryTs: ts,
      stopLoss: params.stopLoss,
      initialStopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      entryReason: params.reason,
      entryFee: fee,
      fundingPaid: 0,
      unrealizedPnl: 0,
      markPrice: fill.price,
      maxFavorable: 0,
      maxAdverse: 0,
    };
    this.positions.set(symbol, position);

    this.opts.events?.onOrder?.(order);
    this.opts.events?.onFill?.(order, position);
    return order;
  }

  /** Place a resting limit entry. It fills only when an aggressor trades through it. */
  openLimit(params: {
    symbol: string;
    direction: 'long' | 'short';
    qty: number;
    price: number;
    ts: number;
    stopLoss?: number;
    takeProfit?: number;
    reason?: string;
  }): OrderRecord {
    const side: OrderSide = params.direction === 'long' ? 'buy' : 'sell';
    const order: RestingOrder = {
      id: this.nextOrderId(),
      symbol: params.symbol,
      ts: params.ts,
      side,
      type: 'limit',
      qty: params.qty,
      price: params.price,
      status: 'resting',
      fee: 0,
      reason: params.reason,
      bracket: { stopLoss: params.stopLoss, takeProfit: params.takeProfit, entryReason: params.reason },
    };
    const list = this.resting.get(params.symbol) ?? [];
    list.push(order);
    this.resting.set(params.symbol, list);
    this.opts.events?.onOrder?.(order);
    return order;
  }

  cancelResting(symbol: string, orderId?: string) {
    const list = this.resting.get(symbol) ?? [];
    const keep: RestingOrder[] = [];
    for (const o of list) {
      if (orderId && o.id !== orderId) {
        keep.push(o);
        continue;
      }
      o.status = 'cancelled';
      this.opts.events?.onOrder?.(o);
    }
    this.resting.set(symbol, keep);
  }

  /** Close an open position at market. No-op when flat. */
  close(symbol: string, ts: number, reason: ExitReason, priceOverride?: number): ClosedTrade | null {
    const position = this.positions.get(symbol);
    if (!position) return null;

    const side: OrderSide = position.direction === 'long' ? 'sell' : 'buy';
    let exitPrice = priceOverride;
    if (exitPrice == null) {
      const fill = this.walkBook(symbol, side, position.qty);
      exitPrice = fill?.price ?? this.lastPrice.get(symbol) ?? position.markPrice;
    }

    const exitFee = this.feeFor(exitPrice * position.qty, 'taker');
    this.feesPaid += exitFee;

    const dir = position.direction === 'long' ? 1 : -1;
    const grossPnl = (exitPrice - position.entryPrice) * position.qty * dir;
    const fees = position.entryFee + exitFee;
    const netPnl = grossPnl - exitFee; // the entry fee was already debited at entry
    this.realizedPnl += netPnl;

    // Measured against the stop the trade was sized on, not a stop since moved
    // to break-even — otherwise every trailed winner reports an infinite R.
    const initialStop = position.initialStopLoss ?? position.stopLoss;
    const riskPerUnit = initialStop != null ? Math.abs(position.entryPrice - initialStop) : undefined;
    const riskTotal = riskPerUnit != null ? riskPerUnit * position.qty : undefined;

    const trade: ClosedTrade = {
      id: `t-${position.symbol}-${position.entryTs}`,
      symbol: position.symbol,
      direction: position.direction,
      qty: position.qty,
      entryTs: position.entryTs,
      exitTs: ts,
      entryPrice: position.entryPrice,
      exitPrice,
      stopLoss: initialStop,
      takeProfit: position.takeProfit,
      grossPnl,
      fees,
      funding: position.fundingPaid,
      netPnl: grossPnl - fees - position.fundingPaid,
      rMultiple: riskTotal && riskTotal > 0 ? (grossPnl - fees - position.fundingPaid) / riskTotal : undefined,
      exitReason: reason,
      entryReason: position.entryReason,
    };

    this.positions.delete(symbol);
    this.closedTrades.push(trade);

    const exitOrder: OrderRecord = {
      id: this.nextOrderId(),
      symbol, ts, side, type: 'market', qty: position.qty,
      fillPrice: exitPrice, status: 'filled', fee: exitFee, reason,
    };
    this.opts.events?.onOrder?.(exitOrder);
    this.opts.events?.onClose?.(trade);
    return trade;
  }

  closeAll(ts: number, reason: ExitReason) {
    for (const symbol of [...this.positions.keys()]) this.close(symbol, ts, reason);
  }

  // --- fill mechanics ----------------------------------------------------

  /**
   * Walk visible depth to get a size-weighted fill price. Returns null when the
   * book is empty; when depth runs out the remainder fills at the deepest
   * visible level, which understates slippage on very large orders.
   */
  private walkBook(symbol: string, side: OrderSide, qty: number): { price: number; qty: number } | null {
    const book = this.books.get(symbol);
    const levels = side === 'buy' ? book?.asks : book?.bids;
    if (!book || !levels || levels.length === 0) {
      const last = this.lastPrice.get(symbol);
      return last != null ? { price: last, qty } : null;
    }

    let remaining = qty;
    let notional = 0;
    let lastLevelPrice = levels[0].price;

    for (const level of levels) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, level.qty);
      notional += take * level.price;
      remaining -= take;
      lastLevelPrice = level.price;
    }
    if (remaining > 0) notional += remaining * lastLevelPrice;

    return { price: notional / qty, qty };
  }

  private fillCrossedLimits(symbol: string, trade: RawTrade) {
    const list = this.resting.get(symbol);
    if (!list || list.length === 0) return;

    const stillResting: RestingOrder[] = [];
    const through = (this.opts.fillThroughTicks ?? 0) * (this.opts.tickSize?.[symbol] ?? 0);
    for (const order of list) {
      // A buy limit needs a seller hitting down through it, and vice versa —
      // and price must clear the level, not merely reach it.
      const crossed =
        (order.side === 'buy' && trade.side === 'sell' && trade.price <= order.price - through) ||
        (order.side === 'sell' && trade.side === 'buy' && trade.price >= order.price + through);

      if (!crossed || this.positions.has(symbol)) {
        stillResting.push(order);
        continue;
      }

      const fee = this.feeFor(order.price * order.qty, 'maker');
      this.feesPaid += fee;
      this.realizedPnl -= fee;
      order.status = 'filled';
      order.fillPrice = order.price;
      order.fee = fee;

      const position: Position = {
        symbol,
        direction: order.side === 'buy' ? 'long' : 'short',
        qty: order.qty,
        entryPrice: order.price,
        entryTs: trade.time,
        stopLoss: order.bracket?.stopLoss,
        initialStopLoss: order.bracket?.stopLoss,
        takeProfit: order.bracket?.takeProfit,
        entryReason: order.bracket?.entryReason,
        entryFee: fee,
        fundingPaid: 0,
        unrealizedPnl: 0,
        markPrice: order.price,
        maxFavorable: 0,
        maxAdverse: 0,
      };
      this.positions.set(symbol, position);
      this.opts.events?.onOrder?.(order);
      this.opts.events?.onFill?.(order, position);
    }
    this.resting.set(symbol, stillResting);
  }

  private checkBrackets(symbol: string, trade: RawTrade) {
    const p = this.positions.get(symbol);
    if (!p || p.entryTs === trade.time) return; // never exit on the entry tick

    const price = trade.price;
    if (p.direction === 'long') {
      // Stop first: if a tick straddles both levels, assume the adverse one hit.
      if (p.stopLoss != null && price <= p.stopLoss) {
        this.close(symbol, trade.time, 'stop_loss', Math.min(price, p.stopLoss));
        return;
      }
      if (p.takeProfit != null && price >= p.takeProfit) {
        this.close(symbol, trade.time, 'take_profit', p.takeProfit);
      }
    } else {
      if (p.stopLoss != null && price >= p.stopLoss) {
        this.close(symbol, trade.time, 'stop_loss', Math.max(price, p.stopLoss));
        return;
      }
      if (p.takeProfit != null && price <= p.takeProfit) {
        this.close(symbol, trade.time, 'take_profit', p.takeProfit);
      }
    }
  }

  private feeFor(notional: number, kind: 'taker' | 'maker'): number {
    const bps = kind === 'taker' ? this.opts.takerFeeBps : this.opts.makerFeeBps;
    return Math.abs(notional) * (bps / 10_000);
  }

  private nextOrderId(): string {
    return `o-${++this.orderSeq}`;
  }
}
