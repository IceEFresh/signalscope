/**
 * Chris's Finviz screens recreated from our own bars (docs/FINVIZ-SCREENS.md, P3-0i §1i).
 * Pure; nothing is pulled from Finviz. Every value uses completed bars ≤ D only, so a hit
 * on D leads to an STP entry on D+1.
 *
 * Definitions on bar D:
 * - base: 3-month average volume > 2M shares and ATR14 > $1.50 (dollars, not %);
 * - change from open = (close − open) / open: u > 0, u1 ≥ 1%, u2 ≥ 2% (d mirrored);
 * - relvol = volume D / 3-month average volume;
 * - perf 1 wk / 4 wk = close D vs the close 5 / 20 sessions earlier;
 * - crossed sma20: close vs sma20 changes side from D−1 to D;
 * - new 20-day high: high D ≥ the max high of D−19..D (lows mirrored).
 * The 3-month average volume is the mean of the 63 sessions before D (D excluded), so
 * relvol compares D with its own history. ATR14 is Wilder's.
 *
 * Earnings screens (F01, F02) are null until P3-0i3 supplies dates; short-float screens
 * (F07, F16–F19) are null on the backfill (no history) and logged live only.
 */
import type { DailyBar } from "./bar-metrics";
import { sma } from "./bar-features";

export const AVG_VOL_SESSIONS = 63;
export const MIN_AVG_VOLUME = 2_000_000;
export const MIN_ATR_DOLLARS = 1.5;

export type ScreenId =
  | "F01" | "F02" | "F03" | "F04" | "F05" | "F06" | "F07" | "F08" | "F09" | "F10" | "F11" | "F12" | "F13" | "F14"
  | "F15" | "F16" | "F17" | "F18" | "F19" | "F20" | "F21" | "F22" | "F23" | "F24" | "F25" | "F26" | "F27" | "F28";

/** Trade direction each screen is tested in (docs/FINVIZ-SCREENS.md "Dir", set 2026-11-24). */
export const SCREEN_DIRS: Readonly<Record<ScreenId, "long" | "short" | "both">> = {
  F01: "both", F02: "both", F03: "short", F04: "long", F05: "short", F06: "long", F07: "both", F08: "short", F09: "short",
  F10: "short", F11: "short", F12: "short", F13: "short", F14: "short", F15: "short", F16: "both", F17: "both", F18: "both",
  F19: "both", F20: "long", F21: "long", F22: "long", F23: "long", F24: "long", F25: "long", F26: "long", F27: "long", F28: "both",
};

/** Screens that need earnings dates (P3-0i3) or short float (live only): null on the backfill. */
export const EARNINGS_SCREENS: readonly ScreenId[] = ["F01", "F02"];
export const SHORT_FLOAT_SCREENS: readonly ScreenId[] = ["F07", "F16", "F17", "F18", "F19"];

export interface ScreenResult {
  /** null when there aren't enough bars to evaluate. */
  base: boolean | null;
  screens: Record<ScreenId, boolean | null>;
}

export interface ScreenExtras {
  /** Days since the last earnings session (P3-0i3); null = unknown. */
  daysSinceEarnings?: number | null;
  /** Short float as a fraction (0.2 = 20%); null = unknown, never treated as false. */
  shortFloat?: number | null;
}

const ALL_IDS = Object.keys(SCREEN_DIRS) as ScreenId[];

/**
 * Screens on bar i using bars[0..i] only. `atr` is a Wilder ATR14 series aligned to bars
 * (any causal series, e.g. atrSeries from stp-sim).
 */
export function screensOn(bars: readonly DailyBar[], i: number, atr: ReadonlyArray<number | null>, extras: ScreenExtras = {}): ScreenResult {
  const none = Object.fromEntries(ALL_IDS.map((id) => [id, null])) as Record<ScreenId, null>;
  if (i < AVG_VOL_SESSIONS || i >= bars.length || bars[i].open == null || atr[i] == null) return { base: null, screens: none };
  const b = bars[i];
  const open = b.open!;
  const closes = bars.slice(0, i + 1).map((x) => x.close);
  const avgVol = bars.slice(i - AVG_VOL_SESSIONS, i).reduce((s, x) => s + x.volume, 0) / AVG_VOL_SESSIONS;
  const base = avgVol > MIN_AVG_VOLUME && atr[i]! > MIN_ATR_DOLLARS;

  const chg = (b.close - open) / open;
  const relvol = avgVol > 0 ? b.volume / avgVol : null;
  const perf = (n: number) => (i >= n ? b.close / bars[i - n].close - 1 : null);
  const p1w = perf(5);
  const p4w = perf(20);
  const s20 = sma(closes, 20, i);
  const s20p = sma(closes, 20, i - 1);
  const s50 = sma(closes, 50, i);
  const window = bars.slice(Math.max(0, i - 19), i + 1);
  const newHigh = i >= 19 && b.high >= Math.max(...window.map((x) => x.high));
  const newLow = i >= 19 && b.low <= Math.min(...window.map((x) => x.low));
  const prevClose = bars[i - 1].close;

  const lt = (a: number | null, v: number) => a != null && a < v;
  const gt = (a: number | null, v: number) => a != null && a > v;
  const belowS20 = s20 != null && b.close < s20;
  const aboveS20 = s20 != null && b.close > s20;
  const belowS50 = s50 != null && b.close < s50;
  const aboveS50 = s50 != null && b.close > s50;
  const crossedBelow20 = s20 != null && s20p != null && b.close < s20 && prevClose >= s20p;
  const crossedAbove20 = s20 != null && s20p != null && b.close > s20 && prevClose <= s20p;
  const up2 = chg >= 0.02;
  const dn2 = chg <= -0.02;

  const earnings = (days: number) => (extras.daysSinceEarnings == null ? null : extras.daysSinceEarnings >= 0 && extras.daysSinceEarnings <= days);
  const shortHigh = extras.shortFloat == null ? null : extras.shortFloat > 0.2;
  const and = (...xs: Array<boolean | null>) => (xs.some((x) => x === null) ? null : xs.every(Boolean));

  const raw: Record<ScreenId, boolean | null> = {
    F01: earnings(5),
    F02: extras.daysSinceEarnings == null ? null : extras.daysSinceEarnings === 1,
    F03: chg < 0 && crossedBelow20 && s50 != null && s20 != null && s50 > s20,
    F04: chg > 0 && crossedAbove20 && s50 != null && s20 != null && s50 < s20,
    F05: gt(relvol, 0.75) && chg <= -0.01 && lt(p4w, 0) && belowS20,
    F06: gt(relvol, 0.75) && chg >= 0.01 && gt(p4w, 0) && aboveS20,
    F07: and(gt(relvol, 1.5), shortHigh),
    F08: dn2 && newLow,
    F09: dn2 && newLow && belowS20,
    F10: dn2 && belowS20,
    F11: dn2,
    F12: dn2 && lt(p4w, 0) && lt(p1w, 0),
    F13: gt(relvol, 0.75) && chg < 0 && newLow,
    F14: up2 && lt(p4w, 0) && belowS20 && belowS50,
    F15: dn2 && lt(p4w, 0) && belowS20 && belowS50,
    F16: shortHigh,
    F17: and(shortHigh, gt(p1w, 0), gt(p4w, 0)),
    F18: and(shortHigh, aboveS20, aboveS50),
    F19: and(shortHigh, newHigh),
    F20: up2 && gt(p4w, 0) && aboveS20 && aboveS50,
    F21: dn2 && gt(p4w, 0) && aboveS20 && aboveS50,
    F22: gt(relvol, 0.75) && chg > 0 && newHigh,
    F23: up2 && gt(p4w, 0) && gt(p1w, 0),
    F24: up2 && newHigh && aboveS20,
    F25: b.close > prevClose && up2 && newHigh,
    F26: up2 && aboveS20,
    F27: up2,
    F28: gt(relvol, 2),
  };
  // Every screen also requires the base filter; null stays null (unknown is never "false").
  const screens = Object.fromEntries(ALL_IDS.map((id) => [id, raw[id] === null ? null : base && raw[id]])) as Record<ScreenId, boolean | null>;
  return { base, screens };
}

/** IDs of the screens that pass (true) on the bar. */
export const passingScreens = (r: ScreenResult): ScreenId[] => ALL_IDS.filter((id) => r.screens[id] === true);

/**
 * The pre-registered screen comparisons on the backfill: each OHLCV screen in its set
 * direction(s), 22 in all (20 one-direction screens plus F28 long and short).
 */
export const BACKFILL_SCREEN_TESTS: ReadonlyArray<{ id: ScreenId; dir: 1 | -1 }> = ALL_IDS.filter(
  (id) => !EARNINGS_SCREENS.includes(id) && !SHORT_FLOAT_SCREENS.includes(id),
).flatMap((id) => (SCREEN_DIRS[id] === "both" ? [{ id, dir: 1 as const }, { id, dir: -1 as const }] : [{ id, dir: SCREEN_DIRS[id] === "long" ? (1 as const) : (-1 as const) }]));
