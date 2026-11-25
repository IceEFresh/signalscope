/**
 * P3-0k: aligned-trend setups, the primary track (docs/PHASE3-PREP.md §P3-0k). Pure; bars ≤ i.
 *
 * One alignment definition for every layer (the stock, its industry ETF, its sector SPDR,
 * and the market by a 2-of-3 vote of SPY, QQQ and DIA):
 * - opens green (long): close > the monthly open, the weekly open, the rolling 20-session
 *   open and the rolling 5-session open (crypto 30 / 7);
 * - MAs stacked and sloped (long): close > sma10 > sma20 > sma50 > sma200, and each MA above
 *   its own value 5 sessions earlier.
 * Aligned when both hold for the direction, against when both hold the other way, mixed
 * otherwise (or when a value is missing).
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sma } from "@/lib/harvester/universe/bar-features";
import { periodOpenAt } from "@/lib/harvester/universe/stp";
import { ROLLING_WINDOWS, type RollingWindows } from "@/lib/harvester/universe/stp-rolling";
import type { Pivot } from "@/lib/harvester/universe/swings";
import { MIN_SIZE, type Dir } from "./stp-sim";

export type AlignState = "aligned" | "against" | "mixed";
export const ALIGN_MAS = [10, 20, 50, 200] as const;
/** An MA is rising when today's value is above its value this many sessions earlier. */
export const SLOPE_SESSIONS = 5;
/** Optimal entry: the stop is at most this many ATR beyond the nearest support. */
export const OPTIMAL_STOP_ATR = 0.5;

/** +1 when all four opens are below the close, −1 when all are above, 0 otherwise; null when one is missing. */
export function opensSign(bars: readonly DailyBar[], i: number, w: RollingWindows = ROLLING_WINDOWS.stock): number | null {
  if (i < 0 || i >= bars.length) return null;
  const c = bars[i].close;
  const opens = [
    periodOpenAt(bars, i, "month"),
    periodOpenAt(bars, i, "week"),
    i - (w.month - 1) >= 0 ? bars[i - (w.month - 1)].open ?? null : null,
    i - (w.week - 1) >= 0 ? bars[i - (w.week - 1)].open ?? null : null,
  ];
  if (opens.some((o) => o == null)) return null;
  if (opens.every((o) => c > o!)) return 1;
  if (opens.every((o) => c < o!)) return -1;
  return 0;
}

/** +1 when close > sma10 > sma20 > sma50 > sma200 and all four rise over 5 sessions; −1 mirrored; 0 otherwise; null without the data. */
export function masSign(closes: readonly number[], i: number): number | null {
  const now = ALIGN_MAS.map((n) => sma(closes, n, i));
  const then = ALIGN_MAS.map((n) => sma(closes, n, i - SLOPE_SESSIONS));
  if (i - SLOPE_SESSIONS < 0 || now.some((v) => v == null) || then.some((v) => v == null)) return null;
  const chain = [closes[i], ...(now as number[])];
  const up = chain.every((v, k) => k === 0 || chain[k - 1] > v) && now.every((v, k) => v! > then[k]!);
  const down = chain.every((v, k) => k === 0 || chain[k - 1] < v) && now.every((v, k) => v! < then[k]!);
  return up ? 1 : down ? -1 : 0;
}

const toState = (sign: number | null, dir: Dir): AlignState => (sign == null || sign === 0 ? "mixed" : sign === dir ? "aligned" : "against");

export interface Alignment {
  state: AlignState;
  opens: AlignState;
  mas: AlignState;
  /** Both signs computable (enough bars for sma200 + its 5-session slope, and every open). */
  complete: boolean;
}

/** One layer's alignment for a direction at bar i. */
export function alignmentAt(bars: readonly DailyBar[], closes: readonly number[], i: number, dir: Dir, w: RollingWindows = ROLLING_WINDOWS.stock): Alignment {
  const o = opensSign(bars, i, w);
  const m = masSign(closes, i);
  const opens = toState(o, dir);
  const mas = toState(m, dir);
  const state: AlignState = opens === "aligned" && mas === "aligned" ? "aligned" : opens === "against" && mas === "against" ? "against" : "mixed";
  return { state, opens, mas, complete: o != null && m != null };
}

/** Long-direction alignment by date for a series (ETF layers). The short state is the mirror. */
export function alignmentSeries(bars: readonly DailyBar[], dateOf: (b: DailyBar) => string | null): Map<string, Alignment> {
  const closes = bars.map((b) => b.close);
  const out = new Map<string, Alignment>();
  bars.forEach((b, i) => {
    const d = dateOf(b);
    if (d) out.set(d, alignmentAt(bars, closes, i, 1));
  });
  return out;
}

/** The long-direction state seen from `dir` (aligned ↔ against for a short). */
export const forDir = (longState: AlignState | null | undefined, dir: Dir): AlignState | null =>
  longState == null ? null : dir === 1 || longState === "mixed" ? longState : longState === "aligned" ? "against" : "aligned";

/** Market: aligned when ≥ 2 of SPY, QQQ, DIA are aligned, against when ≥ 2 are against, mixed otherwise (null when none known). */
export function marketAlignment(states: ReadonlyArray<AlignState | null>): AlignState | null {
  if (states.every((s) => s == null)) return null;
  if (states.filter((s) => s === "aligned").length >= 2) return "aligned";
  if (states.filter((s) => s === "against").length >= 2) return "against";
  return "mixed";
}

/**
 * Optimal entry: the stop is at most 0.5 ATR beyond the nearest support below the entry
 * (long). Support: sma10, sma20, sma50, a k = 2 swing low confirmed by i, the weekly or
 * monthly open. Short mirrored (resistance above). False without any support level.
 */
export function optimalEntry(
  bars: readonly DailyBar[],
  closes: readonly number[],
  i: number,
  dir: Dir,
  entry: number,
  stop: number,
  atr: number | null,
  pivots: readonly Pivot[],
): { optimal: boolean; support: number | null; stopBeyondAtr: number | null } {
  if (atr == null || !(atr > 0)) return { optimal: false, support: null, stopBeyondAtr: null };
  const levels: number[] = [];
  for (const n of [10, 20, 50]) {
    const v = sma(closes, n, i);
    if (v != null) levels.push(v);
  }
  for (const p of pivots) if (p.confirmedAt <= i && p.kind === (dir === 1 ? "low" : "high")) levels.push(p.price);
  for (const k of ["week", "month"] as const) {
    const v = periodOpenAt(bars, i, k);
    if (v != null) levels.push(v);
  }
  let support: number | null = null;
  for (const l of levels) {
    if (dir * (entry - l) <= 0) continue; // must be below the entry (long)
    if (support == null || dir * (l - support) > 0) support = l; // nearest: highest below (long)
  }
  if (support == null) return { optimal: false, support: null, stopBeyondAtr: null };
  const beyond = (dir * (support - stop)) / atr; // how far the stop sits past the support, in ATR
  return { optimal: beyond <= OPTIMAL_STOP_ATR + 1e-12, support, stopBeyondAtr: beyond };
}

/** Size: 1.0 when industry, sector and market are all aligned; each mixed or against layer halves; × 0.5 for an out-of-hours event; floor 0.25. */
export function p3kSize(layers: ReadonlyArray<AlignState | null>, eventHalf: boolean): number {
  const halvings = layers.filter((s) => s !== "aligned").length;
  return Math.max(MIN_SIZE, 0.5 ** halvings * (eventHalf ? 0.5 : 1));
}

/** Before the event halving, for the "results by size" split. */
export const p3kLayerSize = (layers: ReadonlyArray<AlignState | null>) => p3kSize(layers, false);
