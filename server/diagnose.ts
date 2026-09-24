import { MarketSymbol, OrderBookState, RawTrade } from '../src/types/market';
import { loadConfig } from './config';
import { TradeDatabase } from './db';
import { MarketContext } from './marketContext';
import { SweepReversalStrategy } from './strategy/sweepReversal';

/**
 * Answers "why isn't the strategy firing?" by replaying stored ticks and
 * tallying which gate turned each evaluation down.
 *
 * It calls the strategy's own `explain`, so the counts always reflect the live
 * rules rather than a second copy of them.
 */

type ReplayEvent =
  | { kind: 'trade'; ts: number; trade: RawTrade }
  | { kind: 'book'; ts: number; book: OrderBookState };

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs();
const config = loadConfig();
if (args.db) config.db.path = args.db;
const symbol = (args.symbol?.toUpperCase() ?? config.symbols[0]) as MarketSymbol;

const db = new TradeDatabase(config.db.path);
const strategy = new SweepReversalStrategy();
const ctx = new MarketContext({ symbol, timeframe: '1s' });

const range = db.tradeRange(symbol);
if (!range) {
  console.log(`no stored ticks for ${symbol}`);
  process.exit(0);
}

const events: ReplayEvent[] = [
  ...db.readTrades(symbol).map((t): ReplayEvent => ({ kind: 'trade', ts: t.time, trade: t })),
  ...db.readBookSnapshots(symbol).map((b): ReplayEvent => ({ kind: 'book', ts: b.timestamp, book: b })),
].sort((a, b) => a.ts - b.ts || (a.kind === 'book' ? -1 : 1));

const blocked = new Map<string, number>();
let evaluations = 0;
let signals = 0;

// Sweep sizes actually seen, to sanity-check the notional floor.
const sweepNotionals: number[] = [];
const seenSweeps = new Set<string>();

let nextEval = events[0].ts;
for (const ev of events) {
  if (ev.kind === 'book') ctx.onBook(ev.book);
  else ctx.onTrade(ev.trade);
  if (ev.ts < nextEval) continue;
  nextEval = ev.ts + config.evalIntervalMs;

  const sctx = ctx.buildContext(ev.ts, undefined);
  for (const s of sctx.sweptEvents) {
    if (seenSweeps.has(s.id)) continue;
    seenSweeps.add(s.id);
    sweepNotionals.push(s.notional);
  }

  evaluations++;
  const { signal, blockedBy } = strategy.explain(sctx);
  if (signal) signals++;
  else blocked.set(blockedBy ?? 'unknown', (blocked.get(blockedBy ?? 'unknown') ?? 0) + 1);
}

const pct = (n: number) => `${((n / evaluations) * 100).toFixed(1)}%`;
const line = '─'.repeat(52);

console.log(`\n${line}`);
console.log(`GATE DIAGNOSIS  ${symbol}`);
console.log(line);
console.log(`window        ${new Date(range.from).toISOString()} → ${new Date(range.to).toISOString()}`);
console.log(`duration      ${((range.to - range.from) / 3_600_000).toFixed(2)} h`);
console.log(`evaluations   ${evaluations.toLocaleString()}`);
console.log(`signals       ${signals}`);
console.log(line);
for (const [reason, count] of [...blocked.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${reason.padEnd(24)} ${String(count).padStart(8)}  ${pct(count)}`);
}
console.log(line);

if (sweepNotionals.length > 0) {
  const sorted = [...sweepNotionals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  console.log(`sweeps detected   ${sorted.length}`);
  console.log(`notional p50      ${at(0.5).toFixed(0)} USDT`);
  console.log(`notional p90      ${at(0.9).toFixed(0)} USDT`);
  console.log(`notional max      ${sorted[sorted.length - 1].toFixed(0)} USDT`);
  console.log(`current floor     ${strategy.sweepFloorFor(symbol)} USDT`);
  console.log(`above floor       ${sorted.filter((n) => n >= strategy.sweepFloorFor(symbol)).length}`);
} else {
  console.log('sweeps detected   0  — the liquidity engine never flagged one');
}
console.log(`${line}\n`);

db.close();
