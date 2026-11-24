/**
 * Macro context fields, docs/PHASE3-PREP.md P3-0f. LOG ONLY: stored in
 * Scan.regimeFeatures under `macro`, one value per scan. For conditioning other
 * features in Phase 3+; not a pre-registered candidate until there are 6+ months of
 * scans.
 *
 * Series (Yahoo daily charts through the shared cache and retry):
 *   DX-Y.NYB (US dollar index; UUP when it returns no data), HYG / LQD (credit),
 *   ^TNX / ^IRX (10-year and 13-week Treasury yields), GLD / DBB (already fetched for
 *   sector rotation), BTC-USD (complete UTC days, as in P3-0e).
 *
 * Yield scale [Certain on the 2026-11-24 fixtures]: Yahoo quotes ^TNX and ^IRX in
 * percent (4.904 = 4.904%). Yahoo has quoted ^TNX ×10 in the past (49.04), so any
 * close above 25 is divided by 10. `yield_*` and `curve_*` are in percentage points.
 *
 * Every field uses completed bars dated on or before `macro_bar_date`, the latest
 * session every available stock-market series has completed. A missing series gives
 * null fields and a warning, never a failed harvest.
 */
import { etParts, type DailyBar } from "./bar-metrics";
import { sma } from "./bar-features";

export const MACRO_VERSION = 1;
export const MACRO_SYMBOLS = {
  dxy: "DX-Y.NYB",
  dxyFallback: "UUP",
  hyg: "HYG",
  lqd: "LQD",
  tnx: "^TNX",
  irx: "^IRX",
  gld: "GLD",
  dbb: "DBB",
  btc: "BTC-USD",
} as const;
/** A yield quote above this is taken to be ×10 (Yahoo's old ^TNX scale). */
export const YIELD_X10_THRESHOLD = 25;

export interface MacroFeatures {
  macro_version: number;
  macro_bar_date: string | null;
  /** Which dollar series filled dxy_*: "DX-Y.NYB", "UUP" (fallback, a different price scale) or null. */
  dxy_source: string | null;
  dxy_close: number | null;
  dxy_return_20d: number | null;
  dxy_vs_sma50: number | null;
  credit_ratio: number | null;
  credit_ratio_change_20d: number | null;
  yield_10y: number | null;
  yield_3m: number | null;
  curve_10y_3m: number | null;
  curve_change_20d: number | null;
  copper_gold_ratio: number | null;
  copper_gold_change_20d: number | null;
  btc_return_20d: number | null;
  btc_vs_sma50: number | null;
}

export interface MacroInput {
  dxy: DailyBar[] | null;
  uup: DailyBar[] | null;
  hyg: DailyBar[] | null;
  lqd: DailyBar[] | null;
  tnx: DailyBar[] | null;
  irx: DailyBar[] | null;
  gld: DailyBar[] | null;
  dbb: DailyBar[] | null;
  /** Complete UTC-day bars (parseCryptoBars). */
  btc: DailyBar[] | null;
}

const dateOf = (b: DailyBar): string | null => (b.time != null ? etParts(new Date(b.time * 1000)).date : null);

/** Close by date for bars dated ≤ `until`. */
function closesUntil(bars: readonly DailyBar[] | null, until: string | null): Map<string, number> {
  const m = new Map<string, number>();
  if (!bars || !until) return m;
  for (const b of bars) {
    const d = dateOf(b);
    if (d && d <= until) m.set(d, b.close);
  }
  return m;
}

const ratio = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b === 0 ? null : a / b - 1);

/** close/close 20 sessions earlier − 1, and close/SMA50 − 1, on one series. */
function trend(closes: number[]): { last: number | null; ret20: number | null; vsSma50: number | null } {
  const n = closes.length;
  const last = n ? closes[n - 1] : null;
  return { last, ret20: n >= 21 ? ratio(last, closes[n - 21]) : null, vsSma50: ratio(last, sma(closes, 50)) };
}

/** a/b on the dates both have, oldest first. */
function pairRatio(a: Map<string, number>, b: Map<string, number>): number[] {
  return [...a.keys()].filter((d) => b.has(d) && b.get(d)! !== 0).sort().map((d) => a.get(d)! / b.get(d)!);
}

export function normalizeYield(v: number): number {
  return v > YIELD_X10_THRESHOLD ? v / 10 : v;
}

/** Latest date that every available (non-null, non-empty) stock-market series has. */
export function commonBarDate(series: ReadonlyArray<readonly DailyBar[] | null>): string | null {
  const sets = series.filter((s): s is readonly DailyBar[] => !!s && s.length > 0).map((s) => new Set(s.map(dateOf).filter((d): d is string => !!d)));
  if (sets.length === 0) return null;
  const common = [...sets[0]].filter((d) => sets.every((s) => s.has(d))).sort();
  return common.at(-1) ?? null;
}

export function computeMacro(input: MacroInput): MacroFeatures {
  const dxyBars = input.dxy && input.dxy.length > 0 ? input.dxy : input.uup && input.uup.length > 0 ? input.uup : null;
  const dxySource = dxyBars === input.dxy && dxyBars ? MACRO_SYMBOLS.dxy : dxyBars ? MACRO_SYMBOLS.dxyFallback : null;
  const until = commonBarDate([dxyBars, input.hyg, input.lqd, input.tnx, input.irx, input.gld, input.dbb]);

  const sorted = (m: Map<string, number>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const dxy = trend(sorted(closesUntil(dxyBars, until)));

  const credit = pairRatio(closesUntil(input.hyg, until), closesUntil(input.lqd, until));
  const cu = pairRatio(closesUntil(input.dbb, until), closesUntil(input.gld, until));

  const tnx = closesUntil(input.tnx, until);
  const irx = closesUntil(input.irx, until);
  const curveDates = [...tnx.keys()].filter((d) => irx.has(d)).sort();
  const curve = curveDates.map((d) => normalizeYield(tnx.get(d)!) - normalizeYield(irx.get(d)!));
  const lastOf = (m: Map<string, number>) => {
    const k = [...m.keys()].sort().at(-1);
    return k ? normalizeYield(m.get(k)!) : null;
  };

  // BTC: complete UTC days up to the same date, so it never looks past the stock session.
  const btc = trend(sorted(closesUntil(input.btc, until)));

  const at = (xs: number[], back: number) => (xs.length > back ? xs[xs.length - 1 - back] : null);
  return {
    macro_version: MACRO_VERSION,
    macro_bar_date: until,
    dxy_source: dxySource,
    dxy_close: dxy.last,
    dxy_return_20d: dxy.ret20,
    dxy_vs_sma50: dxy.vsSma50,
    credit_ratio: at(credit, 0),
    credit_ratio_change_20d: ratio(at(credit, 0), at(credit, 20)),
    yield_10y: lastOf(tnx),
    yield_3m: lastOf(irx),
    curve_10y_3m: at(curve, 0),
    curve_change_20d: at(curve, 0) != null && at(curve, 20) != null ? at(curve, 0)! - at(curve, 20)! : null,
    copper_gold_ratio: at(cu, 0),
    copper_gold_change_20d: ratio(at(cu, 0), at(cu, 20)),
    btc_return_20d: btc.ret20,
    btc_vs_sma50: btc.vsSma50,
  };
}

/** Which series were missing, for the harvest warning. */
export function missingMacroSeries(input: MacroInput): string[] {
  const out: string[] = [];
  if (!input.dxy?.length) out.push(input.uup?.length ? `${MACRO_SYMBOLS.dxy} (using ${MACRO_SYMBOLS.dxyFallback})` : `${MACRO_SYMBOLS.dxy} and ${MACRO_SYMBOLS.dxyFallback}`);
  for (const k of ["hyg", "lqd", "tnx", "irx", "gld", "dbb", "btc"] as const) if (!input[k]?.length) out.push(MACRO_SYMBOLS[k]);
  return out;
}
