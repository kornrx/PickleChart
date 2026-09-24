import { MarketSymbol, OrderBookState, RawTrade } from '../src/types/market';
import { loadConfig } from './config';
import { TradeDatabase } from './db';
import { MarketContext } from './marketContext';
import { TradingEngine } from './tradingEngine';
import { SweepReversalStrategy } from './strategy/sweepReversal';

interface Args {
  symbols?: string;
  from?: string;
  to?: string;
  equity?: string;
  db?: string;
}

function parseArgs(): Args {
  const out: Args = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) (out as Record<string, string>)[m[1]] = m[2];
  }
  return out;
}

type ReplayEvent =
  | { kind: 'trade'; symbol: MarketSymbol; ts: number; trade: RawTrade }
  | { kind: 'book'; symbol: MarketSymbol; ts: number; book: OrderBookState };

function toMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : fallback;
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function main() {
  const args = parseArgs();
  const config = loadConfig();
  if (args.db) config.db.path = args.db;
  if (args.equity) config.startingEquity = Number(args.equity);
  if (args.symbols) config.symbols = args.symbols.split(',').map((s) => s.trim().toUpperCase()) as MarketSymbol[];

  const db = new TradeDatabase(config.db.path);
  const runId = `bt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const strategy = new SweepReversalStrategy();

  // Collect every stored tick and snapshot in the window, then replay in time order.
  const events: ReplayEvent[] = [];
  const perSymbol: Array<{ symbol: MarketSymbol; trades: number }> = [];

  for (const symbol of config.symbols) {
    const range = db.tradeRange(symbol);
    if (!range) {
      console.log(`no stored ticks for ${symbol} — run the collector first (npm run paper)`);
      continue;
    }
    const from = toMs(args.from, range.from);
    const to = toMs(args.to, range.to);

    const trades = db.readTrades(symbol, from, to);
    const books = db.readBookSnapshots(symbol, from, to);
    for (const t of trades) events.push({ kind: 'trade', symbol, ts: t.time, trade: t });
    for (const b of books) events.push({ kind: 'book', symbol, ts: b.timestamp, book: b });
    perSymbol.push({ symbol, trades: trades.length });
  }

  if (events.length === 0) {
    console.log('nothing to replay.');
    db.close();
    return;
  }

  // Books before trades at equal timestamps: the strategy should see the book
  // state that existed when the print happened, not after it.
  events.sort((a, b) => a.ts - b.ts || (a.kind === 'book' ? -1 : 1));

  const engine = new TradingEngine({ runId, mode: 'backtest', config, strategy, db });
  for (const { symbol } of perSymbol) {
    engine.registerContext(new MarketContext({ symbol, timeframe: '1s' }));
  }

  db.startRun(runId, 'backtest', {
    config,
    strategy: strategy.describe?.() ?? {},
    window: { from: events[0].ts, to: events[events.length - 1].ts },
  });

  const startedAt = Date.now();
  const equitySamples: Array<{ ts: number; equity: number }> = [];
  let nextEval = events[0].ts;
  let peak = config.startingEquity;
  let maxDd = 0;

  for (const ev of events) {
    if (ev.kind === 'book') engine.onBook(ev.symbol, ev.book);
    else engine.onTrade(ev.symbol, ev.trade);

    // Strategy clock advances with the tape, not with wall time.
    if (ev.ts >= nextEval) {
      engine.evaluate(ev.ts);
      nextEval = ev.ts + config.evalIntervalMs;

      const equity = engine.getBroker().equity;
      equitySamples.push({ ts: ev.ts, equity });
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
    }
  }

  const lastTs = events[events.length - 1].ts;
  engine.getBroker().closeAll(lastTs, 'session_end');
  db.endRun(runId);

  // --- report ------------------------------------------------------------

  const broker = engine.getBroker();
  const stats = engine.computeStats();
  const trades = broker.getClosedTrades();
  const windowMs = lastTs - events[0].ts;
  const net = broker.realized;

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length : 0;
  const bySymbol = new Map<string, { n: number; pnl: number }>();
  for (const t of trades) {
    const e = bySymbol.get(t.symbol) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += t.netPnl;
    bySymbol.set(t.symbol, e);
  }

  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log(`BACKTEST  ${runId}`);
  console.log(line);
  console.log(`strategy        ${strategy.name}`);
  console.log(`symbols         ${perSymbol.map((s) => `${s.symbol} (${s.trades.toLocaleString()} ticks)`).join(', ')}`);
  console.log(`window          ${new Date(events[0].ts).toISOString()} → ${new Date(lastTs).toISOString()}`);
  console.log(`duration        ${(windowMs / 3_600_000).toFixed(2)} h of market data`);
  console.log(`replay time     ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  console.log(line);
  console.log(`starting equity ${fmt(config.startingEquity)} USDT`);
  console.log(`ending equity   ${fmt(broker.equity)} USDT`);
  console.log(`net pnl         ${net >= 0 ? '+' : ''}${fmt(net)} USDT  (${fmt((net / config.startingEquity) * 100)}%)`);
  console.log(`fees paid       ${fmt(broker.fees)} USDT`);
  console.log(`max drawdown    ${fmt(maxDd * 100)}%`);
  console.log(line);
  console.log(`signals         ${stats.signalsSeen} seen, ${stats.signalsTaken} taken`);
  console.log(`trades          ${stats.tradesClosed}`);
  console.log(`win rate        ${fmt(stats.winRate * 100, 1)}%  (${stats.wins}W / ${stats.losses}L)`);
  console.log(`profit factor   ${Number.isFinite(stats.profitFactor) ? fmt(stats.profitFactor) : '∞'}`);
  console.log(`avg R           ${fmt(stats.avgR)}`);
  console.log(`avg win / loss  +${fmt(avgWin)} / ${fmt(avgLoss)} USDT`);
  if (bySymbol.size > 0) {
    console.log(line);
    for (const [symbol, e] of bySymbol) {
      console.log(`${symbol.padEnd(10)}      ${String(e.n).padStart(3)} trades   ${e.pnl >= 0 ? '+' : ''}${fmt(e.pnl)} USDT`);
    }
  }
  console.log(line);
  if (stats.tradesClosed < 30) {
    console.log('NOTE: fewer than 30 trades — this sample is far too small to conclude anything.');
  }
  if (windowMs < 24 * 3_600_000) {
    console.log('NOTE: under a day of data. Let the collector run longer before trusting these numbers.');
  }
  console.log(`journalled as run ${runId} in ${config.db.path}\n`);

  db.close();
}

main().catch((err) => {
  console.error('backtest failed:', err);
  process.exit(1);
});
