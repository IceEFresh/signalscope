/**
 * P3-0c universe dataset (pure): EvalRows from UniverseSnapshot, one per symbol per
 * session. Outcomes come from later snapshots of the same symbol, no new fetches:
 * the 1/3/7-day return of a row at session D uses the snapshot closes at the 1st, 3rd
 * and 7th trading session after D on the SPY calendar. A session with no snapshot for
 * that symbol (holiday is already off the calendar; a missed run or a dropped symbol)
 * leaves the outcome null; nothing is interpolated. SPY over the same sessions is the
 * benchmark, so excess = return − SPY return.
 *
 * Look-ahead: a row's features must describe a session no later than its scan date,
 * and every outcome session must be strictly after the row's. Either violation
 * stops the run (LookAheadError).
 */
import { etParts } from "@/lib/harvester/universe/bar-metrics";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { LookAheadError, type SpyClose } from "./dataset";
import { HORIZONS, type EvalRow, type Horizon } from "./rules";

export interface StoredSnapshotRow {
  scanId: string;
  scanStartedAt: Date;
  symbol: string;
  sessionDate: string;
  close: number;
  features: Record<string, unknown> | null;
  regimeFeatures: Record<string, unknown> | null;
}

const OFFSET: Record<Horizon, number> = { "1d": 1, "3d": 3, "7d": 7 };

export function buildUniverseRows(rows: readonly StoredSnapshotRow[], spy: readonly SpyClose[]): EvalRow[] {
  const calendar = [...new Set(spy.map((c) => c.date))].sort();
  const pos = new Map(calendar.map((d, i) => [d, i]));
  const spyClose = new Map(spy.map((c) => [c.date, c.close]));

  // One row per (symbol, session): if two scans saw the same session, keep the earliest scan.
  const sorted = [...rows].sort((a, b) => a.scanStartedAt.getTime() - b.scanStartedAt.getTime());
  const seen = new Set<string>();
  const unique: StoredSnapshotRow[] = [];
  const closes = new Map<string, Map<string, number>>();
  for (const r of sorted) {
    const scanDate = etParts(r.scanStartedAt).date;
    if (r.sessionDate > scanDate) {
      throw new LookAheadError(`look-ahead: ${r.scanId}/${r.symbol} features for session ${r.sessionDate} after scan date ${scanDate}, refusing to run`);
    }
    const key = `${r.symbol}|${r.sessionDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (!closes.has(r.symbol)) closes.set(r.symbol, new Map());
    closes.get(r.symbol)!.set(r.sessionDate, r.close);
  }

  const out: EvalRow[] = [];
  for (const r of unique) {
    if (r.symbol === BENCHMARK_SYMBOL) continue;
    const i = pos.get(r.sessionDate);
    const ret: Partial<Record<Horizon, number | null>> = {};
    const excess: Partial<Record<Horizon, number | null>> = {};
    for (const h of HORIZONS) {
      const target = i == null ? undefined : calendar[i + OFFSET[h]];
      if (target != null && target <= r.sessionDate) {
        throw new LookAheadError(`look-ahead: outcome session ${target} not after ${r.sessionDate}, refusing to run`);
      }
      const c = target ? closes.get(r.symbol)?.get(target) : undefined;
      const s0 = spyClose.get(r.sessionDate);
      const s1 = target ? spyClose.get(target) : undefined;
      ret[h] = c != null && r.close > 0 ? c / r.close - 1 : null;
      excess[h] = ret[h] != null && s0 && s1 ? (ret[h] as number) - (s1 / s0 - 1) : null;
    }
    const regime = Object.fromEntries(Object.entries(r.regimeFeatures ?? {}).map(([k, v]) => [`regime.${k}`, v]));
    out.push({ scanId: r.scanId, scanStart: r.scanStartedAt, symbol: r.symbol, ret, excess, attrs: { ...(r.features ?? {}), ...regime } });
  }
  return out;
}
