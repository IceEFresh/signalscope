/**
 * P3-0k3: aligned trend v2 (docs/PHASE3-PREP.md §P3-0k3). Pure; bars ≤ i. Set after the first
 * P3-0k run, so a backfill KEEP is provisional until confirmed on live data. P3-0k is unchanged.
 *
 * Stock gates (long; shorts mirrored):
 * - MAs: close > max(sma20, sma50) and min(sma20, sma50) > sma200 (either order; ties fail;
 *   sma10 unused, no slope; the slope variant is descriptive);
 * - opens: close > the weekly open OR > the rolling 5-session open (crypto: rolling 7);
 * - at least one of Chris's named Finviz screens in the trade direction (each includes the base
 *   filter); F18 / F19 need short float and are null on the backfill.
 * Size: 1.0, halved once if the monthly or the rolling-20 open isn't green, once each for the
 * sector and the market not aligned, once for the industry not aligned (no industry data is
 * neutral), × 0.5 for an out-of-hours event, floor 0.25.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sma } from "@/lib/harvester/universe/bar-features";
import { periodOpenAt } from "@/lib/harvester/universe/stp";
import { ROLLING_WINDOWS, type RollingWindows } from "@/lib/harvester/universe/stp-rolling";
import type { ScreenId, ScreenResult } from "@/lib/harvester/universe/finviz-screens";
import { MIN_SIZE, type Dir } from "./stp-sim";
import { SLOPE_SESSIONS, type AlignState } from "./aligned";

/** Chris's named screens → FINVIZ-SCREENS.md IDs (confirmed 2026-11-25). */
export const P3K3_SCREENS: Readonly<Record<"long" | "short", ReadonlyArray<{ id: ScreenId; name: string }>>> = {
  long: [
    { id: "F28", name: "Double Volume" },
    { id: "F26", name: "Above SMA20" },
    { id: "F25", name: "New 20-Day High" },
    { id: "F23", name: "Month up Week up" },
    { id: "F22", name: "20 Day Breakout 75% Volume" },
    { id: "F21", name: "Strong Stock Weak Close" },
    { id: "F19", name: "Short Interest 20-day high" },
    { id: "F18", name: "Short Interest over 20 or 50 SMA" },
    { id: "F04", name: "Setting up for The Mechanical" },
  ],
  short: [
    { id: "F28", name: "Double Volume" },
    { id: "F10", name: "Above SMA20 (short mirror)" },
    { id: "F08", name: "New 20-Day High (short mirror: new 20-day low)" },
    { id: "F12", name: "Month up Week up (short mirror)" },
    { id: "F13", name: "20 Day Breakout 75% Volume (short mirror)" },
    { id: "F14", name: "Strong Stock Weak Close (short mirror)" },
    { id: "F03", name: "Setting up for The Mechanical (short mirror)" },
  ],
};

export const screensFor = (dir: Dir) => P3K3_SCREENS[dir === 1 ? "long" : "short"];

/** The named screens passing on D in the trade direction (true only; null = no data, e.g. F18/F19 on the backfill). */
export const passingNamedScreens = (sc: ScreenResult, dir: Dir): ScreenId[] => screensFor(dir).filter((s) => sc.screens[s.id] === true).map((s) => s.id);

export type MaOrder = "20>50" | "50>20";

/** The MA gate and which order holds; ties between sma20 and sma50 fail (`>` is strict). */
export function maOrderAt(closes: readonly number[], i: number, dir: Dir): { pass: boolean; order: MaOrder | null } {
  const s20 = sma(closes, 20, i);
  const s50 = sma(closes, 50, i);
  const s200 = sma(closes, 200, i);
  if (s20 == null || s50 == null || s200 == null || s20 === s50) return { pass: false, order: null };
  const c = closes[i];
  const pass = dir === 1 ? c > Math.max(s20, s50) && Math.min(s20, s50) > s200 : c < Math.min(s20, s50) && Math.max(s20, s50) < s200;
  const order: MaOrder = dir * (s20 - s50) > 0 ? "20>50" : "50>20";
  return { pass, order: pass ? order : null };
}

/** Descriptive slope variant: sma50 and sma200 both moving the trade's way over 5 sessions. */
export function slopeOk(closes: readonly number[], i: number, dir: Dir): boolean {
  for (const n of [50, 200]) {
    const now = sma(closes, n, i);
    const then = sma(closes, n, i - SLOPE_SESSIONS);
    if (now == null || then == null || !(dir * (now - then) > 0)) return false;
  }
  return true;
}

const green = (close: number, open: number | null | undefined, dir: Dir) => open != null && dir * (close - open) > 0;
const rollingOpen = (bars: readonly DailyBar[], i: number, n: number) => (i - (n - 1) >= 0 ? bars[i - (n - 1)].open ?? null : null);

/** Opens gate: close beyond the weekly open OR the rolling 5-session open (crypto 7). */
export function opensV2(bars: readonly DailyBar[], i: number, dir: Dir, w: RollingWindows = ROLLING_WINDOWS.stock): boolean {
  const c = bars[i].close;
  return green(c, periodOpenAt(bars, i, "week"), dir) || green(c, rollingOpen(bars, i, w.week), dir);
}

/** Sizing input 1: the monthly AND the rolling 20-session open both green (one halving if either isn't). */
export function monthlyAndRolling20Green(bars: readonly DailyBar[], i: number, dir: Dir, w: RollingWindows = ROLLING_WINDOWS.stock): boolean {
  const c = bars[i].close;
  return green(c, periodOpenAt(bars, i, "month"), dir) && green(c, rollingOpen(bars, i, w.month), dir);
}

export interface P3k3SizeInputs {
  monthlyR20Green: boolean;
  sector: AlignState | null;
  market: AlignState | null;
  /** null = no industry ETF or no data: neutral. */
  industry: AlignState | null;
}

export function p3k3Halvings(x: P3k3SizeInputs): number {
  return (x.monthlyR20Green ? 0 : 1) + (x.sector === "aligned" ? 0 : 1) + (x.market === "aligned" ? 0 : 1) + (x.industry == null || x.industry === "aligned" ? 0 : 1);
}

export function p3k3Size(x: P3k3SizeInputs, eventHalf: boolean): number {
  return Math.max(MIN_SIZE, 0.5 ** p3k3Halvings(x) * (eventHalf ? 0.5 : 1));
}

// ── Room to 3R, early in the leg (Chris, 2026-11-25; docs/p3-0k3-room-early) ───────────

export interface RoomEarly {
  /** False without a profile (fewer than 4 legs) as well. */
  pass: boolean;
  hasProfile: boolean;
  /** |entry − the last confirmed swing low| ÷ ATR14(D) (swing high for shorts). */
  legSoFar: number | null;
  /** Median (or 75th-percentile) rally in ATR − leg so far. */
  roomLeft: number | null;
  /** 3 × (entry − stop) ÷ ATR14(D): the room needed. */
  needed: number | null;
  /** Leg so far ÷ the median rally. */
  rallyUsed: number | null;
}

/**
 * Room left in the stock's typical move: the §1f swing profile at k = 2 (250 sessions, ≥ 4 legs,
 * pivots confirmed by D only). Gate: median rally − leg so far ≥ 3 × risk (all in ATR14 at D).
 * `quantile: "p75"` is the descriptive variant.
 */
export function roomEarly(
  bars: readonly DailyBar[],
  i: number,
  dir: Dir,
  entry: number,
  stop: number,
  atrD: number | null,
  pivots: readonly import("@/lib/harvester/universe/swings").Pivot[],
  profile: (t: number) => import("@/lib/harvester/universe/swings").SwingProfile,
  quantile: "median" | "p75" = "median",
): RoomEarly {
  const none: RoomEarly = { pass: false, hasProfile: false, legSoFar: null, roomLeft: null, needed: null, rallyUsed: null };
  if (atrD == null || !(atrD > 0)) return none;
  const prof = profile(i);
  const move = dir === 1 ? prof.rally : prof.pullback;
  if (!move) return none;
  const startKind = dir === 1 ? "low" : "high";
  let start: number | null = null;
  for (let n = pivots.length - 1; n >= 0; n--)
    if (pivots[n].confirmedAt <= i && pivots[n].kind === startKind) {
      start = pivots[n].price;
      break;
    }
  if (start == null) return { ...none, hasProfile: true };
  const legSoFar = Math.abs(entry - start) / atrD;
  const typical = quantile === "p75" ? move.p75Atr : move.medianAtr;
  const roomLeft = typical - legSoFar;
  const needed = (3 * dir * (entry - stop)) / atrD;
  return { pass: roomLeft >= needed - 1e-12, hasProfile: true, legSoFar, roomLeft, needed, rallyUsed: move.medianAtr > 0 ? legSoFar / move.medianAtr : null };
}

// ── "Build to layer size" (descriptive add variant) ───────────────────────────────

/**
 * At an add level (Chris, #89): the larger of the normal 50% add and the top-up to the day's
 * layer size, where only the top-up is capped at full size (1.0 at the base risk). The normal
 * 50% adds (max 3) apply as in the primary, so a position can still grow beyond full.
 */
export function buildAddQty(current: number, targetShares: number, fullShares: number): number {
  const topUp = Math.max(0, Math.min(targetShares, fullShares) - current);
  return Math.max(Math.floor(current * 0.5), topUp);
}
