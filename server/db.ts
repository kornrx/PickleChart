import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Candle, OrderBookState, RawTrade } from '../src/types/market';
import { ClosedTrade, OrderRecord } from './paperBroker';
import { StrategySignal } from './strategy/types';

/**
 * Tick storage + run journal. Raw trades and book snapshots are what make the
 * backtester meaningful later, so the live collector writes them even when no
 * strategy is armed.
 */
export class TradeDatabase {
  private db: DatabaseSync;
  private tradeBuffer: Array<[string, number, number, number, string]> = [];
  private writeErrors = 0;
  private lastErrorLog = 0;
  private onError?: (msg: string) => void;

  constructor(path: string, onError?: (msg: string) => void) {
    this.onError = onError;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // A backtest can run while the live collector is still writing ticks. WAL
    // allows that, but only one writer at a time — without a busy timeout the
    // second process fails outright instead of waiting its turn.
    this.db.exec('PRAGMA busy_timeout = 15000');
    this.migrate();
    this.rekeyRunScopedTables();
    this.addMissingColumns();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        side TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades(symbol, ts);

      CREATE TABLE IF NOT EXISTS book_snapshots (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        best_bid REAL NOT NULL,
        best_ask REAL NOT NULL,
        bids_json TEXT NOT NULL,
        asks_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_book_symbol_ts ON book_snapshots(symbol, ts);

      CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        tf TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL, high REAL, low REAL, close REAL,
        volume REAL, buy_volume REAL, sell_volume REAL,
        PRIMARY KEY (symbol, tf, time)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        qty REAL NOT NULL,
        price REAL,
        fill_price REAL,
        status TEXT NOT NULL,
        fee REAL NOT NULL DEFAULT 0,
        reason TEXT,
        PRIMARY KEY (run_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_orders_run ON orders(run_id, ts);

      CREATE TABLE IF NOT EXISTS closed_trades (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        qty REAL NOT NULL,
        entry_ts INTEGER NOT NULL,
        exit_ts INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        stop_loss REAL,
        take_profit REAL,
        gross_pnl REAL NOT NULL,
        fees REAL NOT NULL,
        funding REAL NOT NULL DEFAULT 0,
        net_pnl REAL NOT NULL,
        r_multiple REAL,
        exit_reason TEXT NOT NULL,
        entry_reason TEXT,
        PRIMARY KEY (run_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_closed_run ON closed_trades(run_id, exit_ts);

      CREATE TABLE IF NOT EXISTS equity_curve (
        run_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        equity REAL NOT NULL,
        realized REAL NOT NULL,
        unrealized REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equity_run ON equity_curve(run_id, ts);

      CREATE TABLE IF NOT EXISTS funding_rates (
        symbol TEXT NOT NULL,
        settlement_ts INTEGER NOT NULL,
        rate REAL NOT NULL,
        PRIMARY KEY (symbol, settlement_ts)
      );

      CREATE TABLE IF NOT EXISTS signals (
        run_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        direction TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL,
        accepted INTEGER NOT NULL DEFAULT 0,
        rejected_by TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signals_run ON signals(run_id, ts);
    `);
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
   * table, so a new column never reaches an existing file. Without this, writes
   * naming that column fail — and because journal writes are best-effort, they
   * would fail quietly.
   */
  private addMissingColumns() {
    const columns: Array<[string, string, string]> = [
      ['closed_trades', 'funding', 'REAL NOT NULL DEFAULT 0'],
    ];
    for (const [table, column, definition] of columns) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (existing.length === 0) continue;
      if (existing.some((c) => c.name === column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      this.onError?.(`schema: added ${table}.${column}`);
    }
  }

  /**
   * Early databases keyed `orders` and `closed_trades` by id alone. Those ids
   * restart per run (`o-1`, `t-SYMBOL-entryTs`), so a backtest would collide
   * with — and silently overwrite — the live run's journal. Rebuild the tables
   * with the run included in the key.
   */
  private rekeyRunScopedTables() {
    for (const table of ['orders', 'closed_trades']) {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as { sql?: string } | undefined;
      if (!row?.sql || !row.sql.includes('id TEXT PRIMARY KEY')) continue;

      const created = row.sql
        .replace('id TEXT PRIMARY KEY', 'id TEXT NOT NULL')
        .replace(/\)\s*$/, ', PRIMARY KEY (run_id, id))');

      this.db.exec('BEGIN');
      try {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
        this.db.exec(created);
        this.db.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}_old`);
        this.db.exec(`DROP TABLE ${table}_old`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /**
   * Journal writes are best-effort.
   *
   * Collecting market data is the job that cannot be redone later — a tick
   * missed while the feed is live is gone for good. A failed INSERT (a lock
   * held by a concurrent backtest, a full disk) must not be allowed to take the
   * collector down with it, so failures are counted and reported, not thrown.
   */
  private safeWrite(what: string, fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.writeErrors++;
      const message = String(err);
      // A missing table or column is a bug, not a busy database — say so at once.
      const isSchemaError = /no such (table|column)|has no column/i.test(message);
      const now = Date.now();
      if (isSchemaError || now - this.lastErrorLog > 30_000) {
        this.lastErrorLog = now;
        this.onError?.(
          `journal write failed (${what}): ${message} — ${this.writeErrors} total, collection continues`
        );
      }
    }
  }

  getWriteErrorCount(): number {
    return this.writeErrors;
  }

  // --- run journal -------------------------------------------------------

  startRun(id: string, mode: 'live-paper' | 'backtest', config: unknown, startedAt = Date.now()) {
    this.db
      .prepare('INSERT INTO runs (id, mode, started_at, config_json) VALUES (?, ?, ?, ?)')
      .run(id, mode, startedAt, JSON.stringify(config));
  }

  endRun(id: string, endedAt = Date.now()) {
    this.db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(endedAt, id);
  }

  // --- market data -------------------------------------------------------

  /** Buffered: raw ticks arrive hundreds per second, one INSERT each is wasteful. */
  bufferTrade(symbol: string, t: RawTrade) {
    this.tradeBuffer.push([symbol, t.time, t.price, t.qty, t.side]);
    if (this.tradeBuffer.length >= 200) this.flushTrades();
  }

  flushTrades() {
    if (this.tradeBuffer.length === 0) return;
    const rows = this.tradeBuffer;
    this.tradeBuffer = [];
    this.safeWrite('trades', () => {
      const stmt = this.db.prepare('INSERT INTO trades (symbol, ts, price, qty, side) VALUES (?, ?, ?, ?, ?)');
      this.db.exec('BEGIN');
      try {
        for (const row of rows) stmt.run(...row);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  insertBookSnapshot(symbol: string, book: OrderBookState) {
    this.safeWrite('book_snapshot', () =>
      this.db
        .prepare(
        'INSERT INTO book_snapshots (symbol, ts, best_bid, best_ask, bids_json, asks_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        symbol,
        book.timestamp,
        book.bestBid,
        book.bestAsk,
        JSON.stringify(book.bids.slice(0, 20).map((l) => [l.price, l.qty])),
        JSON.stringify(book.asks.slice(0, 20).map((l) => [l.price, l.qty]))
      ));
  }

  upsertCandles(symbol: string, tf: string, candles: Candle[]) {
    if (candles.length === 0) return;
    this.safeWrite('candles', () => {
      const stmt = this.db.prepare(`
      INSERT INTO candles (symbol, tf, time, open, high, low, close, volume, buy_volume, sell_volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, tf, time) DO UPDATE SET
        high = excluded.high, low = excluded.low, close = excluded.close,
        volume = excluded.volume, buy_volume = excluded.buy_volume, sell_volume = excluded.sell_volume
    `);
      this.db.exec('BEGIN');
      try {
        for (const c of candles) {
          stmt.run(symbol, tf, c.time, c.open, c.high, c.low, c.close, c.volume, c.buyVolume ?? 0, c.sellVolume ?? 0);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  // --- trading journal ---------------------------------------------------

  insertOrder(runId: string, o: OrderRecord) {
    this.safeWrite('order', () =>
      this.db
        .prepare(
        `INSERT INTO orders (id, run_id, symbol, ts, side, type, qty, price, fill_price, status, fee, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET
           fill_price = excluded.fill_price, status = excluded.status, fee = excluded.fee`
      )
        .run(o.id, runId, o.symbol, o.ts, o.side, o.type, o.qty, o.price ?? null, o.fillPrice ?? null, o.status, o.fee, o.reason ?? null));
  }

  insertClosedTrade(runId: string, t: ClosedTrade) {
    this.safeWrite('closed_trade', () =>
      this.db
        .prepare(
        `INSERT INTO closed_trades
         (id, run_id, symbol, direction, qty, entry_ts, exit_ts, entry_price, exit_price,
          stop_loss, take_profit, gross_pnl, fees, funding, net_pnl, r_multiple, exit_reason, entry_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .run(
        t.id, runId, t.symbol, t.direction, t.qty, t.entryTs, t.exitTs, t.entryPrice, t.exitPrice,
        t.stopLoss ?? null, t.takeProfit ?? null, t.grossPnl, t.fees, t.funding, t.netPnl, t.rMultiple ?? null,
        t.exitReason, t.entryReason ?? null
      ));
  }

  insertEquityPoint(runId: string, ts: number, equity: number, realized: number, unrealized: number) {
    this.safeWrite('equity', () =>
      this.db
        .prepare('INSERT INTO equity_curve (run_id, ts, equity, realized, unrealized) VALUES (?, ?, ?, ?, ?)')
        .run(runId, ts, equity, realized, unrealized));
  }

  insertSignal(runId: string, s: StrategySignal, accepted: boolean, rejectedBy?: string) {
    this.safeWrite('signal', () =>
      this.db
        .prepare(
        `INSERT INTO signals (run_id, symbol, ts, direction, reason, confidence, accepted, rejected_by, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .run(runId, s.symbol, s.ts, s.direction, s.reason, s.confidence ?? null, accepted ? 1 : 0, rejectedBy ?? null, JSON.stringify(s.detail ?? {})));
  }

  upsertFundingRates(symbol: string, rates: Array<{ ts: number; rate: number }>) {
    if (rates.length === 0) return;
    this.safeWrite('funding_rates', () => {
      const stmt = this.db.prepare(
        'INSERT INTO funding_rates (symbol, settlement_ts, rate) VALUES (?, ?, ?) ON CONFLICT(symbol, settlement_ts) DO UPDATE SET rate = excluded.rate'
      );
      this.db.exec('BEGIN');
      try {
        for (const r of rates) stmt.run(symbol, r.ts, r.rate);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  /** Measured funding settlements for a symbol, oldest first. */
  readFundingRates(symbol: string): Array<{ ts: number; rate: number }> {
    const rows = this.db
      .prepare('SELECT settlement_ts, rate FROM funding_rates WHERE symbol = ? ORDER BY settlement_ts')
      .all(symbol) as Array<{ settlement_ts: number; rate: number }>;
    return rows.map((r) => ({ ts: r.settlement_ts, rate: r.rate }));
  }

  // --- replay reads ------------------------------------------------------

  countTrades(symbol: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE symbol = ?').get(symbol) as { n: number };
    return row.n;
  }

  tradeRange(symbol: string): { from: number; to: number } | null {
    const row = this.db
      .prepare('SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts FROM trades WHERE symbol = ?')
      .get(symbol) as { from_ts: number | null; to_ts: number | null };
    if (row.from_ts == null || row.to_ts == null) return null;
    return { from: row.from_ts, to: row.to_ts };
  }

  readTrades(symbol: string, from?: number, to?: number): RawTrade[] {
    const rows = this.db
      .prepare(
        'SELECT ts, price, qty, side FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC, rowid ASC'
      )
      .all(symbol, from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as Array<{
      ts: number; price: number; qty: number; side: string;
    }>;
    return rows.map((r, i) => ({ id: `${r.ts}-${i}`, time: r.ts, price: r.price, qty: r.qty, side: r.side as 'buy' | 'sell' }));
  }

  readBookSnapshots(symbol: string, from?: number, to?: number): OrderBookState[] {
    const rows = this.db
      .prepare(
        'SELECT ts, best_bid, best_ask, bids_json, asks_json FROM book_snapshots WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC'
      )
      .all(symbol, from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as Array<{
      ts: number; best_bid: number; best_ask: number; bids_json: string; asks_json: string;
    }>;
    return rows.map((r) => {
      const bids = (JSON.parse(r.bids_json) as Array<[number, number]>).map(([price, qty]) => ({ price, qty }));
      const asks = (JSON.parse(r.asks_json) as Array<[number, number]>).map(([price, qty]) => ({ price, qty }));
      return {
        timestamp: r.ts,
        bestBid: r.best_bid,
        bestAsk: r.best_ask,
        bids,
        asks,
        maxBidQty: bids.reduce((m, l) => Math.max(m, l.qty), 0),
        maxAskQty: asks.reduce((m, l) => Math.max(m, l.qty), 0),
      };
    });
  }

  readClosedTrades(runId: string): ClosedTrade[] {
    const rows = this.db
      .prepare('SELECT * FROM closed_trades WHERE run_id = ? ORDER BY exit_ts ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      symbol: r.symbol as string,
      direction: r.direction as 'long' | 'short',
      qty: r.qty as number,
      entryTs: r.entry_ts as number,
      exitTs: r.exit_ts as number,
      entryPrice: r.entry_price as number,
      exitPrice: r.exit_price as number,
      stopLoss: (r.stop_loss as number | null) ?? undefined,
      takeProfit: (r.take_profit as number | null) ?? undefined,
      grossPnl: r.gross_pnl as number,
      fees: r.fees as number,
      funding: (r.funding as number | null) ?? 0,
      netPnl: r.net_pnl as number,
      rMultiple: (r.r_multiple as number | null) ?? undefined,
      exitReason: r.exit_reason as ClosedTrade['exitReason'],
      entryReason: (r.entry_reason as string | null) ?? undefined,
    }));
  }

  close() {
    this.flushTrades();
    this.db.close();
  }
}
