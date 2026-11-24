/**
 * Pre-registered Phase 3 candidates, one per log-only feature from Phases 1-2, written
 * before any results exist. Each selects rows from scan-time attributes; the baseline
 * is every eligible row in the same window. Thresholds are fixed here on purpose:
 * tuning them after seeing results would be fitting to the test set. A new or changed
 * candidate gets its own PR and experiment-log entry.
 *
 * With this many candidates a few may pass by chance; the walk-forward requirement
 * (2 of 3 folds) is the guard, and a "keep" is a reason for a rule-change PR, not the change.
 */
import type { Candidate, EvalRow } from "./rules";

const num = (r: EvalRow, k: string): number | null => {
  const v = r.attrs[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const is = (r: EvalRow, k: string, v: unknown) => r.attrs[k] === v;

export const CANDIDATES: readonly Candidate[] = [
  // Current production labels, as the reference every new rule must beat
  { id: "rec_buy_or_strong", description: "Current rules: Buy or Strong Buy", select: (r) => is(r, "recommendation", "Buy") || is(r, "recommendation", "Strong Buy") },
  // 2a insiders (Cohen, Malloy & Pomorski)
  { id: "insider_opportunistic", description: "2a: at least one opportunistic insider buy", select: (r) => is(r, "insider_class", "opportunistic") },
  // 2b politicians (Belmont et al.: expected to fail)
  { id: "politician_only_catalyst", description: "2b: an elected politician is the only hard catalyst", select: (r) => is(r, "politician_only_catalyst", true) },
  // 2c Reddit (Bradley et al.)
  { id: "reddit_dd", description: "2c: at least one long-form DD post", select: (r) => (num(r, "reddit_dd_count") ?? 0) > 0 },
  { id: "reddit_hype_only", description: "2c: Reddit hype posts and no DD post", select: (r) => (num(r, "reddit_hype_count") ?? 0) > 0 && (num(r, "reddit_dd_count") ?? 0) === 0 },
  // 2e / 1h options
  { id: "alp_large_prints", description: "2e: at least one $100K+ option print last session", select: (r) => (num(r, "alp_large_prints") ?? 0) > 0 },
  { id: "opt_iv_cheap", description: "1h: ATM 30d IV below HV20 (IV/HV20 < 1)", select: (r) => { const v = num(r, "opt_iv_hv20_ratio"); return v != null && v < 1; } },
  { id: "opt_call_skew", description: "1h: put/call volume ratio below 0.5", select: (r) => { const v = num(r, "opt_pc_volume_ratio"); return v != null && v < 0.5; } },
  // 1a bars
  { id: "above_rising_sma20", description: "1a: close above SMA20 and SMA20 rising over 5 days", select: (r) => (num(r, "close_vs_sma20") ?? -1) > 0 && (num(r, "sma20_slope_5d") ?? -1) > 0 },
  { id: "nr7", description: "1a: NR7 (narrowest range of 7 days)", select: (r) => is(r, "nr7", true) },
  { id: "rs_vs_spy_positive", description: "1a: 20-day return beats SPY's", select: (r) => (num(r, "rs_vs_spy_20d") ?? -1) > 0 },
  // 1b earnings
  { id: "no_earnings_5d", description: "1b: no earnings within 5 days", select: (r) => is(r, "earnings_within_5d", false) },
  // 1c regime
  { id: "spy_above_sma20", description: "1c: SPY above its SMA20 at scan time", select: (r) => is(r, "regime.spy_above_sma20", true) },
  // 1f sector rotation
  { id: "sector_rotating_in", description: "1f: sector rank improved over 4 weeks", select: (r) => (num(r, "sector_rank_change_4w") ?? 0) > 0 },
];
