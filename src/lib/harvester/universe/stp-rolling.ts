/**
 * Rolling-open STP variant (docs/PHASE3-PREP.md P3-0i step 1c, Chris 2026-11-25). Pure.
 *
 * A second trend definition for the two patterns that use the weekly/monthly opens,
 * inside candles and U-turns (BUTN/BRUTN). The rolling "week" open is the open of the
 * bar `week` sessions back counting bar t as session 1 (bar t − (week − 1)); the rolling
 * "month" open likewise with `month`. Stocks use 5/20 (t−4, t−19); crypto 7/30 (t−6,
 * t−29). `stp_htf_opens_rolling` uses the same ±1 / ±0.5 formula as stp_htf_opens, and
 * U-turns read it at t−3, as the calendar version does.
 *
 * Offline only for now (P3-0i simulation). Live logging of these keys is P3-0i2.
 */
import type { DailyBar } from "./bar-metrics";
import { stpHtfOpens, wilderAtr } from "./bar-features";
import { wellBidAt } from "./stp";

export interface RollingWindows {
  week: number;
  month: number;
}

export const ROLLING_WINDOWS: Readonly<Record<"stock" | "crypto", RollingWindows>> = {
  stock: { week: 5, month: 20 },
  crypto: { week: 7, month: 30 },
};

export function rollingWindowsFor(assetClass: "stock" | "crypto" | null | undefined): RollingWindows {
  return assetClass === "crypto" ? ROLLING_WINDOWS.crypto : ROLLING_WINDOWS.stock;
}

/** stp_htf_opens_rolling at bar i; null when the window reaches before bar 0 or an open is missing. */
export function rollingHtfOpensAt(bars: readonly DailyBar[], i: number, w: RollingWindows = ROLLING_WINDOWS.stock): number | null {
  if (i < 0 || i >= bars.length) return null;
  const wi = i - (w.week - 1);
  const mi = i - (w.month - 1);
  if (wi < 0 || mi < 0) return null;
  return stpHtfOpens(bars[i].close, bars[wi].open ?? null, bars[mi].open ?? null);
}

export interface RollingStpResult {
  htfOpensRolling: number | null;
  trigger: number | null; // +1, −1, 0; null when too few bars
  triggerType: "inside" | "butn" | "brutn" | null;
  firedRules: string[];
  fudge: number | null;
  entry: number | null;
  stop: number | null;
}

/** Same minimum as computeStp, so both definitions are tested on the same dates. */
export const MIN_BARS = 51;

/**
 * Inside and U-turn triggers on the last bar with rolling opens as the trend. Rules
 * match computeStp's with stp_htf_opens replaced by stp_htf_opens_rolling. Bullish wins
 * when both fire. Entry/stop are the same high/low ± fudge as computeStp.
 */
export function computeStpRolling(bars: readonly DailyBar[], w: RollingWindows = ROLLING_WINDOWS.stock): RollingStpResult {
  const n = bars.length;
  const t = n - 1;
  const htfR = rollingHtfOpensAt(bars, t, w);
  if (n < MIN_BARS) return { htfOpensRolling: htfR, trigger: null, triggerType: null, firedRules: [], fudge: null, entry: null, stop: null };
  const b = bars[t];
  const p = bars[t - 1];
  const bull: Array<"inside" | "butn"> = [];
  const bear: Array<"inside" | "brutn"> = [];
  const inside = b.high <= p.high && b.low >= p.low;
  if (inside && htfR != null && htfR >= 1) bull.push("inside");
  if (inside && htfR != null && htfR <= -1) bear.push("inside");
  if (b.open != null && p.open != null) {
    const trend3 = rollingHtfOpensAt(bars, t - 3, w);
    const wellBidPrev = wellBidAt(bars, t - 1);
    const butn = b.high < p.high && p.close < p.open && b.close > p.close && b.low < p.low && b.close > p.low && b.close > b.open;
    const brutn = b.low > p.low && p.close > p.open && b.close < p.close && b.high > p.high && b.close < p.high && b.close < b.open;
    if (butn && trend3 != null && trend3 >= 1 && wellBidPrev != null && wellBidPrev <= -1) bull.push("butn");
    if (brutn && trend3 != null && trend3 <= -1 && wellBidPrev != null && wellBidPrev >= 1) bear.push("brutn");
  }
  const firedRules = [...bull.map((r) => `${r}+`), ...bear.map((r) => `${r}-`)];
  const atrSeries = wilderAtr(bars);
  const atr = atrSeries.length ? atrSeries[atrSeries.length - 1] : null;
  const fudge = atr != null ? Math.max(0.11 * atr, 0.02) : null;
  let trigger = 0;
  let triggerType: RollingStpResult["triggerType"] = null;
  if (bull.length) {
    trigger = 1;
    triggerType = bull[0];
  } else if (bear.length) {
    trigger = -1;
    triggerType = bear[0];
  }
  const entry = trigger === 0 || fudge == null ? null : trigger > 0 ? b.high + fudge : b.low - fudge;
  const stop = trigger === 0 || fudge == null ? null : trigger > 0 ? b.low - fudge : b.high + fudge;
  return { htfOpensRolling: htfR, trigger, triggerType, firedRules, fudge, entry, stop };
}
