/**
 * Phase 3 evaluation rows from stored scans (pure). Joins each ValidatedTicker with its
 * TickerPerformance returns and computes SPY's return over the same window, so the
 * primary metric is return vs SPY (PLAN.md Phase 3).
 *
 * SPY window: from the last SPY close before the ticker's detection to the last close
 * before each return's snapshot. "Before" means a session whose 16:00 ET close had
 * passed at that instant, so an 08:30 ET scan starts from the prior session's close,
 * the same price the detection used.
 *
 * Eligible rows: in the scan's liquid universe (PR 1-0) and no corporate action detected.
 * Everything in `attrs` was known at scan time; returns live only in `ret` / `excess`.
 */
import { etParts } from "@/lib/harvester/universe/bar-metrics";
import { HORIZONS, type EvalRow, type Horizon } from "./rules";

export interface StoredTickerRow {
  scanId: string;
  scanStartedAt: Date;
  symbol: string;
  inUniverse: boolean | null;
  stage: string;
  recommendation: string | null;
  aiScore: number;
  opportunityScore: number;
  sourceCount: number;
  signalType: string | null;
  features: Record<string, unknown> | null;
  regimeFeatures: Record<string, unknown> | null;
  performance: {
    corporateActionDetected: boolean;
    return1d: number | null;
    return3d: number | null;
    return7d: number | null;
    snapped1dAt: Date | null;
    snapped3dAt: Date | null;
    snapped7dAt: Date | null;
  } | null;
}

export interface SpyClose {
  date: string; // YYYY-MM-DD (ET session date)
  close: number;
}

const CLOSE_MINUTES = 16 * 60;

/** SPY close of the last session completed at `at` (null if none in the series). */
export function lastCompletedClose(spy: readonly SpyClose[], at: Date): number | null {
  const { date, minutes } = etParts(at);
  let best: SpyClose | null = null;
  for (const c of spy) {
    const done = c.date < date || (c.date === date && minutes >= CLOSE_MINUTES);
    if (done && (!best || c.date > best.date)) best = c;
  }
  return best?.close ?? null;
}

export function spyReturn(spy: readonly SpyClose[], from: Date, to: Date): number | null {
  const a = lastCompletedClose(spy, from);
  const b = lastCompletedClose(spy, to);
  return a != null && b != null && a > 0 ? b / a - 1 : null;
}

export function isEligible(r: StoredTickerRow): boolean {
  return r.inUniverse === true && r.performance != null && !r.performance.corporateActionDetected;
}

export function buildEvalRows(rows: readonly StoredTickerRow[], spy: readonly SpyClose[]): EvalRow[] {
  const out: EvalRow[] = [];
  for (const r of rows) {
    if (!isEligible(r)) continue;
    const p = r.performance!;
    const ret: Partial<Record<Horizon, number | null>> = { "1d": p.return1d, "3d": p.return3d, "7d": p.return7d };
    const snapped: Record<Horizon, Date | null> = { "1d": p.snapped1dAt, "3d": p.snapped3dAt, "7d": p.snapped7dAt };
    const excess: Partial<Record<Horizon, number | null>> = {};
    for (const h of HORIZONS) {
      const raw = ret[h];
      const end = snapped[h];
      const bench = end ? spyReturn(spy, r.scanStartedAt, end) : null;
      excess[h] = raw != null && bench != null ? raw - bench : null;
    }
    const regime = Object.fromEntries(Object.entries(r.regimeFeatures ?? {}).map(([k, v]) => [`regime.${k}`, v]));
    out.push({
      scanId: r.scanId,
      scanStart: r.scanStartedAt,
      symbol: r.symbol,
      ret,
      excess,
      attrs: {
        ...(r.features ?? {}),
        ...regime,
        stage: r.stage,
        recommendation: r.recommendation,
        aiScore: r.aiScore,
        opportunityScore: r.opportunityScore,
        sourceCount: r.sourceCount,
        signalType: r.signalType,
      },
    });
  }
  return out;
}
