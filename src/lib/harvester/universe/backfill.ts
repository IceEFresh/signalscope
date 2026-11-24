/**
 * P3-0g price-history backfill (pure), docs/PHASE3-PREP.md. LOG ONLY.
 *
 * Rebuilds the price-only UniverseSnapshot features (1a bar features + 1g STP states)
 * for past sessions. For each session D the features are computed on the bars dated
 * ≤ D only, by slicing, never on the full series. The slice is also cut to the same
 * window the live harvest sees (Yahoo range=3mo, i.e. bars after D minus 3 calendar
 * months), so Wilder RSI/ATR and the period opens match what a live run on D+1 would
 * have computed. Sector and regime are left out: both depend on live inputs.
 *
 * Linking: UniverseSnapshot is unique on (scanId, symbol), so each session gets its
 * own synthetic Scan (id `backfill-v1-YYYY-MM-DD`). Those scans are marked with
 * status FAILED and an `error` starting with BACKFILL_SCAN_PREFIX (no migration;
 * Chris, 2026-11-24): every live reader filters status COMPLETED, so none of them
 * sees a backfill scan.
 */
import { etParts, type DailyBar } from "./bar-metrics";
import { computeStp } from "./stp";
import { BENCHMARK_SYMBOL, snapshotRow, type SnapshotRow } from "./snapshot";

export const BACKFILL_VERSION = 1;
export const BACKFILL_SCAN_PREFIX = "backfill:v1";
export const BACKFILL_SCAN_ERROR = `${BACKFILL_SCAN_PREFIX} synthetic scan for the P3-0g price backfill, not a harvest`;
/** Calendar months of bars the live harvest fetches (dailyChartUrl range=3mo). */
export const LIVE_WINDOW_MONTHS = 3;
/** Warm-up before the first backfilled session (spec: 120 days). */
export const WARMUP_DAYS = 120;

export class BackfillLookAheadError extends Error {}

export const barDateOf = (b: DailyBar): string | null => (b.time != null ? etParts(new Date(b.time * 1000)).date : null);

export function backfillScanId(sessionDate: string): string {
  return `backfill-v${BACKFILL_VERSION}-${sessionDate}`;
}

/** Scan start for a backfilled session: 21:00 UTC on D (after the close, still D in ET), so the harness's session ≤ scan-date check holds. */
export function backfillScanStartedAt(sessionDate: string): Date {
  return new Date(`${sessionDate}T21:00:00Z`);
}

export function isBackfillFeatures(f: Record<string, unknown> | null | undefined): boolean {
  return f?.backfill === true;
}

/** First date of the live window for session D: the same day-of-month 3 months earlier (exclusive). */
export function windowStart(sessionDate: string, months = LIVE_WINDOW_MONTHS): string {
  const d = new Date(`${sessionDate}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * Bars a live run would have seen for session D: dated ≤ D and after windowStart(D).
 * Throws if the newest bar used isn't dated D (the spec's in-code assertion).
 */
export function sliceForSession(bars: readonly DailyBar[], sessionDate: string): DailyBar[] {
  const start = windowStart(sessionDate);
  const out = bars.filter((b) => {
    const d = barDateOf(b);
    return d != null && d > start && d <= sessionDate;
  });
  const newest = out.length ? barDateOf(out[out.length - 1]) : null;
  if (newest !== sessionDate) {
    throw new BackfillLookAheadError(`backfill slice for ${sessionDate} ends at ${newest ?? "nothing"}, refusing to compute`);
  }
  return out;
}

/** Sessions to backfill: SPY's completed bar dates in (since, until]. */
export function backfillSessions(spyBars: readonly DailyBar[], since: string, until: string): string[] {
  return [...new Set(spyBars.map(barDateOf).filter((d): d is string => d != null && d > since && d <= until))].sort();
}

/**
 * Backfill rows for one symbol: one per session in `sessions` on which the symbol has
 * a bar. A session with no bar for the symbol (halt, not yet listed) is skipped.
 */
export function backfillRowsForSymbol(
  symbol: string,
  bars: readonly DailyBar[],
  spyBars: readonly DailyBar[],
  sessions: readonly string[],
  keepKeys?: ReadonlySet<string>,
): SnapshotRow[] {
  const have = new Set(bars.map(barDateOf));
  const spyHave = new Set(spyBars.map(barDateOf));
  const out: SnapshotRow[] = [];
  for (const d of sessions) {
    if (!have.has(d) || !spyHave.has(d)) continue;
    const slice = sliceForSession(bars, d);
    const spySlice = symbol === BENCHMARK_SYMBOL ? slice : sliceForSession(spyBars, d);
    const row = snapshotRow(symbol, slice, spySlice, computeStp(slice));
    if (!row) continue;
    if (row.sessionDate !== d) throw new BackfillLookAheadError(`backfill row for ${symbol} on ${d} describes ${row.sessionDate}`);
    const features = keepKeys ? Object.fromEntries(Object.entries(row.features).filter(([k]) => keepKeys.has(k))) : row.features;
    out.push({ ...row, features: { ...features, backfill: true, backfill_version: BACKFILL_VERSION } });
  }
  return out;
}

/** Rows not yet stored, for resuming a partial run. `stored` holds `${scanId}|${symbol}`. */
export function pendingRows(rows: readonly SnapshotRow[], stored: ReadonlySet<string>): SnapshotRow[] {
  return rows.filter((r) => !stored.has(`${backfillScanId(r.sessionDate)}|${r.symbol}`));
}

/** Size of the features JSON in bytes, for the 20-symbol projection. */
export function featureBytes(rows: readonly SnapshotRow[]): number {
  return rows.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r.features)), 0);
}
