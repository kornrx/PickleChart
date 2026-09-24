import { ExitSignal, Strategy, StrategyContext, StrategySignal } from './types';
import { LiquidityPool, SweptOrderEvent } from '../../src/types/liquidity';
import { MarketSymbol } from '../../src/types/market';

export interface SweepReversalParams {
  /** Only consider sweeps this recent, in ms. */
  sweepLookbackMs: number;
  /** Price must reclaim the swept level by this many ticks before entry. */
  reclaimTicks: number;
  /** Minimum |delta ratio| in the flow window, confirming the aggressor flipped. */
  minFlowFlip: number;
  /** Minimum book imbalance backing the entry direction, in [0, 1]. */
  minBookSupport: number;
  /**
   * Minimum swept notional (USDT) — small sweeps are noise. What counts as
   * small depends on the book: gold perp turns over roughly a sixth of BTC's
   * volume, so one global figure either floods one symbol with noise or
   * silences the other entirely.
   */
  minSweptNotional: number;
  /** Per-symbol overrides of the sweep floor, scaled to each book's depth. */
  minSweptNotionalBySymbol: Partial<Record<MarketSymbol, number>>;
  /** Stop goes this many ticks beyond the sweep extreme. */
  stopBufferTicks: number;
  /**
   * Round-trip cost in basis points, in price terms. Everything below is sized
   * against it: a target the fee can swallow is not a target.
   */
  roundTripFeeBps: number;
  /**
   * Floor on the stop distance, as a multiple of the round-trip cost. A stop
   * tighter than the market's own noise over the holding period is not a stop,
   * it is a coin flip that pays fees either way.
   */
  minStopFeeMultiple: number;
  /**
   * Floor on the target distance, as a multiple of the round-trip cost.
   * Measured on 317k gold ticks: over 15 minutes the median move is 5.99 USD
   * against a 4.29 USD round trip — 72% of the move paid away in costs. Over
   * 90 minutes the same cost is closer to a quarter of the move.
   */
  minTargetFeeMultiple: number;
  /** Fallback reward multiple when no opposing pool is in range. */
  defaultRMultiple: number;
  /** Reject setups whose reward:risk falls below this. */
  minRewardRisk: number;
  /** Reject when the spread exceeds this many ticks — thin book, bad fills. */
  maxSpreadTicks: number;
  /** Move the stop to break-even once price is this many R in favour. */
  breakEvenAtR: number;
  /**
   * Push the break-even stop past entry by this multiple of the round trip.
   * A stop sitting exactly at entry does not scratch the trade — being tagged
   * there costs the full fee, every time.
   */
  breakEvenFeeMultiple: number;
  /** Abandon a trade that has gone nowhere after this long, in ms. */
  maxHoldMs: number;
}

export const DEFAULT_SWEEP_PARAMS: SweepReversalParams = {
  sweepLookbackMs: 45_000,
  reclaimTicks: 2,
  minFlowFlip: 0.15,
  minBookSupport: 0.05,
  minSweptNotional: 25_000,
  minSweptNotionalBySymbol: {
    BTCUSDT: 25_000,
    // Measured over 78 minutes of ticks: XAU 810k USDT/min against BTC 4,997k.
    XAUUSDT: 4_000,
  },
  stopBufferTicks: 3,
  roundTripFeeBps: 10,
  minStopFeeMultiple: 1.5,
  minTargetFeeMultiple: 4,
  defaultRMultiple: 2,
  minRewardRisk: 1.5,
  maxSpreadTicks: 4,
  breakEvenAtR: 1,
  breakEvenFeeMultiple: 1,
  // The move a trade needs has to fit inside the time it is given. Fifteen
  // minutes on gold offers a median of 5.99 USD to work with; ninety offers
  // roughly double that, against the same fixed cost.
  maxHoldMs: 90 * 60_000,
};

/**
 * Liquidity-sweep reversal.
 *
 * The setup this looks for: an aggressor runs price through a resting pool of
 * stops, the move fails to follow through, and the opposite side immediately
 * takes control. That is the one edge this codebase is already instrumented to
 * see — `LiquidityEngine` tracks the pools and flags the sweep, and the trade
 * tape gives the aggressor flip that confirms absorption.
 *
 * No claim is made that this is profitable. It is a worked reference: a
 * concrete, testable use of the order-flow signals, meant to be measured by the
 * backtester and replaced with your own rules.
 */
export class SweepReversalStrategy implements Strategy {
  readonly name = 'sweep-reversal';
  readonly warmupCandles = 30;
  private params: SweepReversalParams;

  constructor(params: Partial<SweepReversalParams> = {}) {
    this.params = { ...DEFAULT_SWEEP_PARAMS, ...params };
  }

  describe() {
    return { ...this.params } as Record<string, unknown>;
  }

  evaluateEntry(ctx: StrategyContext): StrategySignal | null {
    return this.explain(ctx).signal;
  }

  /**
   * Entry logic with the blocking gate named.
   *
   * `evaluateEntry` is a thin wrapper over this, so tuning tools can count why
   * setups are being turned down without a second copy of the rules to drift
   * out of step.
   */
  explain(ctx: StrategyContext): { signal: StrategySignal | null; blockedBy?: string } {
    const p = this.params;
    if (ctx.candles.length < this.warmupCandles) return { signal: null, blockedBy: 'warmup' };
    if (!ctx.book || !ctx.imbalance) return { signal: null, blockedBy: 'no book' };
    if (ctx.imbalance.spread > p.maxSpreadTicks * ctx.tickSize) return { signal: null, blockedBy: 'spread too wide' };

    // Consider every sweep still inside the lookback, newest first, rather than
    // the newest alone. On a busy book a fresh sweep arrives every few seconds
    // and has not had time to be reclaimed, so fixing on the latest one hides
    // the slightly older sweep that has actually matured into a setup.
    const candidates = this.qualifyingSweeps(ctx);
    if (candidates.length === 0) return { signal: null, blockedBy: 'no qualifying sweep' };

    let lastBlock = 'no reclaim';
    for (const sweep of candidates) {
      const attempt = this.evaluateSweep(ctx, sweep);
      if (attempt.signal) return attempt;
      lastBlock = attempt.blockedBy ?? lastBlock;
    }
    return { signal: null, blockedBy: lastBlock };
  }

  /** One sweep, checked against every entry gate. */
  private evaluateSweep(
    ctx: StrategyContext,
    sweep: SweptOrderEvent
  ): { signal: StrategySignal | null; blockedBy?: string } {
    const p = this.params;

    // A sweep driven by sellers sets up a long, and vice versa.
    const direction: 'long' | 'short' = sweep.aggressorSide === 'sell' ? 'long' : 'short';
    const dir = direction === 'long' ? 1 : -1;

    // 1. Price must have reclaimed the swept level.
    const reclaim = (ctx.lastPrice - sweep.price) * dir;
    if (reclaim < p.reclaimTicks * ctx.tickSize) return { signal: null, blockedBy: 'no reclaim' };

    // 2. Aggressor flow must have flipped against the sweep.
    if (ctx.flow.deltaRatio * dir < p.minFlowFlip) return { signal: null, blockedBy: 'flow not flipped' };

    // 3. The resting book should back the reversal rather than fight it.
    if (ctx.imbalance!.ratio * dir < p.minBookSupport) return { signal: null, blockedBy: 'book against' };

    // Everything from here is measured against what a round trip costs.
    const feePrice = ctx.lastPrice * (p.roundTripFeeBps / 10_000);

    // Stop sits beyond the extreme the sweep actually reached, but never inside
    // the noise: a stop the market crosses by accident just pays fees.
    const extreme = this.sweepExtreme(ctx, sweep, direction);
    let stopLoss = extreme - dir * p.stopBufferTicks * ctx.tickSize;
    const minStopDistance = p.minStopFeeMultiple * feePrice;
    if (Math.abs(ctx.lastPrice - stopLoss) < minStopDistance) {
      stopLoss = ctx.lastPrice - dir * minStopDistance;
    }
    const risk = Math.abs(ctx.lastPrice - stopLoss);
    if (risk <= 0) return { signal: null, blockedBy: 'zero risk' };

    // Target the nearest opposing pool that is far enough to be worth reaching.
    // A pool inside the cost floor is a landmark on the way, not an exit, so
    // look past it rather than pretending a fee-sized move is a trade.
    const minTargetDistance = p.minTargetFeeMultiple * feePrice;
    const pool = this.nearestOpposingPool(ctx, direction, minTargetDistance);
    const takeProfit =
      pool ?? ctx.lastPrice + dir * Math.max(risk * p.defaultRMultiple, minTargetDistance);

    const reward = (takeProfit - ctx.lastPrice) * dir;
    if (reward / risk < p.minRewardRisk) return { signal: null, blockedBy: 'reward:risk too low' };

    return { signal: {
      symbol: ctx.symbol,
      ts: ctx.now,
      direction,
      entryType: 'market',
      reason: `${sweep.type} @ ${sweep.price} reclaimed, delta ${ctx.flow.deltaRatio.toFixed(2)}`,
      stopLoss,
      takeProfit,
      confidence: Math.min(1, Math.abs(ctx.flow.deltaRatio) * (reward / risk) * 0.4),
      detail: {
        sweepId: sweep.id,
        sweepPrice: sweep.price,
        sweepAgeMs: ctx.now - sweep.time,
        sweptNotional: sweep.notional,
        reaction: sweep.reaction,
        deltaRatio: ctx.flow.deltaRatio,
        bookImbalance: ctx.imbalance!.ratio,
        rewardRisk: reward / risk,
        stopDistance: risk,
        targetDistance: reward,
        feePrice,
        targetFromPool: pool != null && takeProfit === pool,
      },
    } };
  }

  evaluateExit(ctx: StrategyContext): ExitSignal | null {
    const pos = ctx.position;
    if (!pos) return null;
    const p = this.params;

    if (ctx.now - pos.entryTs > p.maxHoldMs) {
      return { reason: 'max hold time', close: true };
    }

    // Break-even once the trade has paid for its own risk.
    if (pos.stopLoss != null) {
      const dir = pos.direction === 'long' ? 1 : -1;
      const risk = Math.abs(pos.entryPrice - pos.stopLoss);
      const movedR = risk > 0 ? ((ctx.lastPrice - pos.entryPrice) * dir) / risk : 0;
      // Break even means keeping the fees, not just the entry price.
      const feePrice = ctx.lastPrice * (p.roundTripFeeBps / 10_000);
      const breakEven = pos.entryPrice + dir * p.breakEvenFeeMultiple * feePrice;
      const alreadyThere = (pos.stopLoss - breakEven) * dir >= 0;
      if (movedR >= p.breakEvenAtR && !alreadyThere) {
        return { reason: `+${p.breakEvenAtR}R — stop to break-even plus costs`, newStopLoss: breakEven };
      }
    }

    return null;
  }

  /** The sweep floor for this symbol, falling back to the global figure. */
  public sweepFloorFor(symbol: MarketSymbol): number {
    return this.params.minSweptNotionalBySymbol[symbol] ?? this.params.minSweptNotional;
  }

  /** Sweeps inside the lookback that clear the noise floor, newest first. */
  private qualifyingSweeps(ctx: StrategyContext): SweptOrderEvent[] {
    const cutoff = ctx.now - this.params.sweepLookbackMs;
    const floor = this.sweepFloorFor(ctx.symbol);
    return ctx.sweptEvents
      .filter(
        (s) =>
          s.time >= cutoff &&
          s.notional >= floor &&
          s.reaction !== 'breakout_continuation' // the run kept going; no reversal
      )
      .sort((a, b) => b.time - a.time);
  }

  /** The furthest price reached against the intended direction since the sweep. */
  private sweepExtreme(ctx: StrategyContext, sweep: SweptOrderEvent, direction: 'long' | 'short'): number {
    let extreme = sweep.price;
    for (const t of ctx.recentTrades) {
      if (t.time < sweep.time) continue;
      extreme = direction === 'long' ? Math.min(extreme, t.price) : Math.max(extreme, t.price);
    }
    if (direction === 'long' && sweep.lowAfterSweep != null) extreme = Math.min(extreme, sweep.lowAfterSweep);
    if (direction === 'short' && sweep.highAfterSweep != null) extreme = Math.max(extreme, sweep.highAfterSweep);
    return extreme;
  }

  /**
   * Nearest un-swept pool in the direction of travel — where the move is likely
   * to be sold into — ignoring any that sit closer than `minDistance`.
   */
  private nearestOpposingPool(
    ctx: StrategyContext,
    direction: 'long' | 'short',
    minDistance = 0
  ): number | null {
    const dir = direction === 'long' ? 1 : -1;
    const wanted = direction === 'long' ? 'BSL' : 'SSL';
    let best: LiquidityPool | null = null;
    for (const pool of ctx.liquidityPools) {
      if (pool.isSwept) continue;
      if (pool.type !== wanted) continue;
      const distance = (pool.price - ctx.lastPrice) * dir;
      if (distance < minDistance) continue;
      if (!best || distance < (best.price - ctx.lastPrice) * dir) best = pool;
    }
    return best ? best.price : null;
  }
}
