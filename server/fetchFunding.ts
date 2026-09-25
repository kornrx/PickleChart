import { MarketSymbol } from '../src/types/market';
import { loadConfig } from './config';
import { TradeDatabase } from './db';

/**
 * Pulls settled funding rates from Binance so the backtester charges what was
 * actually paid rather than a flat assumption.
 *
 * Funding is the cost a paper run is most likely to forget: it never appears in
 * a fill, only in the balance, and any strategy that holds inventory pays it
 * every eight hours.
 */
async function fetchSymbol(symbol: MarketSymbol, from: number, to: number) {
  const out: Array<{ ts: number; rate: number }> = [];
  let cursor = from;

  // The endpoint returns at most 1000 rows, oldest first.
  while (cursor < to) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${to}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Array<{ fundingTime: number; fundingRate: string }>;
    if (rows.length === 0) break;

    for (const r of rows) out.push({ ts: r.fundingTime, rate: Number(r.fundingRate) });
    const last = rows[rows.length - 1].fundingTime;
    if (last <= cursor) break;
    cursor = last + 1;
  }
  return out;
}

async function main() {
  const config = loadConfig();
  const db = new TradeDatabase(config.db.path, (m) => console.error(m));

  // Cover the collected ticks with a month of margin, so replaying an older
  // window still finds its rates.
  const now = Date.now();
  const defaultFrom = now - 30 * 24 * 3_600_000;

  for (const symbol of config.symbols) {
    const range = db.tradeRange(symbol);
    const from = range ? Math.min(range.from, defaultFrom) : defaultFrom;
    try {
      const rates = await fetchSymbol(symbol, from, now);
      db.upsertFundingRates(symbol, rates);
      const recent = rates.slice(-3).map((r) => `${new Date(r.ts).toISOString().slice(5, 16)} ${(r.rate * 100).toFixed(4)}%`);
      console.log(`${symbol}: stored ${rates.length} settlements — latest ${recent.join(', ')}`);

      if (rates.length > 0) {
        const mean = rates.reduce((s, r) => s + r.rate, 0) / rates.length;
        console.log(`  mean ${(mean * 100).toFixed(4)}% per 8h  →  ${(mean * 3 * 100).toFixed(4)}% per day held`);
      }
    } catch (err) {
      console.error(`${symbol}: ${String(err)}`);
    }
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
