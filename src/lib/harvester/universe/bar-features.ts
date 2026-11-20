/**
 * Bar features, PLAN.md PR 1a (BOOK-IMPROVEMENTS rows 1–4, 8, 11–13, 17, plus
 * Chris's STP order-flow state). LOG ONLY: nothing here feeds a score, stage or
 * label. Stored per ticker-scan row in ValidatedTicker.features (JSONB).
 *
 * Inputs are completed daily bars from the shared 3-month chart (parseChartBars
 * drops an open session's partial bar). The last bar is the most recent
 * completed session before the scan, so no feature looks past the scan.
 * Anything that can't be computed from the bars at hand is null, never 0.
 *
 * Keys are snake_case and stable; bump BAR_FEATURES_VERSION when a definition
 * changes so Phase 3 can split rows by version.
 */
import { etParts, type DailyBar } from "./bar-metrics";

export const BAR_FEATURES_VERSION = 1;

export type FeatureValue = number | boolean | string | null;

export interface BarFeatures {
  features_version: number;
  /** ET date (YYYY-MM-DD) of the last completed bar the features describe. */
  bar_date: string | null;
  close: number | null;
  /** #1 trend state */
  close_vs_sma20: number | null; // close / SMA20 − 1
  close_vs_sma50: number | null; // close / SMA50 − 1
  sma20_vs_sma50: number | null; // SMA20 / SMA50 − 1
  sma20_slope_5d: number | null; // SMA20 now / SMA20 five bars ago − 1
  /** #2 where the close sits in the day's range: 0 = low, 1 = high */
  close_location: number | null;
  /** #4 consecutive higher closes ending at the last bar */
  consecutive_up_days: number | null;
  /** #3 range contraction */
  range_vs_avg10: number | null; // last range / mean range of the prior 10 bars
  nr4: boolean | null; // last range ≤ each of the prior 3
  nr7: boolean | null; // last range ≤ each of the prior 6
  /** Wilder ATR(14), as TradingView ta.atr and docs/STP-SIGNALS.md */
  atr14: number | null;
  atr14_pct: number | null;
  /** #11 extension above the prior high (prior bars only, last bar excluded) */
  pct_above_high_20d: number | null; // close / max(high of prior 20 bars) − 1
  pct_above_high_60d: number | null; // close / max(high of prior 60 bars) − 1
  /** #12 last volume / mean volume of the prior 50 bars */
  volume_ratio_50d: number | null;
  /** #8 relative strength: 20-bar return minus SPY's over the same dates */
  return_20d: number | null;
  spy_return_20d: number | null;
  rs_vs_spy_20d: number | null;
  /** #17 Wilder RSI(14) and its range over the last 20 bars */
  rsi14: number | null;
  rsi14_min_20d: number | null;
  rsi14_max_20d: number | null;
  /** annualized stdev of the last 20 daily log returns */
  hv20: number | null;
  /** STP order flow (docs/STP-SIGNALS.md): close vs the current week's and month's open */
  week_open: number | null;
  month_open: number | null;
  close_vs_week_open: number | null; // close / weekOpen − 1
  close_vs_month_open: number | null; // close / monthOpen − 1
  /** +1 above both, −1 below both, +0.5 below week/above month, −0.5 above week/below month, 0 otherwise */
  stp_htf_opens: number | null;
}

const ratio = (a: number | null, b: number | null): number | null =>
  a == null || b == null || b === 0 ? null : a / b - 1;

export function sma(values: readonly number[], period: number, endIndex = values.length - 1): number | null {
  if (endIndex + 1 < period || endIndex < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i];
  return sum / period;
}

/** Wilder RMA seeded with the SMA of the first `period` values (TradingView's ta.rma). */
function wilder(values: readonly number[], period: number): number[] {
  const out: number[] = [];
  if (values.length < period) return out;
  let avg = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out.push(avg);
  for (let i = period; i < values.length; i++) {
    avg = (avg * (period - 1) + values[i]) / period;
    out.push(avg);
  }
  return out;
}

/** Wilder ATR series; element k is the ATR ending at bar k + period. */
export function wilderAtr(bars: readonly DailyBar[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  return wilder(tr, period);
}

/** Wilder RSI series over closes; element k is the RSI ending at close k + period. */
export function wilderRsi(closes: readonly number[], period = 14): number[] {
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const g = wilder(gains, period);
  const l = wilder(losses, period);
  return g.map((avgGain, k) => (l[k] === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / l[k])));
}

function barDate(bar: DailyBar | undefined): string | null {
  return bar?.time != null ? etParts(new Date(bar.time * 1000)).date : null;
}

/** Monday (YYYY-MM-DD) of the ISO week containing an ET date string. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Open of the first bar in the same week (or month) as the last bar. */
function periodOpen(bars: readonly DailyBar[], kind: "week" | "month"): number | null {
  const last = barDate(bars[bars.length - 1]);
  if (!last) return null;
  const key = (d: string) => (kind === "week" ? weekStart(d) : d.slice(0, 7));
  const target = key(last);
  // The first bar of the period must be in the window, i.e. the bar before it is in an earlier period.
  for (let i = 0; i < bars.length; i++) {
    const d = barDate(bars[i]);
    if (d && key(d) === target) {
      if (i === 0) return null; // period may have started before the window
      return bars[i].open ?? null;
    }
  }
  return null;
}

export function stpHtfOpens(close: number | null, weekOpen: number | null, monthOpen: number | null): number | null {
  if (close == null || weekOpen == null || monthOpen == null) return null;
  if (close > weekOpen && close > monthOpen) return 1;
  if (close < weekOpen && close < monthOpen) return -1;
  if (close < weekOpen && close > monthOpen) return 0.5;
  if (close > weekOpen && close < monthOpen) return -0.5;
  return 0;
}

function returnBetweenDates(bars: readonly DailyBar[], fromDate: string, toDate: string): number | null {
  let from: number | null = null;
  let to: number | null = null;
  for (const b of bars) {
    const d = barDate(b);
    if (d === fromDate) from = b.close;
    if (d === toDate) to = b.close;
  }
  return ratio(to, from);
}

export function computeBarFeatures(bars: readonly DailyBar[], spyBars: readonly DailyBar[] | null = null): BarFeatures {
  const n = bars.length;
  const last = bars[n - 1];
  const closes = bars.map((b) => b.close);
  const ranges = bars.map((b) => b.high - b.low);
  const close = last?.close ?? null;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma20Prev5 = sma(closes, 20, n - 6);

  let consecutiveUp: number | null = null;
  if (n >= 2) {
    consecutiveUp = 0;
    for (let i = n - 1; i >= 1 && closes[i] > closes[i - 1]; i--) consecutiveUp++;
  }

  const lastRange = last ? ranges[n - 1] : null;
  const prior = (k: number) => (n >= k + 1 ? ranges.slice(n - 1 - k, n - 1) : null);
  const prior10 = prior(10);
  const prior3 = prior(3);
  const prior6 = prior(6);

  const atrSeries = wilderAtr(bars);
  const atr14 = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : null;

  const priorHigh = (k: number) => (n >= k + 1 ? Math.max(...bars.slice(n - 1 - k, n - 1).map((b) => b.high)) : null);

  const priorVol50 = n >= 51 ? bars.slice(n - 51, n - 1).reduce((s, b) => s + b.volume, 0) / 50 : null;

  const return20 = n >= 21 ? closes[n - 1] / closes[n - 21] - 1 : null;
  let spyReturn20: number | null = null;
  if (spyBars && n >= 21) {
    const to = barDate(bars[n - 1]);
    const from = barDate(bars[n - 21]);
    if (to && from) spyReturn20 = returnBetweenDates(spyBars, from, to);
  }

  const rsi = wilderRsi(closes);
  const rsiLast20 = rsi.length >= 20 ? rsi.slice(-20) : null;

  let hv20: number | null = null;
  if (n >= 21) {
    const rets: number[] = [];
    for (let i = n - 20; i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    hv20 = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
  }

  const weekOpen = n > 0 ? periodOpen(bars, "week") : null;
  const monthOpen = n > 0 ? periodOpen(bars, "month") : null;

  return {
    features_version: BAR_FEATURES_VERSION,
    bar_date: barDate(last),
    close,
    close_vs_sma20: ratio(close, sma20),
    close_vs_sma50: ratio(close, sma50),
    sma20_vs_sma50: ratio(sma20, sma50),
    sma20_slope_5d: ratio(sma20, sma20Prev5),
    close_location: last && lastRange! > 0 ? (last.close - last.low) / lastRange! : null,
    consecutive_up_days: consecutiveUp,
    range_vs_avg10: prior10 && lastRange != null ? ratio(lastRange, prior10.reduce((s, r) => s + r, 0) / 10) : null,
    nr4: prior3 && lastRange != null ? prior3.every((r) => lastRange <= r) : null,
    nr7: prior6 && lastRange != null ? prior6.every((r) => lastRange <= r) : null,
    atr14,
    atr14_pct: atr14 != null && close ? atr14 / close : null,
    pct_above_high_20d: ratio(close, priorHigh(20)),
    pct_above_high_60d: ratio(close, priorHigh(60)),
    volume_ratio_50d: last && priorVol50 ? last.volume / priorVol50 : null,
    return_20d: return20,
    spy_return_20d: spyReturn20,
    rs_vs_spy_20d: return20 != null && spyReturn20 != null ? return20 - spyReturn20 : null,
    rsi14: rsi.length > 0 ? rsi[rsi.length - 1] : null,
    rsi14_min_20d: rsiLast20 ? Math.min(...rsiLast20) : null,
    rsi14_max_20d: rsiLast20 ? Math.max(...rsiLast20) : null,
    hv20,
    week_open: weekOpen,
    month_open: monthOpen,
    close_vs_week_open: ratio(close, weekOpen),
    close_vs_month_open: ratio(close, monthOpen),
    stp_htf_opens: stpHtfOpens(close, weekOpen, monthOpen),
  };
}
