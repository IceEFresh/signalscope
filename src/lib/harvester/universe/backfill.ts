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
/**
 * Calendar days of bars fetched before the first backfilled session. P3-0k2: 300 (was 120,
 * the P3-0g spec), so sma200 and its 5-session slope (~205 sessions) exist from the start
 * of the window; override with --warmup-days. The live-window slices don't change.
 */
export const WARMUP_DAYS = 300;

/** --warmup-days N (default WARMUP_DAYS); a non-positive or non-numeric value is an error. */
export function warmupDaysArg(argv: readonly string[]): number {
  const i = argv.indexOf("--warmup-days");
  if (i < 0) return WARMUP_DAYS;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--warmup-days must be a positive whole number (got ${argv[i + 1]})`);
  return n;
}

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

// ── P3-0k5: the window for --years N (5 by default for P3-0k3/0k4 reruns) ─────────

const DAY_MS = 86_400_000;

/** Fetch window and backfilled date range for `years` plus the warm-up (calendar days). */
export function backfillWindow(now: Date, years: number, warmupDays = WARMUP_DAYS): { period1: number; period2: number; fetchFrom: string; since: string; until: string } {
  if (!(years > 0)) throw new Error(`--years must be positive (got ${years})`);
  const p1 = now.getTime() - (years * 365 + warmupDays) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    period1: Math.floor(p1 / 1000),
    period2: Math.floor(now.getTime() / 1000),
    fetchFrom: iso(p1),
    since: iso(now.getTime() - years * 365 * DAY_MS),
    until: iso(now.getTime()),
  };
}

/** Days of slack before a cached chart counts as starting late (weekends, holidays). */
export const COVER_SLACK_DAYS = 10;

/**
 * True when a cached Yahoo chart already reaches back to `period1` (within 10 days), or starts
 * at the symbol's first trade (a later IPO can't do better). A chart cached for a shorter window
 * (a 2-year run, then --years 5) is false, so it's refetched.
 */
export function chartCoversWindow(json: unknown, period1: number): boolean {
  const r = (json as { chart?: { result?: Array<{ timestamp?: unknown; meta?: { firstTradeDate?: unknown } }> } } | null)?.chart?.result?.[0];
  const ts = Array.isArray(r?.timestamp) ? (r!.timestamp as unknown[]) : [];
  const first = typeof ts[0] === "number" ? (ts[0] as number) : null;
  if (first == null) return false;
  if (first <= period1 + COVER_SLACK_DAYS * 86_400) return true;
  const ftd = r?.meta?.firstTradeDate;
  return typeof ftd === "number" && first <= ftd + COVER_SLACK_DAYS * 86_400;
}
