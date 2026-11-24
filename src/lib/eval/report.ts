/**
 * Phase 3 report output (pure): a console table and rows for
 * scripts/backtesting-experiments.md ("log every run, kept or not").
 */
import { FOLDS_REQUIRED, HORIZONS, PRIMARY_HORIZON, WALK_FORWARD_FOLDS, type CandidateResult, type Metrics } from "./rules";

const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(2)}%`);
const dec = (v: number | null) => (v == null ? "n/a" : v.toFixed(4));
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

/** One experiment-log row per candidate, numbered after `startAfter`. */
export function experimentRows(results: readonly CandidateResult[], opts: { date: string; commit: string; startAfter: number }): string[] {
  return results.map((r, i) => {
    const folds = r.folds.filter((f) => f.passed).length;
    const p = r.heldOut[PRIMARY_HORIZON];
    const b = r.baselineHeldOut[PRIMARY_HORIZON];
    const desc =
      `PHASE 3 HARNESS: ${r.description}. Held-out ${PRIMARY_HORIZON}: ${summarizeMetrics(p)} vs baseline ${summarizeMetrics(b)}; ` +
      `folds passed ${folds}/${WALK_FORWARD_FOLDS} (need ${FOLDS_REQUIRED}). ${r.reason}. Returns columns = held-out mean excess vs SPY.`;
    return `| ${opts.startAfter + i + 1} | ${opts.date} | ${opts.commit} | ${HORIZONS.map((h) => dec(r.heldOut[h].meanExcess)).join(" | ")} | 1 | rule (phase3 harness) | ${r.verdict} | ${r.id} | n/a | n/a | n/a | ${cell(desc)} |`;
  });
}

export function consoleTable(results: readonly CandidateResult[]): string {
  const lines = [`${"candidate".padEnd(26)} ${"verdict".padEnd(12)} held-out ${PRIMARY_HORIZON} (vs baseline)  folds`];
  for (const r of results) {
    const p = r.heldOut[PRIMARY_HORIZON];
    const b = r.baselineHeldOut[PRIMARY_HORIZON];
    lines.push(
      `${r.id.padEnd(26)} ${r.verdict.padEnd(12)} ${summarizeMetrics(p)} (base ${pct(b.meanExcess)}, hit ${pct(b.hitRate)})  ${r.folds.filter((f) => f.passed).length}/${WALK_FORWARD_FOLDS}`,
    );
  }
  return lines.join("\n");
}
