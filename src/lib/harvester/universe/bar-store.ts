/**
 * Persistent daily-bar store for the live swing keys (docs/PHASE3-PREP.md P3-0i2b, Chris:
 * option D). LOG ONLY.
 *
 * The live swing profiles need 250 sessions; the harvest chart has about 63. The store
 * keeps up to STORE_SESSIONS completed sessions per symbol, one file each, in the same
 * Yahoo chart-JSON shape as scripts/output/backfill-bars (so the backfill cache seeds it
 * by copying). Each harvest merges its chart into the file:
 * - only completed sessions are kept: dates before the run's session date;
 * - a date in both takes the chart's values;
 * - if a close on a shared date differs by more than 1%, Yahoo has re-adjusted the history
 *   (split or dividend), so a 2-year chart is fetched and the file rewritten;
 * - a symbol with no file gets one 2-year chart (new universe members).
 * A failed read, write or fetch is counted and logged; it never stops the harvest.
 */
import { etParts, parseChartBars, type DailyBar } from "./bar-metrics";

export const STORE_SESSIONS = 600;
export const READJUST_TOLERANCE = 0.01;
export const MIN_SWING_SESSIONS = 250;
export const STORE_COVERAGE_WARN = 0.8;

const dateOf = (b: DailyBar): string | null => (b.time != null ? etParts(new Date(b.time * 1000)).date : null);

/** Bars as a minimal Yahoo chart JSON that parseChartBars reads back. */
export function toChartJson(bars: readonly DailyBar[]): unknown {
  return {
    chart: {
      result: [
        {
          meta: { dataGranularity: "1d", source: "bar-store" },
          timestamp: bars.map((b) => b.time ?? null),
          indicators: {
            quote: [
              {
                open: bars.map((b) => b.open ?? null),
                high: bars.map((b) => b.high),
                low: bars.map((b) => b.low),
                close: bars.map((b) => b.close),
                volume: bars.map((b) => b.volume),
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * Merge `chart` into `stored` by date: chart values win, only dates before `sessionDate`
 * are kept, oldest first, capped at the newest STORE_SESSIONS.
 */
export function mergeBars(stored: readonly DailyBar[], chart: readonly DailyBar[], sessionDate: string, cap = STORE_SESSIONS): DailyBar[] {
  const byDate = new Map<string, DailyBar>();
  for (const b of stored) {
    const d = dateOf(b);
    if (d && d < sessionDate) byDate.set(d, b);
  }
  for (const b of chart) {
    const d = dateOf(b);
    if (d && d < sessionDate) byDate.set(d, b);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, b]) => b).slice(-cap);
}

/** True when a close on a date both series have differs by more than 1% (a re-adjusted history). */
export function isReadjusted(stored: readonly DailyBar[], chart: readonly DailyBar[], tolerance = READJUST_TOLERANCE): boolean {
  const s = new Map(stored.map((b) => [dateOf(b), b.close]));
  for (const b of chart) {
    const old = s.get(dateOf(b));
    if (old != null && old > 0 && Math.abs(b.close / old - 1) > tolerance) return true;
  }
  return false;
}

export interface BarStoreIO {
  /** Stored chart JSON for a symbol, or null when there's no file. Throws on a read error. */
  read: (symbol: string) => unknown | null;
  write: (symbol: string, json: unknown) => void;
  /** A 2-year chart JSON from Yahoo, or null on failure. */
  fetch2y: (symbol: string) => Promise<unknown | null>;
}

export interface BarStoreStats {
  members: number;
  withMinSessions: number;
  readjusted: number;
  seededNew: number;
  writeErrors: number;
  fetchErrors: number;
}

/**
 * Update the store for `symbols` from this run's charts (`chartBars`, completed bars).
 * Returns each symbol's merged history (for the swing keys) and the run's stats.
 */
export async function updateBarStore(
  symbols: readonly string[],
  chartBars: (symbol: string) => Promise<DailyBar[] | null>,
  io: BarStoreIO,
  now: Date = new Date(),
): Promise<{ histories: Map<string, DailyBar[]>; stats: BarStoreStats }> {
  const sessionDate = etParts(now).date;
  const histories = new Map<string, DailyBar[]>();
  const stats: BarStoreStats = { members: symbols.length, withMinSessions: 0, readjusted: 0, seededNew: 0, writeErrors: 0, fetchErrors: 0 };
  for (const sym of symbols) {
    try {
      const chart = (await chartBars(sym)) ?? [];
      let stored: DailyBar[] = [];
      let raw: unknown | null = null;
      try {
        raw = io.read(sym);
      } catch {
        raw = null; // unreadable: treated like a missing file
      }
      let refetch = raw == null;
      if (raw != null) {
        stored = parseChartBars(raw, now);
        if (isReadjusted(stored, chart)) {
          refetch = true;
          stats.readjusted++;
        }
      }
      if (refetch) {
        const json = await io.fetch2y(sym).catch(() => null);
        if (json) {
          stored = parseChartBars(json, now);
          if (raw == null) stats.seededNew++;
        } else {
          stats.fetchErrors++;
          if (raw != null) stored = []; // re-adjusted but no fresh history: start over from the chart
        }
      }
      const merged = mergeBars(stored, chart, sessionDate);
      histories.set(sym, merged);
      if (merged.length >= MIN_SWING_SESSIONS) stats.withMinSessions++;
      try {
        io.write(sym, toChartJson(merged));
      } catch {
        stats.writeErrors++;
      }
    } catch (err) {
      stats.writeErrors++;
      console.warn(`[bar-store] ${sym}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { histories, stats };
}

export function barStoreLine(s: BarStoreStats): { line: string; warn: boolean } {
  const warn = s.members > 0 && s.withMinSessions / s.members < STORE_COVERAGE_WARN;
  return {
    line: `[bar-store] ${s.withMinSessions}/${s.members} members with ≥${MIN_SWING_SESSIONS} sessions, ${s.readjusted} re-adjusted, ${s.seededNew} seeded new, ${s.writeErrors} write errors, ${s.fetchErrors} fetch errors`,
    warn,
  };
}

/** Store bars plus this run's chart, deduped by date (chart wins) and cut to bars ≤ the chart's last date. */
export function swingHistory(stored: readonly DailyBar[] | undefined, chart: readonly DailyBar[]): DailyBar[] {
  const last = chart.length ? dateOf(chart[chart.length - 1]) : null;
  if (!last) return [...chart];
  const dayAfter = new Date(`${last}T12:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  return mergeBars(stored ?? [], chart, dayAfter.toISOString().slice(0, 10), Infinity);
}
