/**
 * Swing structure by an ATR zigzag (docs/PHASE3-PREP.md P3-0i §1f, Chris 2026-11-25). Pure.
 *
 * A swing high is confirmed once price falls k × ATR14 from it; a swing low once price
 * rises k × ATR14 from it. ATR14 is Wilder's on the bar where the leg starts, i.e. the
 * pivot being confirmed. Each pivot carries the bar it was confirmed on, and a caller at
 * day t uses only pivots with confirmedAt ≤ t, so nothing looks ahead. The zigzag is
 * causal (its state at bar t depends only on bars ≤ t), so it can be run once over a
 * symbol's whole history.
 */
import type { DailyBar } from "./bar-metrics";
import { wilderAtr } from "./bar-features";

export const SWING_KS = [1.5, 2, 3] as const;
export const PROFILE_SESSIONS = 250;
export const MIN_LEGS = 4;

export interface Pivot {
  i: number;
  price: number;
  kind: "high" | "low";
  /** Bar on which the reversal of k × ATR confirmed it. */
  confirmedAt: number;
  /** ATR14 at the pivot bar (the start of the next leg). */
  atr: number;
}

function atrAt(bars: readonly DailyBar[]): Array<number | null> {
  const s = wilderAtr(bars);
  return bars.map((_, i) => (i >= 14 ? s[i - 14] ?? null : null));
}

/** Confirmed zigzag pivots at threshold k × ATR14, oldest first. */
export function zigzag(bars: readonly DailyBar[], k: number, atr: ReadonlyArray<number | null> = atrAt(bars)): Pivot[] {
  const out: Pivot[] = [];
  const start = atr.findIndex((a) => a != null);
  if (start < 0) return out;
  let dir = 0; // 0 unknown, 1 tracking a high (up leg), −1 tracking a low (down leg)
  let hiI = start;
  let loI = start;
  for (let j = start + 1; j < bars.length; j++) {
    const b = bars[j];
    if (dir >= 0) {
      if (b.high > bars[hiI].high) hiI = j;
      else if (atr[hiI] != null && bars[hiI].high - b.low >= k * atr[hiI]!) {
        out.push({ i: hiI, price: bars[hiI].high, kind: "high", confirmedAt: j, atr: atr[hiI]! });
        dir = -1;
        loI = j;
        continue;
      }
    }
    if (dir <= 0) {
      if (b.low < bars[loI].low) loI = j;
      else if (atr[loI] != null && b.high - bars[loI].low >= k * atr[loI]!) {
        out.push({ i: loI, price: bars[loI].low, kind: "low", confirmedAt: j, atr: atr[loI]! });
        dir = 1;
        hiI = j;
      }
    }
  }
  return out;
}

export interface LegStats {
  n: number;
  medianAtr: number;
  p75Atr: number;
  medianPct: number;
  p75Pct: number;
  medianBars: number;
}

export interface SwingProfile {
  rally: LegStats | null; // up-legs
  pullback: LegStats | null; // down-legs
}

function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function stats(legs: ReadonlyArray<{ atr: number; pct: number; bars: number }>): LegStats | null {
  if (legs.length < MIN_LEGS) return null;
  return {
    n: legs.length,
    medianAtr: quantile(legs.map((l) => l.atr), 0.5),
    p75Atr: quantile(legs.map((l) => l.atr), 0.75),
    medianPct: quantile(legs.map((l) => l.pct), 0.5),
    p75Pct: quantile(legs.map((l) => l.pct), 0.75),
    medianBars: quantile(legs.map((l) => l.bars), 0.5),
  };
}

/** Pivots confirmed on or before bar t. */
export const confirmedBy = (pivots: readonly Pivot[], t: number) => pivots.filter((p) => p.confirmedAt <= t);

/**
 * Rally and pullback profile from confirmed legs that start within the PROFILE_SESSIONS
 * sessions up to bar t. A leg's size is in ATR units of its start pivot, and in % of the
 * start price; null with fewer than MIN_LEGS legs of a kind.
 */
export function swingProfile(bars: readonly DailyBar[], t: number, k: number, pivots: readonly Pivot[] = zigzag(bars, k)): SwingProfile {
  const conf = confirmedBy(pivots, t);
  const up: Array<{ atr: number; pct: number; bars: number }> = [];
  const down: Array<{ atr: number; pct: number; bars: number }> = [];
  for (let n = 1; n < conf.length; n++) {
    const a = conf[n - 1];
    const b = conf[n];
    if (a.i < t - (PROFILE_SESSIONS - 1)) continue;
    const leg = { atr: Math.abs(b.price - a.price) / a.atr, pct: Math.abs(b.price - a.price) / a.price, bars: b.i - a.i };
    (a.kind === "low" ? up : down).push(leg);
  }
  return { rally: stats(up), pullback: stats(down) };
}

export interface SwingEntry {
  rallyUsed: number | null;
  rallyAge: number | null;
  room3R: number | null;
  pullbackRatio: number | null;
}

/**
 * Entry scores for a trade triggered on bar t and filled at `fill` (on bar t + 1), long:
 * - rally_used = ((fill − last swing low) / ATR at that low) / median rally (ATR units)
 * - rally_age = bars from the last swing low to the fill bar / median rally bars
 * - room_3r = (median rally × ATR at the low − (fill − low)) / (3 × R)
 * - pullback_ratio = the confirmed pullback that ended at that low / median pullback
 * Short mirrored: the last swing high, down-legs as the move, up-legs as the pullback.
 * Uses only pivots confirmed by bar t.
 */
export function swingEntry(bars: readonly DailyBar[], t: number, fill: number, risk: number, dir: 1 | -1, k: number, pivots: readonly Pivot[] = zigzag(bars, k)): SwingEntry {
  const empty = { rallyUsed: null, rallyAge: null, room3R: null, pullbackRatio: null };
  const conf = confirmedBy(pivots, t);
  const prof = swingProfile(bars, t, k, pivots);
  const move = dir === 1 ? prof.rally : prof.pullback;
  const counter = dir === 1 ? prof.pullback : prof.rally;
  const startKind = dir === 1 ? "low" : "high";
  let s = -1;
  for (let n = conf.length - 1; n >= 0; n--) if (conf[n].kind === startKind) {
    s = n;
    break;
  }
  if (s < 0 || !move) return empty;
  const p = conf[s];
  const progress = dir * (fill - p.price); // price units into the move
  const rallyUsed = progress / p.atr / move.medianAtr;
  const rallyAge = (t + 1 - p.i) / move.medianBars;
  const room3R = (move.medianAtr * p.atr - progress) / (3 * risk);
  const prev = s > 0 ? conf[s - 1] : null; // the counter-leg that ended at this pivot
  const pullbackRatio = prev && counter ? Math.abs(p.price - prev.price) / prev.atr / counter.medianAtr : null;
  return { rallyUsed, rallyAge, room3R, pullbackRatio };
}
