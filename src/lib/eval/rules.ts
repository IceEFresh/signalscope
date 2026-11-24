/**
 * Phase 3 testing rules (PLAN.md "Phase 3: Validate"), written as code before any
 * results exist. Changing a constant here after looking at results defeats the
 * point: do it in its own PR with an entry in scripts/backtesting-experiments.md.
 *
 * - Split by time, never randomly: train on older scans, test on the newest 30%.
 * - Primary metric: 7-day hit rate and mean return vs SPY. Secondary: 1d and 3d.
 * - Keep a candidate only if it beats the baseline on the held-out set AND in at
 *   least 2 of 3 walk-forward folds.
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
  /** Everything a candidate rule may read, all known at scan time. */
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

/** Distinct scans in time order. A scan is never split across train and test. */
function scanOrder(rows: readonly EvalRow[]): string[] {
  const first = new Map<string, number>();
  for (const r of rows) {
    const t = r.scanStart.getTime();
    if (!first.has(r.scanId) || t < first.get(r.scanId)!) first.set(r.scanId, t);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/** Train on the oldest scans, test on the newest TEST_FRACTION of scans. */
export function timeSplit(rows: readonly EvalRow[], testFraction = TEST_FRACTION): { train: EvalRow[]; test: EvalRow[] } {
  const scans = scanOrder(rows);
  const cut = Math.floor(scans.length * (1 - testFraction));
  const testScans = new Set(scans.slice(cut));
  return { train: rows.filter((r) => !testScans.has(r.scanId)), test: rows.filter((r) => testScans.has(r.scanId)) };
}

/** Expanding-window walk-forward: k+1 time blocks of scans; fold i tests block i+1. */
export function walkForwardFolds(rows: readonly EvalRow[], k = WALK_FORWARD_FOLDS): Array<{ train: EvalRow[]; test: EvalRow[] }> {
  const scans = scanOrder(rows);
  const blocks = k + 1;
  const blockOf = new Map(scans.map((id, i) => [id, Math.min(blocks - 1, Math.floor((i * blocks) / Math.max(1, scans.length)))]));
  const folds: Array<{ train: EvalRow[]; test: EvalRow[] }> = [];
  for (let i = 0; i < k; i++) {
    folds.push({
      train: rows.filter((r) => blockOf.get(r.scanId)! <= i),
      test: rows.filter((r) => blockOf.get(r.scanId)! === i + 1),
    });
  }
  return folds;
}

export interface Candidate {
  id: string;
  description: string;
  /** Selects the rows the rule would act on, from scan-time attributes only. */
  select: (row: EvalRow) => boolean;
}

export type Verdict = "keep" | "discard" | "insufficient";

export interface CandidateResult {
  id: string;
  description: string;
  verdict: Verdict;
  reason: string;
  heldOut: Record<Horizon, Metrics>;
  baselineHeldOut: Record<Horizon, Metrics>;
  folds: Array<{ selected: Metrics; baseline: Metrics; passed: boolean }>;
}

/** Selected beats baseline on the primary metric: higher mean excess AND higher hit rate. */
export function beats(sel: Metrics, base: Metrics): boolean {
  return (
    sel.meanExcess != null && base.meanExcess != null && sel.hitRate != null && base.hitRate != null &&
    sel.meanExcess > base.meanExcess && sel.hitRate > base.hitRate
  );
}

/**
 * Evaluate one candidate against the baseline (every eligible row in the same window).
 * The candidate needs no fitting, so walk-forward train sets are unused; the folds test
 * whether the edge holds in each later block of time, not just in the last 30%.
 */
export function evaluateCandidate(rows: readonly EvalRow[], c: Candidate): CandidateResult {
  const all = (h: Horizon, rs: readonly EvalRow[]) => metrics(rs, h);
  const { test } = timeSplit(rows);
  const sel = test.filter(c.select);
  const heldOut = Object.fromEntries(HORIZONS.map((h) => [h, all(h, sel)])) as Record<Horizon, Metrics>;
  const baselineHeldOut = Object.fromEntries(HORIZONS.map((h) => [h, all(h, test)])) as Record<Horizon, Metrics>;
  const folds = walkForwardFolds(rows).map((f) => {
    const s = metrics(f.test.filter(c.select), PRIMARY_HORIZON);
    const b = metrics(f.test, PRIMARY_HORIZON);
    return { selected: s, baseline: b, passed: s.n >= MIN_FOLD_ROWS && beats(s, b) };
  });
  const p = heldOut[PRIMARY_HORIZON];
  const foldsPassed = folds.filter((f) => f.passed).length;
  let verdict: Verdict;
  let reason: string;
  if (p.n < MIN_HELDOUT_ROWS) {
    verdict = "insufficient";
    reason = `${p.n} held-out rows with a ${PRIMARY_HORIZON} return (need ${MIN_HELDOUT_ROWS})`;
  } else if (!beats(p, baselineHeldOut[PRIMARY_HORIZON])) {
    verdict = "discard";
    reason = `does not beat the held-out baseline on ${PRIMARY_HORIZON} mean excess and hit rate`;
  } else if (foldsPassed < FOLDS_REQUIRED) {
    verdict = "discard";
    reason = `beats the held-out baseline but holds in only ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds (need ${FOLDS_REQUIRED})`;
  } else {
    verdict = "keep";
    reason = `beats the held-out baseline and holds in ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds`;
  }
  return { id: c.id, description: c.description, verdict, reason, heldOut, baselineHeldOut, folds };
}
