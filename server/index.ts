import { WebSocketServer, WebSocket } from 'ws';
import { MarketSymbol, OrderBookState, RawTrade } from '../src/types/market';
import { BinanceService } from '../src/services/binanceService';
import { loadConfig } from './config';
import { TradeDatabase } from './db';
import { MarketContext } from './marketContext';
import { TradingEngine } from './tradingEngine';
import { SweepReversalStrategy } from './strategy/sweepReversal';

const config = loadConfig();
const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const strategy = new SweepReversalStrategy();

const db = new TradeDatabase(config.db.path);
db.startRun(runId, 'live-paper', { config, strategy: strategy.describe?.() ?? {} });

const engine = new TradingEngine({
  runId,
  mode: 'live-paper',
  config,
  strategy,
  db,
  events: {
    onOrder: (o) =>
      log(`${o.status.toUpperCase()} ${o.side} ${o.qty} ${o.symbol} @ ${o.fillPrice?.toFixed(2) ?? o.price?.toFixed(2) ?? '-'} ${o.reason ? `(${o.reason})` : ''}`),
    onClose: (t) =>
      log(`CLOSED ${t.direction} ${t.symbol} ${t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(2)} USDT (${t.exitReason}${t.rMultiple != null ? `, ${t.rMultiple.toFixed(2)}R` : ''})`),
    onSignal: (s, accepted, rejectedBy) =>
      log(`SIGNAL ${s.direction} ${s.symbol} — ${accepted ? 'TAKEN' : `rejected: ${rejectedBy}`} — ${s.reason}`),
  },
});

const services = new Map<MarketSymbol, BinanceService>();
const lastBookWrite = new Map<string, number>();
let shuttingDown = false;

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

// --- market data feeds ---------------------------------------------------

async function startSymbol(symbol: MarketSymbol) {
  const ctx = new MarketContext({
    symbol,
    timeframe: '1s',
    onCandles: (candles) => {
      // Persist only settled candles; the forming one is rewritten every tick.
      const settled = candles.slice(-120, -1);
      if (settled.length > 0) db.upsertCandles(symbol, '1s', settled);
    },
  });
  engine.registerContext(ctx);

  const service = new BinanceService(
    {
      onDepth: (book: OrderBookState) => {
        engine.onBook(symbol, book);
        const last = lastBookWrite.get(symbol) ?? 0;
        if (book.timestamp - last >= config.bookSnapshotIntervalMs) {
          lastBookWrite.set(symbol, book.timestamp);
          db.insertBookSnapshot(symbol, book);
        }
      },
      onTrade: (trade: RawTrade) => {
        engine.onTrade(symbol, trade);
        db.bufferTrade(symbol, trade);
      },
      onTicker: () => {},
      onStatusChange: (status, message) => {
        if (status !== 'connected') log(`${symbol} feed ${status}${message ? `: ${message}` : ''}`);
        else log(`${symbol} feed connected`);
      },
    },
    symbol
  );
  services.set(symbol, service);

  // Seed history before arming so the strategy is not blind on the first ticks.
  try {
    const [klines, trades, book] = await Promise.all([
      service.fetchHistoricalKlines('1m', 1500),
      service.fetchHistoricalTrades(3000),
      service.fetchDepthSnapshot(500),
    ]);
    ctx.seed(klines, trades);
    if (book) engine.onBook(symbol, book);
    log(`${symbol} seeded: ${klines.length} klines, ${trades.length} trades`);
  } catch (err) {
    log(`${symbol} seed failed (continuing on live data only): ${String(err)}`);
  }

  service.connect();
}

// --- control + telemetry socket -----------------------------------------

const wss = new WebSocketServer({ port: config.ws.port });
const clients = new Set<WebSocket>();

wss.on('connection', (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'snapshot', payload: engine.snapshot() }));

  socket.on('message', (raw) => {
    let msg: { type?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // Control surface is deliberately tiny: arm, disarm, flatten, clear kill switch.
    switch (msg.type) {
      case 'arm':
        engine.setArmed(true);
        log('ARMED — strategy may open positions');
        break;
      case 'disarm':
        engine.setArmed(false);
        log('DISARMED — no new entries');
        break;
      case 'flatten':
        engine.getBroker().closeAll(Date.now(), 'kill_switch');
        log('FLATTEN — all positions closed at market');
        break;
      case 'reset_kill_switch':
        engine.resetKillSwitch();
        log('kill switch cleared');
        break;
    }
    broadcast();
  });

  socket.on('close', () => clients.delete(socket));
});

function broadcast() {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type: 'snapshot', payload: engine.snapshot() });
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(msg);
  }
}

// --- loops ---------------------------------------------------------------

const evalTimer = setInterval(() => engine.evaluate(Date.now()), config.evalIntervalMs);
const pushTimer = setInterval(broadcast, 500);
const flushTimer = setInterval(() => db.flushTrades(), 5_000);

async function main() {
  log(`PickleChart paper trading — run ${runId}`);
  log(`strategy: ${strategy.name} | symbols: ${config.symbols.join(', ')} | equity: ${config.startingEquity} USDT`);
  log(`PAPER MODE — no exchange credentials are used and no real orders are sent`);
  log(`telemetry: ws://localhost:${config.ws.port}`);

  for (const symbol of config.symbols) await startSymbol(symbol);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down — flattening paper positions and flushing journal');

  clearInterval(evalTimer);
  clearInterval(pushTimer);
  clearInterval(flushTimer);

  engine.getBroker().closeAll(Date.now(), 'session_end');
  const stats = engine.computeStats();
  log(
    `run summary: ${stats.tradesClosed} trades, ${(stats.winRate * 100).toFixed(1)}% win, ` +
      `PF ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}, ` +
      `net ${engine.getBroker().realized.toFixed(2)} USDT`
  );

  for (const s of services.values()) s.disconnect();
  db.endRun(runId);
  db.close();
  wss.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('fatal:', err);
  shutdown();
});
