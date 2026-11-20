/**
 * Universe rule for PR 1-0 (docs/PLAN.md). Thresholds are [Guessing] starting
 * points to tune; changing them needs an entry in scripts/backtesting-experiments.md.
 */
import type { BarMetrics } from "./bar-metrics";

export const UNIVERSE_RULE = {
  minPrice: 5,
  minDollarVolume20d: 25_000_000,
  minMarketCap: 500_000_000,
  /** Volatility passes if either ATR% or 20-day HV clears its bar. */
  minAtrPct: 0.03,
  minHv20: 0.4,
  requireOptions: true,
  excludeEtfs: true,
} as const;

export type UniverseCriterion = "etf" | "price" | "dollarVolume" | "marketCap" | "volatility" | "options";

export interface UniverseRuleInput {
  /** Yahoo quoteType, e.g. "EQUITY" or "ETF". null = unknown. */
  quoteType: string | null;
  price: number | null;
  marketCap: number | null;
  metrics: BarMetrics | null;
  /** null = not checked yet (e.g. pre-filter stage). */
  hasOptions: boolean | null;
}

export interface UniverseRuleResult {
  passes: boolean;
  /** Criteria that failed or could not be evaluated (missing data fails). */
  failing: UniverseCriterion[];
}

export function evaluateUniverseRule(input: UniverseRuleInput): UniverseRuleResult {
  const failing: UniverseCriterion[] = [];
  const r = UNIVERSE_RULE;
  const qt = input.quoteType?.toUpperCase() ?? null;
  if (r.excludeEtfs && qt !== "EQUITY") failing.push("etf");
  const price = input.price ?? input.metrics?.lastClose ?? null;
  if (price == null || price < r.minPrice) failing.push("price");
  const dv = input.metrics?.dollarVolume20d ?? null;
  if (dv == null || dv < r.minDollarVolume20d) failing.push("dollarVolume");
  if (input.marketCap == null || input.marketCap < r.minMarketCap) failing.push("marketCap");
  const atr = input.metrics?.atrPct ?? null;
  const hv = input.metrics?.hv20 ?? null;
  const volOk = (atr != null && atr >= r.minAtrPct) || (hv != null && hv >= r.minHv20);
  if (!volOk) failing.push("volatility");
  if (r.requireOptions && input.hasOptions !== true) failing.push("options");
  return { passes: failing.length === 0, failing };
}

/** Criteria that failed last check and pass now. */
export function flippedCriteria(previous: readonly string[], now: readonly string[]): string[] {
  const nowSet = new Set(now);
  return previous.filter((c) => !nowSet.has(c));
}
