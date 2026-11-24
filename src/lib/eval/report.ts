/**
 * P3-0b report output (pure): a markdown report with per-bucket tables for the
 * held-out set and each fold, and one summary row for scripts/backtesting-experiments.md
 * ("log every run, kept or not").
 */
import { PRIMARY_HORIZON, WALK_FORWARD_FOLDS, type Metrics } from "./rules";
import type { FeatureResult, SplitResult } from "./features";

const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(2)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

export function summarizeMetrics(m: Metrics): string {
  return `n=${m.n} hit=${pct(m.hitRate)} excess=${pct(m.meanExcess)}`;
}

/** Highest experiment number already in the log (0 if none). */
export function lastExperimentNumber(markdown: string): number {
  let max = 0;
  for (const m of markdown.matchAll(/^\|\s*(\d+)\s*\|/gm)) max = Math.max(max, Number(m[1]));
  return max;
}

function splitTable(title: string, s: SplitResult): string[] {
  const lines = [
    `**${title}** (bucket tested: ${s.selected ?? "none"}; baseline ${summarizeMetrics(s.baseline)}; ${s.passed ? "pass" : "fail"})`,
    "",
    "| bucket | train n | train hit | train excess | test n | test tickers | test hit | test excess |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const b of s.buckets) {
    const mark = b.bucket === s.selected ? " ←" : "";
    lines.push(`| ${b.bucket}${mark} | ${b.train.n} | ${pct(b.train.hitRate)} | ${pct(b.train.meanExcess)} | ${b.test.n} | ${b.testTickers} | ${pct(b.test.hitRate)} | ${pct(b.test.meanExcess)} |`);
  }
  return [...lines, ""];
}

export function markdownReport(results: readonly FeatureResult[], meta: { date: string; commit: string; rows: number; scans: number }): string {
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  const out = [
    `# Phase 3 feature validation, ${meta.date} (${meta.commit})`,
    "",
    `${meta.rows} eligible rows from ${meta.scans} scans. ${results.length} features tested (= ${results.length} comparisons): ` +
      `${count("KEEP")} KEEP, ${count("DROP")} DROP, ${count("INSUFFICIENT")} INSUFFICIENT. Primary metric: ${PRIMARY_HORIZON} excess return vs SPY.`,
    "",
    "| feature | kind | verdict | held-out n (distinct tickers) | reason |",
    "|---|---|---|---|---|",
    ...results.map((r) => {
      const b = r.heldOut.buckets.find((x) => x.bucket === r.heldOut.selected);
      return `| ${r.key} | ${r.kind} | ${r.verdict} | ${b ? `${b.test.n} (${b.testTickers})` : "n/a"} | ${cell(r.reason)} |`;
    }),
    "",
  ];
  for (const r of results) {
    out.push(`## ${r.key}: ${r.verdict}`, "", ...splitTable("Held out (newest 30%)", r.heldOut));
    r.folds.forEach((f, i) => out.push(...splitTable(`Fold ${i + 1} of ${WALK_FORWARD_FOLDS}`, f)));
  }
  return out.join("\n");
}

/** One summary row for the experiment log, in its 14-column layout. */
export function experimentSummaryRow(results: readonly FeatureResult[], meta: { number: number; date: string; commit: string; rows: number; scans: number; reportPath: string }): string {
  const keep = results.filter((r) => r.verdict === "KEEP");
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  const desc =
    `PHASE 3 VALIDATION (P3-0b): ${results.length} features / comparisons on ${meta.rows} rows from ${meta.scans} scans. ` +
    `${keep.length} KEEP, ${count("DROP")} DROP, ${count("INSUFFICIENT")} INSUFFICIENT. A KEEP is a reason for a rule-change PR, not the change. Report: ${meta.reportPath}.`;
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${results.length} | quintile buckets (prereg) | ${keep.length ? "keep" : "discard"} | ${cell(keep.map((r) => r.key).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
