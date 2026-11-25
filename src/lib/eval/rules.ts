/**
 * Phase 3 testing rules (PLAN.md "Phase 3: Validate"), written as code before any
 * results exist (docs/PHASE3-PREREG.md). Changing a constant here after looking at
 * results defeats the point: do it in its own PR with an entry in
 * scripts/backtesting-experiments.md.
 *
 * - Split by time, never randomly: train on older scans, test on the newest 30%.
 * - Primary metric: 7-day hit rate and mean return vs SPY. Secondary: 1d and 3d.
 * - Keep a feature only if it beats the baseline on the held-out set AND in at
 *   least 2 of 3 walk-forward folds (see features.ts for how a feature is tested).
 * - No verdict for a bucket with fewer than 100 held-out rows.
 */

export const TEST_FRACTION = 0.3;
export const WALK_FORWARD_FOLDS = 3;
export const FOLDS_REQUIRED = 2;
export const MIN_HELDOUT_ROWS = 100;
/** [Assumption] A walk-forward fold with fewer test rows than this counts as a failed fold. */
export const MIN_FOLD_ROWS = 30;
export const PRIMARY_HORIZON = "7d" as const;
export const HORIZONS = ["1d", "3d", "7d"] as const;
export type Horizon = (typeof HORIZONS)[number];

/** One scored ticker with its outcomes, as the evaluation sees it. */
export interface EvalRow {
  scanId: string;
  scanStart: Date;
  symbol: string;
  /** Return from detection price (raw). */
  ret: Partial<Record<Horizon, number | null>>;
  /** Return minus SPY's over the same window; null when either side is missing. */
  excess: Partial<Record<Horizon, number | null>>;
  /** Everything a feature test may read, all known at scan time. */
  attrs: Record<string, unknown>;
}

export interface Metrics {
  n: number;
  hitRate: number | null; // share with excess return > 0
  meanExcess: number | null;
  meanRaw: number | null;
}

export function metrics(rows: readonly EvalRow[], h: Horizon): Metrics {
  const xs = rows.map((r) => r.excess[h]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const raws = rows.map((r) => r.ret[h]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return {
    n: xs.length,
    hitRate: xs.length ? xs.filter((v) => v > 0).length / xs.length : null,
    meanExcess: mean(xs),
    meanRaw: mean(raws),
  };
}

/** Anything the time split can order: one scan (or trigger date) id and its time. */
export interface TimeKeyed {
  scanId: string;
  scanStart: Date;
}

/** Distinct scans in time order. A scan is never split across train and test. */
function scanOrder(rows: readonly TimeKeyed[]): string[] {
  const first = new Map<string, number>();
  for (const r of rows) {
    const t = r.scanStart.getTime();
    if (!first.has(r.scanId) || t < first.get(r.scanId)!) first.set(r.scanId, t);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/** Train on the oldest scans, test on the newest TEST_FRACTION of scans. */
export function timeSplit<T extends TimeKeyed = EvalRow>(rows: readonly T[], testFraction = TEST_FRACTION): { train: T[]; test: T[] } {
  const scans = scanOrder(rows);
  const cut = Math.floor(scans.length * (1 - testFraction));
  const testScans = new Set(scans.slice(cut));
  return { train: rows.filter((r) => !testScans.has(r.scanId)), test: rows.filter((r) => testScans.has(r.scanId)) };
}

/** Expanding-window walk-forward: k+1 time blocks of scans; fold i tests block i+1. */
export function walkForwardFolds<T extends TimeKeyed = EvalRow>(rows: readonly T[], k = WALK_FORWARD_FOLDS): Array<{ train: T[]; test: T[] }> {
  const scans = scanOrder(rows);
  const blocks = k + 1;
  const blockOf = new Map(scans.map((id, i) => [id, Math.min(blocks - 1, Math.floor((i * blocks) / Math.max(1, scans.length)))]));
  const folds: Array<{ train: T[]; test: T[] }> = [];
  for (let i = 0; i < k; i++) {
    folds.push({
      train: rows.filter((r) => blockOf.get(r.scanId)! <= i),
      test: rows.filter((r) => blockOf.get(r.scanId)! === i + 1),
    });
  }
  return folds;
}

/** Selected rows beat the baseline on the primary metric: higher mean excess AND higher hit rate. */
export function beats(sel: Metrics, base: Metrics): boolean {
  return (
    sel.meanExcess != null && base.meanExcess != null && sel.hitRate != null && base.hitRate != null &&
    sel.meanExcess > base.meanExcess && sel.hitRate > base.hitRate
  );
}
