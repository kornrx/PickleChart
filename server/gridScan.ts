import { MarketSymbol } from '../src/types/market';
import { loadConfig } from './config';
import { TradeDatabase } from './db';

/**
 * Measures what a grid ladder would actually have captured from stored ticks.
 *
 * Two wrong answers were tried first, both flattering:
 *
 * 1. Counting how often price crosses a ladder line and calling each crossing a
 *    fill. Price sitting on a boundary flips the level index every tick, and a
 *    counter reads each flip as another fill — 6x to 64x too high.
 * 2. Treating "price entered the band between two lines" as a fill. Entering the
 *    band is not reaching the line: price can sit a hair inside it, and
 *    crediting a full spacing for that hair invents profit out of jitter.
 *
 * What a grid actually does is rest a limit order *on* a line. So this tracks
 * line crossings: buying at line k when price crosses down through it, and
 * selling that unit only when price crosses up through line k+1 — a genuine
 * spacing higher. Jitter around a single line can no longer pay.
 */

export interface GridResult {
  spacing: number;
  roundTrips: number;
  closedNet: number;
  /** Mark-to-market on inventory never sold. Negative is a loss. */
  openPnl: number;
  trueNet: number;
  maxHeld: number;
  heldAtEnd: number;
  /** Open loss if price sat at the far end of the deepest run held. */
  worstInventory: number;
}

/** Incremental so a multi-million tick series can be streamed past it. */
export class GridSimulator {
  private held = new Set<number>();
  private roundTrips = 0;
  private gross = 0;
  private fees = 0;
  private maxHeld = 0;
  private prev: number | null = null;
  private last = 0;

  constructor(private spacing: number, private feeRate: number) {}

  push(price: number) {
    this.last = price;
    const line = Math.floor(price / this.spacing);
    if (this.prev === null) { this.prev = line; return; }
    if (line === this.prev) return;

    if (line < this.prev) {
      // Crossed down through lines prev, prev-1, … , line+1.
      for (let k = this.prev; k > line; k--) {
        if (this.held.has(k)) continue; // a ladder rests one order per line
        this.held.add(k);
        this.fees += k * this.spacing * this.feeRate;
      }
    } else {
      // Crossed up through lines prev+1 … line; each sells the unit one below.
      for (let k = this.prev + 1; k <= line; k++) {
        if (!this.held.has(k - 1)) continue;
        this.held.delete(k - 1);
        this.roundTrips++;
        this.gross += this.spacing;
        this.fees += k * this.spacing * this.feeRate;
      }
    }
    if (this.held.size > this.maxHeld) this.maxHeld = this.held.size;
    this.prev = line;
  }

  result(): GridResult {
    let openPnl = 0;
    for (const k of this.held) openPnl += this.last - k * this.spacing;
    const closedNet = this.gross - this.fees;
    return {
      spacing: this.spacing,
      roundTrips: this.roundTrips,
      closedNet,
      openPnl,
      trueNet: closedNet + openPnl,
      maxHeld: this.maxHeld,
      heldAtEnd: this.held.size,
      worstInventory: ((this.maxHeld * (this.maxHeld + 1)) / 2) * this.spacing,
    };
  }
}

export function simulateGrid(prices: number[], spacing: number, feeRate: number): GridResult {
  const sim = new GridSimulator(spacing, feeRate);
  for (const p of prices) sim.push(p);
  return sim.result();
}

/**
 * The check the first throwaway version did not have — and which caught two
 * separate off-by-ones once it existed.
 */
export function selfCheck(): void {
  const wave: number[] = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    for (let p = 100; p <= 110; p += 0.1) wave.push(Number(p.toFixed(4)));
    for (let p = 110; p >= 100; p -= 0.1) wave.push(Number(p.toFixed(4)));
  }

  // Spacing 1 across a 10-wide swing. The first rise has nothing to sell, so
  // five cycles give four full sweeps of about ten lines: roughly 40 trips.
  const r = simulateGrid(wave, 1, 0);
  if (r.roundTrips < 35 || r.roundTrips > 45) {
    throw new Error(`grid simulation is miscounting: ${r.roundTrips} round trips, expected ~40`);
  }
  if (Math.abs(r.closedNet - r.roundTrips) > 1e-6) {
    throw new Error(`each round trip must clear exactly one spacing: ${r.closedNet} over ${r.roundTrips}`);
  }

  // A swing narrower than the spacing can never complete a trip.
  if (simulateGrid(wave, 50, 0).roundTrips !== 0) {
    throw new Error('grid simulation invented trips on a spacing wider than the range');
  }

  // Jitter around one line must not pay: crossing the same line back and forth
  // buys and re-buys nothing, because selling needs the line above.
  const jitter: number[] = [];
  for (let i = 0; i < 5000; i++) jitter.push(i % 2 === 0 ? 99.999 : 100.001);
  const j = simulateGrid(jitter, 1, 0);
  if (j.roundTrips !== 0) {
    throw new Error(`jitter around a line produced ${j.roundTrips} round trips; it must produce none`);
  }
}

function fmt(n: number, d = 0) {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

async function main() {
  selfCheck();
  const config = loadConfig();
  const db = new TradeDatabase(config.db.path, (m) => console.error(m));
  const makerRoundTrip = 2 * (config.makerFeeBps / 10_000);
  const SLICE_MS = 30 * 60_000;

  for (const symbol of config.symbols as MarketSymbol[]) {
    const range = db.tradeRange(symbol);
    if (!range) {
      console.log(`no stored ticks for ${symbol}`);
      continue;
    }
    const hours = (range.to - range.from) / 3_600_000;

    // A reference price and the range, taken in slices so a multi-day tick
    // table never has to sit in memory at once.
    let hi = -Infinity, lo = Infinity, mid = 0, seen = 0;
    for (let from = range.from; from <= range.to; from += SLICE_MS) {
      for (const t of db.readTrades(symbol, from, Math.min(from + SLICE_MS - 1, range.to))) {
        if (t.price > hi) hi = t.price;
        if (t.price < lo) lo = t.price;
        seen++;
        if (mid === 0) mid = t.price;
      }
    }
    if (seen === 0) continue;
    mid = (hi + lo) / 2;
    const feeRT = mid * makerRoundTrip;

    const line = '='.repeat(98);
    console.log(`\n${line}`);
    console.log(`${symbol}  ${hours.toFixed(1)}h  ${fmt(seen)} ticks  range ${lo.toFixed(2)}–${hi.toFixed(2)}  maker round trip ${feeRT.toFixed(2)}`);
    console.log(line);
    console.log(' spacing | trips | closed net | open pnl | TRUE net | per day |  capital | %/day | worst inv | days at risk');

    const mults = [1.5, 2, 3, 4, 6, 8];
    const sims = mults.map((m) => new GridSimulator(feeRT * m, config.makerFeeBps / 10_000));

    for (let from = range.from; from <= range.to; from += SLICE_MS) {
      const trades = db.readTrades(symbol, from, Math.min(from + SLICE_MS - 1, range.to));
      for (const t of trades) for (const sim of sims) sim.push(t.price);
    }

    sims.forEach((sim, i) => {
      const r = sim.result();
      const perDay = (r.trueNet / hours) * 24;
      const capital = r.maxHeld * mid;
      const pctDay = capital > 0 ? (perDay / capital) * 100 : 0;
      const daysAtRisk = perDay > 0 ? r.worstInventory / perDay : NaN;
      console.log(
        ` ${r.spacing.toFixed(2).padStart(7)} | ${String(r.roundTrips).padStart(5)} | ${fmt(r.closedNet).padStart(10)} | ` +
        `${fmt(r.openPnl).padStart(8)} | ${fmt(r.trueNet).padStart(8)} | ${fmt(perDay).padStart(7)} | ` +
        `${fmt(capital).padStart(8)} | ${pctDay.toFixed(2).padStart(5)} | ${fmt(r.worstInventory).padStart(9)} | ` +
        `${(Number.isFinite(daysAtRisk) ? daysAtRisk.toFixed(1) : 'loss').padStart(12)}`
      );
      void mults[i];
    });
  }

  console.log('\nUPPER BOUND. Queue position is not modelled, so every fill here is assumed to be');
  console.log('ours. Funding on held inventory is not charged either. Treat anything under');
  console.log('roughly 5 days at risk as no margin at all.\n');
  db.close();
}

// Only run when invoked directly — importing this for its functions must not
// kick off a full scan.
if (process.argv[1]?.endsWith('gridScan.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
