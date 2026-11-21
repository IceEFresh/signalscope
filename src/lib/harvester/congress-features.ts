/**
 * CONGRESS as its own feature, PLAN.md PR 2b (Belmont et al. 2022: congressional
 * trades show no reliable abnormal return after disclosure). LOG ONLY: the keys
 * below go into ValidatedTicker.features. CONGRESS stays in HARD_CATALYST_SOURCES
 * until the ablation in scripts/calibrate-recommendation.ts is run and logged in
 * scripts/backtesting-experiments.md.
 *
 * CONGRESS counts as a catalyst in two places, and a removal must decide both:
 *   1. HARD_CATALYST_SOURCES (recommendation.ts): Buy / Strong Buy rule paths.
 *   2. The social-only score cap (scoring.ts): without a catalyst, aiScore <= 50.
 * The ablation reports each separately.
 */
import { HARD_CATALYST_SOURCES, deriveRecommendation, type Recommendation, type RecommendationInput } from "./recommendation";
import type { RawSignal, Source } from "./types";

/** HARD_CATALYST_SOURCES minus CONGRESS: the candidate set the ablation tests. */
export const HARD_CATALYST_SOURCES_WITHOUT_CONGRESS: ReadonlySet<Source> = new Set(
  [...HARD_CATALYST_SOURCES].filter((s) => s !== "CONGRESS"),
);

/** The social-only cap in scoring.ts. */
export const SOCIAL_ONLY_SCORE_CAP = 50;

/** Per-ticker congress keys for features (log only). Empty when the ticker has no CONGRESS signal. */
export function congressFeatures(signals: readonly RawSignal[]): Record<string, number | boolean | null> {
  const cong = signals.filter((s) => s.source === "CONGRESS");
  if (cong.length === 0) return {};
  const sources = new Set(signals.map((s) => s.source));
  const gaps = cong.map((s) => s.reportingGapDays).filter((g): g is number => typeof g === "number");
  const values = cong.map((s) => s.purchaseValue).filter((v): v is number => typeof v === "number");
  const otherCatalyst = [...sources].some((s) => HARD_CATALYST_SOURCES_WITHOUT_CONGRESS.has(s));
  return {
    congress_count: cong.length,
    /** Distinct members by author ("<chamber> <name>"); signals without an author are not counted. */
    congress_members: new Set(cong.map((s) => s.author).filter((a): a is string => !!a)).size,
    congress_value_total: values.length ? values.reduce((a, b) => a + b, 0) : null,
    congress_min_reporting_gap_days: gaps.length ? Math.min(...gaps) : null,
    congress_max_reporting_gap_days: gaps.length ? Math.max(...gaps) : null,
    /** CONGRESS is the ticker's only hard catalyst: the rows a removal would change. */
    congress_only_catalyst: !otherCatalyst,
  };
}

/** One scored row as the calibration script sees it, with its signal sources. */
export interface AblationRow {
  input: RecommendationInput;
  sources: ReadonlySet<Source>;
}

export interface AblationResult {
  current: Recommendation;
  /** CONGRESS removed from HARD_CATALYST_SOURCES only. */
  withoutCongressRules: Recommendation;
  /** Also apply the social-only cap to congress-only-catalyst rows. */
  withoutCongressRulesAndCap: Recommendation;
}

/** Recommendation for one row today and with CONGRESS removed as a catalyst. Pure. */
export function congressAblation(row: AblationRow): AblationResult {
  const hasOther = [...row.sources].some((s) => HARD_CATALYST_SOURCES_WITHOUT_CONGRESS.has(s));
  const noRule: RecommendationInput = { ...row.input, hasCatalystSource: hasOther };
  const capped: RecommendationInput =
    hasOther || !row.sources.has("CONGRESS")
      ? noRule
      : { ...noRule, aiScore: Math.min(row.input.aiScore, SOCIAL_ONLY_SCORE_CAP) };
  return {
    current: deriveRecommendation(row.input),
    withoutCongressRules: deriveRecommendation(noRule),
    withoutCongressRulesAndCap: deriveRecommendation(capped),
  };
}
