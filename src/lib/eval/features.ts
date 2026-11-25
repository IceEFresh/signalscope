/**
 * Per-feature validation, docs/PHASE3-PREP.md P3-0b under docs/PHASE3-PREREG.md.
 *
 * For one feature:
 *   - Numeric: quintile cut points are computed on the TRAINING rows only and applied
 *     to the test rows (no test data leaks into the buckets). Categorical (boolean or
 *     string): each category is its own bucket. Missing values are reported as their
 *     own bucket but are never selected.
 *   - Discrete (P3-0h, amendment 2026-11-25): a numeric key with at most
 *     MAX_DISCRETE_VALUES distinct non-null values in the held-out split's training rows
 *     is bucketed by value (`=-1`, `=0`, `=1`), never by quintile. Quintile cuts on
 *     such keys merge values (e.g. −1 and 0 into one "q1"). The kind is decided once per
 *     feature and used by the held-out split and every fold.
 *   - The bucket to test is the one with the highest training mean excess return (with
 *     at least MIN_FOLD_ROWS training rows), chosen without looking at the test rows.
 *   - Held out (newest 30% of scans): that bucket must beat the baseline (all test rows)
 *     on 7-day mean excess AND hit rate, with at least MIN_HELDOUT_ROWS rows.
 *   - Walk-forward (3 folds): each fold tests THAT SAME bucket (same category, or the same
 *     quintile rank under the fold's own training cut points) against the fold's baseline;
 *     at least 2 must pass. A fold never chooses its own bucket.
 * Verdict: KEEP, DROP, or INSUFFICIENT (too few rows to judge).
 */
import { familyOf } from "@/lib/health/harvest-health";
import {
  beats,
  metrics,
  timeSplit,
  walkForwardFolds,
  FOLDS_REQUIRED,
  MIN_FOLD_ROWS,
  MIN_HELDOUT_ROWS,
  PRIMARY_HORIZON,
  WALK_FORWARD_FOLDS,
  type EvalRow,
  type Metrics,
} from "./rules";

export const QUINTILES = 5;
/** Categorical features with more categories than this are skipped (listed in the pre-registration). */
export const MAX_CATEGORIES = 12;
export const MISSING = "missing";
/** P3-0h: numeric keys with this many distinct training values or fewer are bucketed by value. */
export const MAX_DISCRETE_VALUES = 7;

/**
 * Keys never tested: version stamps, dates, model names, bases, data-quality flags,
 * expiry-choice bookkeeping and raw price levels that aren't comparable across
 * tickers. Fixed in docs/PHASE3-PREREG.md.
 */
export const EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "features_version", "bar_date", "close", "week_open", "month_open", "atr14",
  "earnings_date", "industry", "opt_features_version", "alp_version",
  "insider_class_basis", "reddit_post_type_basis", "shadow_ai_model",
  "alp_snapshots_capped", "alp_trades_capped", "opt_near_days", "opt_far_days",
  "regime.regime_version", "regime.spy_bar_date", "regime.spy_close",
]);

/**
 * Feature keys to test: every key of the logged families plus scan regime keys, minus
 * exclusions. `macro.*` (P3-0f) are conditioning columns, never candidates here.
 */
export function candidateKeys(rows: readonly EvalRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.attrs)) {
    if (EXCLUDED_KEYS.has(k) || k.startsWith("macro.")) continue;
    if (k.startsWith("regime.") || familyOf(k)) keys.add(k);
  }
  return [...keys].sort();
}

export type FeatureKind = "numeric" | "discrete" | "categorical" | "skipped";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Kind of a feature. `trainRows` (the held-out split's training rows) decide whether a
 * numeric key is discrete; without them, the rows themselves do.
 */
export function featureKind(rows: readonly EvalRow[], key: string, trainRows: readonly EvalRow[] = rows): FeatureKind {
  const vals = rows.map((r) => r.attrs[key]).filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return "skipped";
  if (vals.every(isNum)) {
    const distinct = new Set(trainRows.map((r) => r.attrs[key]).filter(isNum));
    return distinct.size <= MAX_DISCRETE_VALUES ? "discrete" : "numeric";
  }
  const cats = new Set(vals.map(String));
  return cats.size <= MAX_CATEGORIES ? "categorical" : "skipped";
}

/** Quintile cut points (20/40/60/80th percentiles, nearest rank) of the training values. */
export function quintileCuts(values: readonly number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return [];
  return [1, 2, 3, 4].map((q) => s[Math.min(s.length - 1, Math.ceil((q / QUINTILES) * s.length) - 1)]);
}

export function bucketOf(value: unknown, kind: FeatureKind, cuts: readonly number[]): string {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return MISSING;
  if (kind === "numeric") {
    const v = value as number;
    const i = cuts.findIndex((c) => v <= c);
    return `q${(i === -1 ? cuts.length : i) + 1}`;
  }
  if (kind === "discrete") return `=${value as number}`;
  return String(value);
}

export interface BucketStats {
  bucket: string;
  train: Metrics;
  test: Metrics;
  /** Distinct tickers among the test rows: overlapping 7-day windows mean n overstates independent observations. */
  testTickers: number;
}

export interface SplitResult {
  selected: string | null;
  buckets: BucketStats[];
  baseline: Metrics;
  passed: boolean;
}

/**
 * Bucket `train` and `test` with cut points from `train` only, then test one bucket on
 * `test`. Without `fixed`, the bucket is the best training bucket (the held-out split).
 * With `fixed`, that bucket is tested as given (walk-forward folds): the same category,
 * or the same quintile rank under this fold's own training cut points. A fold never
 * picks its own best bucket, so "holds in 2 of 3 folds" means the same effect held.
 */
export function testSplit(
  train: readonly EvalRow[],
  test: readonly EvalRow[],
  key: string,
  kind: FeatureKind,
  minTest: number,
  fixed?: string | null,
): SplitResult {
  const cuts = kind === "numeric" ? quintileCuts(train.map((r) => r.attrs[key]).filter(isNum)) : [];
  const group = (rows: readonly EvalRow[]) => {
    const m = new Map<string, EvalRow[]>();
    for (const r of rows) {
      const b = bucketOf(r.attrs[key], kind, cuts);
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(r);
    }
    return m;
  };
  const tr = group(train);
  const te = group(test);
  const names = [...new Set([...tr.keys(), ...te.keys()])].sort();
  const buckets = names.map((b) => ({
    bucket: b,
    train: metrics(tr.get(b) ?? [], PRIMARY_HORIZON),
    test: metrics(te.get(b) ?? [], PRIMARY_HORIZON),
    testTickers: new Set((te.get(b) ?? []).map((r) => r.symbol)).size,
  }));
  let selected: string | null = null;
  if (fixed !== undefined) {
    selected = fixed;
  } else {
    let best = -Infinity;
    for (const b of buckets) {
      if (b.bucket === MISSING || b.train.n < MIN_FOLD_ROWS || b.train.meanExcess == null) continue;
      if (b.train.meanExcess > best) {
        best = b.train.meanExcess;
        selected = b.bucket;
      }
    }
  }
  const baseline = metrics(test, PRIMARY_HORIZON);
  const sel = selected == null ? undefined : buckets.find((b) => b.bucket === selected)?.test;
  return { selected, buckets, baseline, passed: !!sel && sel.n >= minTest && beats(sel, baseline) };
}

export type FeatureVerdict = "KEEP" | "DROP" | "INSUFFICIENT";

export interface FeatureResult {
  key: string;
  kind: FeatureKind;
  verdict: FeatureVerdict;
  reason: string;
  heldOut: SplitResult;
  folds: SplitResult[];
}

export function evaluateFeature(rows: readonly EvalRow[], key: string): FeatureResult {
  const { train, test } = timeSplit(rows);
  const kind = featureKind(rows, key, train);
  const heldOut = testSplit(train, test, key, kind, MIN_HELDOUT_ROWS);
  // Each fold tests the bucket chosen on the held-out split's training rows, not its own best.
  const folds = walkForwardFolds(rows).map((f) => testSplit(f.train, f.test, key, kind, MIN_FOLD_ROWS, heldOut.selected));
  const passed = folds.filter((f) => f.passed).length;
  const sel = heldOut.buckets.find((b) => b.bucket === heldOut.selected)?.test;
  let verdict: FeatureVerdict;
  let reason: string;
  if (kind === "skipped") {
    verdict = "INSUFFICIENT";
    reason = `no usable values (all missing, or more than ${MAX_CATEGORIES} categories)`;
  } else if (!heldOut.selected) {
    verdict = "INSUFFICIENT";
    reason = `no training bucket with ${MIN_FOLD_ROWS}+ rows`;
  } else if (!sel || sel.n < MIN_HELDOUT_ROWS) {
    verdict = "INSUFFICIENT";
    reason = `bucket ${heldOut.selected} has ${sel?.n ?? 0} held-out rows with a ${PRIMARY_HORIZON} return (need ${MIN_HELDOUT_ROWS})`;
  } else if (!heldOut.passed) {
    verdict = "DROP";
    reason = `bucket ${heldOut.selected} does not beat the held-out baseline on ${PRIMARY_HORIZON} mean excess and hit rate`;
  } else if (passed < FOLDS_REQUIRED) {
    verdict = "DROP";
    reason = `bucket ${heldOut.selected} beats the held-out baseline but holds in only ${passed} of ${WALK_FORWARD_FOLDS} folds (need ${FOLDS_REQUIRED})`;
  } else {
    verdict = "KEEP";
    reason = `bucket ${heldOut.selected} beats the held-out baseline and holds in ${passed} of ${WALK_FORWARD_FOLDS} folds`;
  }
  return { key, kind, verdict, reason, heldOut, folds };
}
