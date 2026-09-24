import assert from 'node:assert/strict';
import { OrderBookState, RawTrade } from '../src/types/market';
import { PaperBroker } from './paperBroker';
import { RiskManager } from './riskManager';
import { DEFAULT_CONFIG } from './config';
import { StrategyContext, StrategySignal } from './strategy/types';
import { SweepReversalStrategy } from './strategy/sweepReversal';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function book(bids: Array<[number, number]>, asks: Array<[number, number]>, ts = 1_000): OrderBookState {
  return {
    timestamp: ts,
    bestBid: bids[0][0],
    bestAsk: asks[0][0],
    bids: bids.map(([price, qty]) => ({ price, qty })),
    asks: asks.map(([price, qty]) => ({ price, qty })),
    maxBidQty: Math.max(...bids.map((b) => b[1])),
    maxAskQty: Math.max(...asks.map((a) => a[1])),
  };
}

function tick(price: number, side: 'buy' | 'sell', time: number, qty = 0.1): RawTrade {
  return { id: `${time}`, time, price, qty, side };
}

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

function newBroker() {
  return new PaperBroker({ startingEquity: 10_000, takerFeeBps: 5, makerFeeBps: 2 });
}

console.log('\npaper broker');

test('market order walks the book for a size-weighted fill', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 10]], [[100, 1], [101, 1]]));
  const order = b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1.5, ts: 1_000 });
  assert.equal(order.status, 'filled');
  // (1 @ 100 + 0.5 @ 101) / 1.5
  near(order.fillPrice!, (100 + 0.5 * 101) / 1.5);
});

test('taker fee is charged on entry notional', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 10]], [[100, 10]]));
  const order = b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 2, ts: 1_000 });
  near(order.fee, 200 * 0.0005);
  near(b.fees, 200 * 0.0005);
});

test('a second entry on the same symbol is rejected', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 10]], [[100, 10]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_000 });
  const second = b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_100 });
  assert.equal(second.status, 'rejected');
  assert.equal(b.getOpenPositionCount(), 1);
});

test('position marks to market on each print', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 10]], [[100, 10]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 2, ts: 1_000 });
  b.onTrade('XAUUSDT', tick(105, 'buy', 2_000));
  near(b.getPosition('XAUUSDT')!.unrealizedPnl, 10); // (105 - 100) * 2
});

test('a gapping stop fills at the gap price, not at the stop level', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_000, stopLoss: 99 });
  b.onTrade('XAUUSDT', tick(97, 'sell', 2_000)); // straight through the stop
  const closed = b.getClosedTrades();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, 'stop_loss');
  near(closed[0].exitPrice, 97);
  assert.ok(closed[0].netPnl < -3, 'loss must include the gap and both fees');
});

test('take profit fills at the target level', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_000, stopLoss: 99, takeProfit: 102 });
  b.onTrade('XAUUSDT', tick(103, 'buy', 2_000));
  const t = b.getClosedTrades()[0];
  assert.equal(t.exitReason, 'take_profit');
  near(t.exitPrice, 102);
});

test('R multiple is measured against the risk taken at entry', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_000, stopLoss: 99, takeProfit: 102 });
  b.onTrade('XAUUSDT', tick(102, 'buy', 2_000));
  const t = b.getClosedTrades()[0];
  // 2 points of gross profit on 1 point of risk, less round-trip fees
  assert.ok(t.rMultiple! > 1.7 && t.rMultiple! < 2, `expected just under 2R, got ${t.rMultiple}`);
});

test('R survives a stop moved to break-even', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_000, stopLoss: 99, takeProfit: 102 });
  // The strategy trails the stop up to entry once the trade is onside.
  b.getPosition('XAUUSDT')!.stopLoss = 100;
  b.onTrade('XAUUSDT', tick(102, 'buy', 2_000));
  const t = b.getClosedTrades()[0];
  assert.equal(t.exitReason, 'take_profit');
  // Risk was 1 point at entry, so ~2R — not infinity from a zero-width stop.
  assert.ok(t.rMultiple! > 1.7 && t.rMultiple! < 2, `expected ~2R, got ${t.rMultiple}`);
});

test('shorts profit when price falls', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[100, 100]], [[101, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'short', qty: 1, ts: 1_000, takeProfit: 95 });
  b.onTrade('XAUUSDT', tick(94, 'sell', 2_000));
  const t = b.getClosedTrades()[0];
  assert.equal(t.direction, 'short');
  assert.ok(t.netPnl > 4, `expected ~5 USDT gross, got ${t.netPnl}`);
});

test('a resting limit does not fill until an aggressor trades through it', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openLimit({ symbol: 'XAUUSDT', direction: 'long', qty: 1, price: 98, ts: 1_000 });

  b.onTrade('XAUUSDT', tick(99, 'sell', 1_100)); // above the limit — no fill
  assert.equal(b.getOpenPositionCount(), 0);

  b.onTrade('XAUUSDT', tick(97, 'buy', 1_200)); // through the price but buyers lifting — no fill
  assert.equal(b.getOpenPositionCount(), 0);

  b.onTrade('XAUUSDT', tick(97, 'sell', 1_300)); // a seller hits down through it
  assert.equal(b.getOpenPositionCount(), 1);
  near(b.getPosition('XAUUSDT')!.entryPrice, 98);
});

test('limit fills pay the maker fee, not the taker fee', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openLimit({ symbol: 'XAUUSDT', direction: 'long', qty: 1, price: 98, ts: 1_000 });
  b.onTrade('XAUUSDT', tick(97, 'sell', 1_300));
  near(b.fees, 98 * 0.0002);
});

test('an entry cannot be stopped out on its own tick', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 2_000, stopLoss: 99 });
  b.onTrade('XAUUSDT', tick(98, 'sell', 2_000)); // same timestamp as the entry
  assert.equal(b.getOpenPositionCount(), 1);
});

test('equity tracks realized and unrealized pnl', () => {
  const b = newBroker();
  b.updateBook('XAUUSDT', book([[99, 100]], [[100, 100]]));
  b.openMarket({ symbol: 'XAUUSDT', direction: 'long', qty: 1, ts: 1_000 });
  b.onTrade('XAUUSDT', tick(110, 'buy', 2_000));
  near(b.equity, 10_000 + 10 - 100 * 0.0005);
  // The exit fills against the book, so the book has to move with the price.
  b.updateBook('XAUUSDT', book([[110, 100]], [[111, 100]], 3_000));
  b.close('XAUUSDT', 3_000, 'strategy_exit');
  assert.equal(b.getOpenPositionCount(), 0);
  assert.ok(b.realized > 9, 'realized pnl should carry the gain');
});

console.log('\nrisk manager');

const signal = (stopLoss: number): StrategySignal => ({
  symbol: 'XAUUSDT', ts: 1_000, direction: 'long', reason: 'test',
  stopLoss, takeProfit: 3_400, entryType: 'market',
});

test('size is set by risk per trade divided by stop distance', () => {
  const r = new RiskManager(DEFAULT_CONFIG.risk, 10_000);
  r.update(10_000, 1_000);
  // 0.5% of 10k = 50 USDT risk, 5 USDT stop distance → 10 units
  const d = r.evaluate(signal(3_295), { equity: 10_000, openPositions: 0, price: 3_300, now: 1_000 });
  assert.equal(d.approved, true);
  near(d.qty, 10);
});

test('size is capped by max leverage', () => {
  const r = new RiskManager(DEFAULT_CONFIG.risk, 10_000);
  r.update(10_000, 1_000);
  // A 0.01 stop would ask for 5,000 units; 5x leverage on 10k at 3,300 allows ~15.15
  const d = r.evaluate(signal(3_299.99), { equity: 10_000, openPositions: 0, price: 3_300, now: 1_000 });
  assert.ok(d.qty * 3_300 <= 10_000 * DEFAULT_CONFIG.risk.maxLeverage + 1, `notional ${d.qty * 3_300} exceeds cap`);
});

test('entries are refused at the max open position count', () => {
  const r = new RiskManager(DEFAULT_CONFIG.risk, 10_000);
  r.update(10_000, 1_000);
  const d = r.evaluate(signal(3_295), { equity: 10_000, openPositions: 2, price: 3_300, now: 1_000 });
  assert.equal(d.approved, false);
  assert.match(d.rejectedBy!, /max open positions/);
});

test('drawdown past the limit latches the kill switch', () => {
  const r = new RiskManager(DEFAULT_CONFIG.risk, 10_000);
  r.update(10_000, 1_000);
  r.update(8_000, 2_000); // -20%, past the 15% limit
  assert.equal(r.getState().killSwitch, true);
  const d = r.evaluate(signal(3_295), { equity: 8_000, openPositions: 0, price: 3_300, now: 2_000 });
  assert.equal(d.approved, false);
  assert.match(d.rejectedBy!, /kill switch/);
});

test('the daily loss limit blocks entries before the kill switch trips', () => {
  const r = new RiskManager({ ...DEFAULT_CONFIG.risk, maxDailyLoss: 0.02, maxDrawdown: 0.5 }, 10_000);
  r.update(10_000, 1_000);
  r.update(9_700, 2_000); // -3% on the day
  assert.equal(r.getState().killSwitch, false);
  const d = r.evaluate(signal(3_295), { equity: 9_700, openPositions: 0, price: 3_300, now: 2_000 });
  assert.equal(d.approved, false);
  assert.match(d.rejectedBy!, /daily loss/);
});

test('a losing trade starts a cooldown on that symbol', () => {
  const r = new RiskManager(DEFAULT_CONFIG.risk, 10_000);
  r.update(10_000, 1_000);
  r.onTradeClosed({
    id: 't1', symbol: 'XAUUSDT', direction: 'long', qty: 1,
    entryTs: 500, exitTs: 1_000, entryPrice: 3_300, exitPrice: 3_290,
    grossPnl: -10, fees: 1, netPnl: -11, exitReason: 'stop_loss',
  });
  const blocked = r.evaluate(signal(3_295), { equity: 10_000, openPositions: 0, price: 3_300, now: 30_000 });
  assert.equal(blocked.approved, false);
  assert.match(blocked.rejectedBy!, /cooldown/);

  const allowed = r.evaluate(signal(3_295), { equity: 10_000, openPositions: 0, price: 3_300, now: 70_000 });
  assert.equal(allowed.approved, true);
});

test('sub-minimum notional is refused', () => {
  const r = new RiskManager({ ...DEFAULT_CONFIG.risk, minNotional: 1_000_000 }, 10_000);
  r.update(10_000, 1_000);
  const d = r.evaluate(signal(3_295), { equity: 10_000, openPositions: 0, price: 3_300, now: 1_000 });
  assert.equal(d.approved, false);
  assert.match(d.rejectedBy!, /min notional/);
});

console.log('\nsweep-reversal strategy');

/** A long setup: sellers swept the lows, price reclaimed, buyers took over. */
function longSetupContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const now = 1_000_000;
  const sweepPrice = 3_300;
  return {
    symbol: 'XAUUSDT',
    now,
    lastPrice: 3_302,
    tickSize: 0.5,
    candles: Array.from({ length: 40 }, (_, i) => ({
      time: Math.floor((now - (40 - i) * 1000) / 1000),
      open: 3_301, high: 3_303, low: 3_299, close: 3_302, volume: 10,
    })),
    book: {
      timestamp: now, bestBid: 3_301.5, bestAsk: 3_302,
      bids: [{ price: 3_301.5, qty: 80 }], asks: [{ price: 3_302, qty: 20 }],
      maxBidQty: 80, maxAskQty: 20,
    },
    recentTrades: [
      { id: '1', time: now - 5_000, price: 3_298, qty: 5, side: 'sell' },
      { id: '2', time: now - 1_000, price: 3_302, qty: 5, side: 'buy' },
    ],
    bigTrades: [],
    limitWalls: [],
    liquidityPools: [
      { id: 'p1', price: 3_312, type: 'BSL', description: 'highs', time: now - 60_000,
        estimatedVolume: 100, isSwept: false, distance: 10 },
    ],
    sweptEvents: [
      { id: 's1', time: now - 5_000, price: sweepPrice, type: 'ssl_swept', volume: 50,
        notional: 165_000, aggressorSide: 'sell', reaction: 'absorbed_reversal', lowAfterSweep: 3_298 },
    ],
    flow: { buyVolume: 70, sellVolume: 30, delta: 40, deltaRatio: 0.4, tradeCount: 100, windowMs: 30_000 },
    imbalance: { bidVolume: 80, askVolume: 20, ratio: 0.6, spread: 0.5, midPrice: 3_301.75 },
    position: undefined,
    ...overrides,
  };
}

test('fires a long after a sell-side sweep is reclaimed with buyers in control', () => {
  const signal = new SweepReversalStrategy().evaluateEntry(longSetupContext());
  assert.ok(signal, 'expected a signal from a complete setup');
  assert.equal(signal!.direction, 'long');
  // Stop sits below the deepest price the sweep reached (3,298), plus buffer.
  assert.ok(signal!.stopLoss < 3_298, `stop ${signal!.stopLoss} must sit under the sweep extreme`);
  assert.equal(signal!.takeProfit, 3_312); // the un-swept BSL pool above
  assert.ok(signal!.detail!.targetFromPool === true);
});

test('mirrors the setup for shorts', () => {
  const ctx = longSetupContext({
    lastPrice: 3_298,
    sweptEvents: [{ id: 's2', time: 995_000, price: 3_300, type: 'bsl_swept', volume: 50,
      notional: 165_000, aggressorSide: 'buy', reaction: 'absorbed_reversal', highAfterSweep: 3_302 }],
    flow: { buyVolume: 30, sellVolume: 70, delta: -40, deltaRatio: -0.4, tradeCount: 100, windowMs: 30_000 },
    imbalance: { bidVolume: 20, askVolume: 80, ratio: -0.6, spread: 0.5, midPrice: 3_298 },
    liquidityPools: [{ id: 'p2', price: 3_288, type: 'SSL', description: 'lows', time: 940_000,
      estimatedVolume: 100, isSwept: false, distance: 10 }],
  });
  const signal = new SweepReversalStrategy().evaluateEntry(ctx);
  assert.ok(signal, 'expected a short signal');
  assert.equal(signal!.direction, 'short');
  assert.ok(signal!.stopLoss > 3_302, 'stop must sit above the sweep extreme');
  assert.equal(signal!.takeProfit, 3_288);
});

test('stands aside when price has not reclaimed the swept level', () => {
  const s = new SweepReversalStrategy();
  assert.equal(s.evaluateEntry(longSetupContext({ lastPrice: 3_299.5 })), null);
});

test('stands aside when the aggressor flow has not flipped', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    flow: { buyVolume: 50, sellVolume: 50, delta: 0, deltaRatio: 0.02, tradeCount: 100, windowMs: 30_000 },
  });
  assert.equal(s.evaluateEntry(ctx), null);
});

test('stands aside when the book is fighting the setup', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    imbalance: { bidVolume: 20, askVolume: 80, ratio: -0.6, spread: 0.5, midPrice: 3_301.75 },
  });
  assert.equal(s.evaluateEntry(ctx), null);
});

test('stands aside on a small sweep', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    sweptEvents: [{ id: 's3', time: 995_000, price: 3_300, type: 'ssl_swept', volume: 1,
      notional: 500, aggressorSide: 'sell', reaction: 'absorbed_reversal', lowAfterSweep: 3_298 }],
  });
  assert.equal(s.evaluateEntry(ctx), null);
});

test('stands aside when the target is too close to justify the risk', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    liquidityPools: [{ id: 'p3', price: 3_303, type: 'BSL', description: 'near highs', time: 940_000,
      estimatedVolume: 100, isSwept: false, distance: 1 }],
  });
  assert.equal(s.evaluateEntry(ctx), null); // ~1 point of reward against ~5.5 of risk
});

test('stands aside when the spread is too wide', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    imbalance: { bidVolume: 80, askVolume: 20, ratio: 0.6, spread: 5, midPrice: 3_301.75 },
  });
  assert.equal(s.evaluateEntry(ctx), null);
});

test('moves the stop to break-even once the trade is 1R onside', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    lastPrice: 3_310,
    position: {
      symbol: 'XAUUSDT', direction: 'long', qty: 1, entryPrice: 3_302, entryTs: 990_000,
      stopLoss: 3_297, takeProfit: 3_312, entryFee: 0, unrealizedPnl: 8,
      markPrice: 3_310, maxFavorable: 8, maxAdverse: 0,
    },
  });
  const exit = s.evaluateExit!(ctx);
  assert.equal(exit?.newStopLoss, 3_302);
  assert.ok(!exit?.close);
});

test('abandons a trade that has run past the max hold time', () => {
  const s = new SweepReversalStrategy();
  const ctx = longSetupContext({
    now: 990_000 + 20 * 60_000,
    position: {
      symbol: 'XAUUSDT', direction: 'long', qty: 1, entryPrice: 3_302, entryTs: 990_000,
      stopLoss: 3_297, takeProfit: 3_312, entryFee: 0, unrealizedPnl: 0,
      markPrice: 3_302, maxFavorable: 0, maxAdverse: 0,
    },
  });
  assert.equal(s.evaluateExit!(ctx)?.close, true);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}\n`);
