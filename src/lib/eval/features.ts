/**
 * Per-feature validation, docs/PHASE3-PREP.md P3-0b under docs/PHASE3-PREREG.md.
 *
 * For one feature:
 *   - Numeric: quintile cut points are computed on the TRAINING rows only and applied
 *     to the test rows (no test data leaks into the buckets). Categorical (boolean or
 *     string): each category is its own bucket. Missing values are reported as their
 *     own bucket but are never selected.
 *   - The bucket to test is the one with the highest training mean excess return (with
 *     at least MIN_FOLD_ROWS training rows), chosen without looking at the test rows.
 *   - Held out (newest 30% of scans): that bucket must beat the baseline (all test rows)
 *     on 7-day mean excess AND hit rate, with at least MIN_HELDOUT_ROWS rows.
 *   - Walk-forward (3 folds): the same procedure on each fold; at least 2 must pass.
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

/** Feature keys to test: every key of the logged families plus scan regime keys, minus exclusions. */
export function candidateKeys(rows: readonly EvalRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.attrs)) {
    if (EXCLUDED_KEYS.has(k)) continue;
    if (k.startsWith("regime.") || familyOf(k)) keys.add(k);
  }
  return [...keys].sort();
}

export type FeatureKind = "numeric" | "categorical" | "skipped";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function featureKind(rows: readonly EvalRow[], key: string): FeatureKind {
  const vals = rows.map((r) => r.attrs[key]).filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return "skipped";
  if (vals.every(isNum)) return "numeric";
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
  return String(value);
}

export interface BucketStats {
  bucket: string;
  train: Metrics;
  test: Metrics;
}

export interface SplitResult {
  selected: string | null;
  buckets: BucketStats[];
  baseline: Metrics;
  passed: boolean;
}

/** Bucket on `train` (cuts from train only), pick the best training bucket, test it on `test`. */
export function testSplit(train: readonly EvalRow[], test: readonly EvalRow[], key: string, kind: FeatureKind, minTest: number): SplitResult {
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
  const buckets = names.map((b) => ({ bucket: b, train: metrics(tr.get(b) ?? [], PRIMARY_HORIZON), test: metrics(te.get(b) ?? [], PRIMARY_HORIZON) }));
  let selected: string | null = null;
  let best = -Infinity;
  for (const b of buckets) {
    if (b.bucket === MISSING || b.train.n < MIN_FOLD_ROWS || b.train.meanExcess == null) continue;
    if (b.train.meanExcess > best) {
      best = b.train.meanExcess;
      selected = b.bucket;
    }
  }
  const baseline = metrics(test, PRIMARY_HORIZON);
  const sel = buckets.find((b) => b.bucket === selected)?.test;
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
  const kind = featureKind(rows, key);
  const { train, test } = timeSplit(rows);
  const heldOut = testSplit(train, test, key, kind, MIN_HELDOUT_ROWS);
  const folds = walkForwardFolds(rows).map((f) => testSplit(f.train, f.test, key, kind, MIN_FOLD_ROWS));
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
