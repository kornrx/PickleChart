import { MarketSymbol } from '../src/types/market';
import { LiquidityPool, RestingLimitWall, SweptOrderEvent } from '../src/types/liquidity';
import { Position } from '../src/types/trading';

export interface TVBridgeOptions {
  /** Chrome DevTools endpoint exposed by TradingView Desktop. */
  cdpUrl?: string;
  /**
   * The chart symbol these levels are valid on. Resting liquidity exists in one
   * exchange's book and nowhere else, so drawing Binance levels on a CFD feed
   * is wrong twice over: the prices carry a basis, and the orders are not there.
   */
  requireSymbol: string;
  /** Cap on how many walls and pools to draw, newest and nearest first. */
  maxWalls?: number;
  maxPools?: number;
  onLog?: (msg: string) => void;
}

export interface TVOverlayState {
  symbol: MarketSymbol;
  lastPrice: number;
  pools: LiquidityPool[];
  walls: RestingLimitWall[];
  sweeps: SweptOrderEvent[];
  position?: Position;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const COLORS = {
  bsl: '#26a69a',
  ssl: '#ef5350',
  wallBuy: '#2962ff',
  wallSell: '#ff6d00',
  sweep: '#ab47bc',
  entry: '#ffffff',
  stop: '#ef5350',
  target: '#26a69a',
};

/**
 * Draws PickleChart's order-flow levels onto a running TradingView Desktop
 * chart over the Chrome DevTools Protocol.
 *
 * TradingView's Pine Script cannot see an order book, so the levels that make
 * this project worth looking at — resting walls, swept liquidity, depth-derived
 * pools — cannot be ported into an indicator. Pushing them onto the chart from
 * the side is the only way to get them there, and it keeps the computation
 * where the real depth data is.
 *
 * It only ever removes shapes it drew itself: the user's own drawings are left
 * alone, and nothing it draws is saved into their layout.
 */
export class TVBridge {
  private opts: Required<Pick<TVBridgeOptions, 'cdpUrl' | 'maxWalls' | 'maxPools'>> & TVBridgeOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private drawnIds: string[] = [];
  private connected = false;

  constructor(opts: TVBridgeOptions) {
    this.opts = { cdpUrl: 'http://127.0.0.1:9222', maxWalls: 6, maxPools: 6, ...opts };
  }

  private log(msg: string) {
    this.opts.onLog?.(`[tv] ${msg}`);
  }

  async connect(): Promise<boolean> {
    let targets: CdpTarget[];
    try {
      const res = await fetch(`${this.opts.cdpUrl}/json/list`);
      targets = (await res.json()) as CdpTarget[];
    } catch (err) {
      this.log(`no TradingView Desktop on ${this.opts.cdpUrl} (${String(err)})`);
      return false;
    }

    const charts = targets.filter((t) => t.type === 'page' && /tradingview\.com\/chart/.test(t.url) && t.webSocketDebuggerUrl);
    if (charts.length === 0) {
      this.log('TradingView is running but no chart page is open');
      return false;
    }

    // Prefer a chart already showing the symbol these levels belong to, so a
    // chart the user has set up on another feed is never taken over.
    let fallback: CdpTarget | null = null;
    for (const candidate of charts) {
      if (!(await this.attach(candidate))) continue;
      const symbol = await this.getChartSymbol();
      if (symbol === this.opts.requireSymbol) {
        this.log(`attached to ${symbol}`);
        return true;
      }
      fallback ??= candidate;
      this.detachSocket();
    }

    if (fallback && (await this.attach(fallback))) {
      this.log(`attached, but no chart shows ${this.opts.requireSymbol} yet — standing by`);
      return true;
    }
    return false;
  }

  private attach(target: CdpTarget): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl!);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        resolve(true);
      };
      ws.onerror = () => {
        this.connected = false;
        resolve(false);
      };
      ws.onclose = () => {
        this.connected = false;
      };
      ws.onmessage = (event) => {
        let msg: {
          id?: number;
          result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
          error?: { message: string };
        };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.id == null) return;
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else if (msg.result?.exceptionDetails) waiter.reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else waiter.resolve(msg.result?.result?.value);
      };
    });
  }

  private detachSocket() {
    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }

  private evaluate<T>(expression: string): Promise<T> {
    if (!this.ws || !this.connected) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP evaluate timed out'));
      }, 10_000);
    });
  }

  async getChartSymbol(): Promise<string | null> {
    try {
      return await this.evaluate<string>('window.TradingViewApi.activeChart().symbol()');
    } catch {
      return null;
    }
  }

  /** Replace the previous overlay with a fresh one. */
  async sync(state: TVOverlayState): Promise<{ drawn: number; skipped?: string }> {
    if (!this.connected) return { drawn: 0, skipped: 'not connected' };

    const symbol = await this.getChartSymbol();
    if (symbol !== this.opts.requireSymbol) {
      await this.clear();
      return { drawn: 0, skipped: `chart shows ${symbol}, levels are for ${this.opts.requireSymbol}` };
    }

    const levels = this.buildLevels(state);
    const drawn = await this.evaluate<string[]>(this.renderScript(levels, this.drawnIds));
    this.drawnIds = Array.isArray(drawn) ? drawn : [];
    return { drawn: this.drawnIds.length };
  }

  /** Remove only the shapes this bridge drew. */
  async clear(): Promise<void> {
    if (!this.connected || this.drawnIds.length === 0) return;
    try {
      await this.evaluate(this.removeScript(this.drawnIds));
    } catch {
      // A chart reload drops the shapes anyway; nothing to recover.
    }
    this.drawnIds = [];
  }

  private buildLevels(state: TVOverlayState): Array<{ price: number; color: string; text: string; width: number; style: number }> {
    const out: Array<{ price: number; color: string; text: string; width: number; style: number }> = [];
    const near = (p: number) => Math.abs(p - state.lastPrice);

    for (const pool of state.pools.filter((p) => !p.isSwept).sort((a, b) => near(a.price) - near(b.price)).slice(0, this.opts.maxPools)) {
      out.push({
        price: pool.price,
        color: pool.type === 'BSL' ? COLORS.bsl : COLORS.ssl,
        text: `${pool.type} pool`,
        width: 1,
        style: 2, // dashed
      });
    }

    for (const wall of state.walls.filter((w) => w.isSignificant).sort((a, b) => b.notional - a.notional).slice(0, this.opts.maxWalls)) {
      out.push({
        price: wall.price,
        color: wall.side === 'buy' ? COLORS.wallBuy : COLORS.wallSell,
        text: `${wall.side === 'buy' ? 'BID' : 'ASK'} wall ${Math.round(wall.notional / 1000)}k`,
        width: 2,
        style: 0, // solid
      });
    }

    for (const sweep of state.sweeps.slice(-3)) {
      out.push({
        price: sweep.price,
        color: COLORS.sweep,
        text: `swept ${Math.round(sweep.notional / 1000)}k`,
        width: 1,
        style: 1, // dotted
      });
    }

    const pos = state.position;
    if (pos) {
      out.push({ price: pos.entryPrice, color: COLORS.entry, text: `${pos.direction} entry`, width: 2, style: 0 });
      if (pos.stopLoss != null) out.push({ price: pos.stopLoss, color: COLORS.stop, text: 'SL', width: 1, style: 2 });
      if (pos.takeProfit != null) out.push({ price: pos.takeProfit, color: COLORS.target, text: 'TP', width: 1, style: 2 });
    }

    return out;
  }

  private renderScript(
    levels: Array<{ price: number; color: string; text: string; width: number; style: number }>,
    previous: string[]
  ): string {
    return `(async () => {
      const chart = window.TradingViewApi.activeChart();
      for (const id of ${JSON.stringify(previous)}) {
        try { chart.removeEntity(id); } catch (e) {}
      }
      const time = Math.floor(Date.now() / 1000);
      const ids = [];
      for (const lvl of ${JSON.stringify(levels)}) {
        try {
          const id = await chart.createShape({ time, price: lvl.price }, {
            shape: 'horizontal_line',
            lock: true,
            disableSelection: true,
            disableSave: true,
            disableUndo: true,
            overrides: {
              linecolor: lvl.color,
              linewidth: lvl.width,
              linestyle: lvl.style,
              showLabel: true,
              textcolor: lvl.color,
              fontsize: 10,
              horzLabelsAlign: 'right',
              text: 'PC ' + lvl.text,
            },
          });
          if (id) ids.push(String(id));
        } catch (e) {}
      }
      return ids;
    })()`;
  }

  private removeScript(ids: string[]): string {
    return `(() => {
      const chart = window.TradingViewApi.activeChart();
      for (const id of ${JSON.stringify(ids)}) {
        try { chart.removeEntity(id); } catch (e) {}
      }
      return true;
    })()`;
  }

  close() {
    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }
}
