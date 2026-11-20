/**
 * Market regime fields per scan, PLAN.md PR 1c (BOOK-IMPROVEMENTS rows #7, #14).
 * LOG ONLY: stored on Scan.regimeFeatures; no score, stage or label reads them.
 * (The existing options-flow regime filter in regime-filter.ts is unchanged.)
 *
 * Inputs are completed daily bars of SPY, ^VIX and TLT from the per-run chart
 * cache (SPY is already fetched for 1a's relative strength). Missing data is
 * null, never 0.
 */
import { etParts, type DailyBar } from "./bar-metrics";
import { sma } from "./bar-features";

export const REGIME_VERSION = 1;
export const REGIME_SYMBOLS = { spy: "SPY", vix: "^VIX", tlt: "TLT" } as const;

/** O'Neil distribution day: index down at least 0.2% on higher volume than the prior session. */
export const DISTRIBUTION_DROP = -0.002;
export const DISTRIBUTION_WINDOW = 25;

export interface RegimeFeatures {
  regime_version: number;
  spy_bar_date: string | null;
  spy_close: number | null;
  spy_close_vs_sma20: number | null; // close / SMA20 − 1 (row #7)
  spy_above_sma20: boolean | null;
  spy_sma20_slope_5d: number | null;
  spy_distribution_days_25: number | null; // row #14; 4–5 = weak market
  vix_close: number | null;
  vix_vs_sma20: number | null; // VIX trend: close / SMA20 − 1
  vix_change_5d: number | null;
  tlt_close_vs_sma20: number | null; // bond trend (Williams ch. 7)
  tlt_sma20_slope_5d: number | null;
  tlt_above_sma20: boolean | null;
}

const ratio = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : a / b - 1);

function trend(bars: readonly DailyBar[] | null) {
  if (!bars || bars.length === 0) return { close: null, vsSma20: null, slope5: null, change5: null };
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const close = closes[n - 1];
  const s20 = sma(closes, 20);
  const s20p = sma(closes, 20, n - 6);
  return {
    close,
    vsSma20: ratio(close, s20),
    slope5: ratio(s20, s20p),
    change5: n >= 6 ? ratio(close, closes[n - 6]) : null,
  };
}

/** Distribution days among the last `window` sessions (needs window + 1 bars). */
export function distributionDays(bars: readonly DailyBar[], window = DISTRIBUTION_WINDOW): number | null {
  const n = bars.length;
  if (n < window + 1) return null;
  let count = 0;
  for (let i = n - window; i < n; i++) {
    const change = bars[i].close / bars[i - 1].close - 1;
    if (change <= DISTRIBUTION_DROP && bars[i].volume > bars[i - 1].volume) count++;
  }
  return count;
}

export function computeRegime(
  spy: readonly DailyBar[] | null,
  vix: readonly DailyBar[] | null,
  tlt: readonly DailyBar[] | null,
): RegimeFeatures {
  const s = trend(spy);
  const v = trend(vix);
  const t = trend(tlt);
  const lastSpy = spy && spy.length > 0 ? spy[spy.length - 1] : undefined;
  return {
    regime_version: REGIME_VERSION,
    spy_bar_date: lastSpy?.time != null ? etParts(new Date(lastSpy.time * 1000)).date : null,
    spy_close: s.close,
    spy_close_vs_sma20: s.vsSma20,
    spy_above_sma20: s.vsSma20 == null ? null : s.vsSma20 > 0,
    spy_sma20_slope_5d: s.slope5,
    spy_distribution_days_25: spy ? distributionDays(spy) : null,
    vix_close: v.close,
    vix_vs_sma20: v.vsSma20,
    vix_change_5d: v.change5,
    tlt_close_vs_sma20: t.vsSma20,
    tlt_sma20_slope_5d: t.slope5,
    tlt_above_sma20: t.vsSma20 == null ? null : t.vsSma20 > 0,
  };
}
