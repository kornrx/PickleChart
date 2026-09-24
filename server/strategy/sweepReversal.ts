import { ExitSignal, Strategy, StrategyContext, StrategySignal } from './types';
import { LiquidityPool, SweptOrderEvent } from '../../src/types/liquidity';

export interface SweepReversalParams {
  /** Only consider sweeps this recent, in ms. */
  sweepLookbackMs: number;
  /** Price must reclaim the swept level by this many ticks before entry. */
  reclaimTicks: number;
  /** Minimum |delta ratio| in the flow window, confirming the aggressor flipped. */
  minFlowFlip: number;
  /** Minimum book imbalance backing the entry direction, in [0, 1]. */
  minBookSupport: number;
  /** Minimum swept notional (USDT) — small sweeps are noise. */
  minSweptNotional: number;
  /** Stop goes this many ticks beyond the sweep extreme. */
  stopBufferTicks: number;
  /** Fallback reward multiple when no opposing pool is in range. */
  defaultRMultiple: number;
  /** Reject setups whose reward:risk falls below this. */
  minRewardRisk: number;
  /** Reject when the spread exceeds this many ticks — thin book, bad fills. */
  maxSpreadTicks: number;
  /** Move the stop to break-even once price is this many R in favour. */
  breakEvenAtR: number;
  /** Abandon a trade that has gone nowhere after this long, in ms. */
  maxHoldMs: number;
}

export const DEFAULT_SWEEP_PARAMS: SweepReversalParams = {
  sweepLookbackMs: 45_000,
  reclaimTicks: 2,
  minFlowFlip: 0.15,
  minBookSupport: 0.05,
  minSweptNotional: 25_000,
  stopBufferTicks: 3,
  defaultRMultiple: 2,
  minRewardRisk: 1.5,
  maxSpreadTicks: 4,
  breakEvenAtR: 1,
  maxHoldMs: 15 * 60_000,
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
    const p = this.params;
    if (ctx.candles.length < this.warmupCandles) return null;
    if (!ctx.book || !ctx.imbalance) return null;
    if (ctx.imbalance.spread > p.maxSpreadTicks * ctx.tickSize) return null;

    const sweep = this.mostRecentSweep(ctx);
    if (!sweep) return null;

    // A sweep driven by sellers sets up a long, and vice versa.
    const direction: 'long' | 'short' = sweep.aggressorSide === 'sell' ? 'long' : 'short';
    const dir = direction === 'long' ? 1 : -1;

    // 1. Price must have reclaimed the swept level.
    const reclaim = (ctx.lastPrice - sweep.price) * dir;
    if (reclaim < p.reclaimTicks * ctx.tickSize) return null;

    // 2. Aggressor flow must have flipped against the sweep.
    if (ctx.flow.deltaRatio * dir < p.minFlowFlip) return null;

    // 3. The resting book should back the reversal rather than fight it.
    if (ctx.imbalance.ratio * dir < p.minBookSupport) return null;

    // Stop sits beyond the extreme the sweep actually reached.
    const extreme = this.sweepExtreme(ctx, sweep, direction);
    const stopLoss = extreme - dir * p.stopBufferTicks * ctx.tickSize;
    const risk = Math.abs(ctx.lastPrice - stopLoss);
    if (risk <= 0) return null;

    // Target the nearest opposing pool if one is in range, else a flat R multiple.
    const target = this.nearestOpposingPool(ctx, direction);
    const takeProfit = target ?? ctx.lastPrice + dir * risk * p.defaultRMultiple;
    const reward = (takeProfit - ctx.lastPrice) * dir;
    if (reward / risk < p.minRewardRisk) return null;

    return {
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
        sweptNotional: sweep.notional,
        reaction: sweep.reaction,
        deltaRatio: ctx.flow.deltaRatio,
        bookImbalance: ctx.imbalance.ratio,
        rewardRisk: reward / risk,
        targetFromPool: target != null,
      },
    };
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
      const alreadyAtBreakEven = (pos.stopLoss - pos.entryPrice) * dir >= 0;
      if (movedR >= p.breakEvenAtR && !alreadyAtBreakEven) {
        return { reason: `+${p.breakEvenAtR}R — stop to break-even`, newStopLoss: pos.entryPrice };
      }
    }

    return null;
  }

  private mostRecentSweep(ctx: StrategyContext): SweptOrderEvent | null {
    const cutoff = ctx.now - this.params.sweepLookbackMs;
    let best: SweptOrderEvent | null = null;
    for (const s of ctx.sweptEvents) {
      if (s.time < cutoff) continue;
      if (s.notional < this.params.minSweptNotional) continue;
      if (s.reaction === 'breakout_continuation') continue; // the run kept going; no reversal
      if (!best || s.time > best.time) best = s;
    }
    return best;
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

  /** Nearest un-swept pool in the direction of travel — where the move is likely to be sold into. */
  private nearestOpposingPool(ctx: StrategyContext, direction: 'long' | 'short'): number | null {
    const dir = direction === 'long' ? 1 : -1;
    const wanted = direction === 'long' ? 'BSL' : 'SSL';
    let best: LiquidityPool | null = null;
    for (const pool of ctx.liquidityPools) {
      if (pool.isSwept) continue;
      if (pool.type !== wanted) continue;
      if ((pool.price - ctx.lastPrice) * dir <= 0) continue;
      if (!best || (pool.price - ctx.lastPrice) * dir < (best.price - ctx.lastPrice) * dir) best = pool;
    }
    return best ? best.price : null;
  }
}
