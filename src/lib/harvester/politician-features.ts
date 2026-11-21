/**
 * Elected-politician trades as their own feature, PLAN.md PR 2b (Belmont et al.
 * 2022: congressional trades show no reliable abnormal return after disclosure).
 * Chris's decision: cover any elected politician, so keys are `politician_*` with
 * an office per trade. The internal source enum stays `CONGRESS` (renaming it
 * would need a non-additive migration). LOG ONLY: the keys go into
 * ValidatedTicker.features. CONGRESS stays in HARD_CATALYST_SOURCES until the
 * ablation in scripts/calibrate-recommendation.ts is run and logged in
 * scripts/backtesting-experiments.md.
 *
 * Politician trades count as a catalyst in two places, and a removal must decide both:
 *   1. HARD_CATALYST_SOURCES (recommendation.ts): Buy / Strong Buy rule paths.
 *   2. The social-only score cap (scoring.ts): without a catalyst, aiScore <= 50.
 * The ablation reports each separately.
 */
import { HARD_CATALYST_SOURCES, deriveRecommendation, type Recommendation, type RecommendationInput } from "./recommendation";
import type { RawSignal, Source } from "./types";

/** HARD_CATALYST_SOURCES minus CONGRESS (elected politicians): the candidate set the ablation tests. */
export const HARD_CATALYST_SOURCES_WITHOUT_POLITICIANS: ReadonlySet<Source> = new Set(
  [...HARD_CATALYST_SOURCES].filter((s) => s !== "CONGRESS"),
);

/** The social-only cap in scoring.ts. */
export const SOCIAL_ONLY_SCORE_CAP = 50;

/**
 * Office of a politician trade: the signal's `office` when the source sets it,
 * else read from the "Sen." / "Rep." author prefix Capitol Trades rows carry.
 */
export function politicianOffice(s: RawSignal): string | null {
  if (s.office) return s.office;
  if (s.author?.startsWith("Sen. ")) return "senate";
  if (s.author?.startsWith("Rep. ")) return "house";
  return null;
}

/** Per-ticker politician keys for features (log only). Empty when the ticker has no politician trade. */
export function politicianFeatures(signals: readonly RawSignal[]): Record<string, number | boolean | string | null> {
  const pol = signals.filter((s) => s.source === "CONGRESS");
  if (pol.length === 0) return {};
  const sources = new Set(signals.map((s) => s.source));
  const gaps = pol.map((s) => s.reportingGapDays).filter((g): g is number => typeof g === "number");
  const values = pol.map((s) => s.purchaseValue).filter((v): v is number => typeof v === "number");
  const offices = [...new Set(pol.map(politicianOffice).filter((o): o is string => !!o))].sort();
  const otherCatalyst = [...sources].some((s) => HARD_CATALYST_SOURCES_WITHOUT_POLITICIANS.has(s));
  return {
    politician_count: pol.length,
    /** Distinct politicians by author ("Sen. <name>" / "Rep. <name>"); signals without an author are not counted. */
    politician_members: new Set(pol.map((s) => s.author).filter((a): a is string => !!a)).size,
    /** Distinct offices, sorted and comma-joined, e.g. "house,senate". Null when none is known. */
    politician_offices: offices.length ? offices.join(",") : null,
    politician_value_total: values.length ? values.reduce((a, b) => a + b, 0) : null,
    politician_min_reporting_gap_days: gaps.length ? Math.min(...gaps) : null,
    politician_max_reporting_gap_days: gaps.length ? Math.max(...gaps) : null,
    /** A politician trade is the ticker's only hard catalyst: the rows a removal would change. */
    politician_only_catalyst: !otherCatalyst,
  };
}

/** One scored row as the calibration script sees it, with its signal sources. */
export interface AblationRow {
  input: RecommendationInput;
  sources: ReadonlySet<Source>;
}

export interface AblationResult {
  current: Recommendation;
  /** CONGRESS (elected politicians) removed from HARD_CATALYST_SOURCES only. */
  withoutPoliticianRules: Recommendation;
  /** Also apply the social-only cap to politician-only-catalyst rows. */
  withoutPoliticianRulesAndCap: Recommendation;
}

/** Recommendation for one row today and with politician trades removed as a catalyst. Pure. */
export function politicianAblation(row: AblationRow): AblationResult {
  const hasOther = [...row.sources].some((s) => HARD_CATALYST_SOURCES_WITHOUT_POLITICIANS.has(s));
  const noRule: RecommendationInput = { ...row.input, hasCatalystSource: hasOther };
  const capped: RecommendationInput =
    hasOther || !row.sources.has("CONGRESS")
      ? noRule
      : { ...noRule, aiScore: Math.min(row.input.aiScore, SOCIAL_ONLY_SCORE_CAP) };
  return {
    current: deriveRecommendation(row.input),
    withoutPoliticianRules: deriveRecommendation(noRule),
    withoutPoliticianRulesAndCap: deriveRecommendation(capped),
  };
}
