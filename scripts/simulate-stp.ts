// P3-0i: STP trigger trade simulation on the backfill bars (docs/PHASE3-PREP.md), under
// the rules fixed in docs/PHASE3-PREREG.md "STP trigger trades (P3-0i)". Read-only: no
// database access at all; it reads the P3-0g chart cache in scripts/output/backfill-bars/.
// The DB backfill rows hold only closes, so they can't stand in for the cache.
//
// On the NAS (same pattern as validate-features):
//   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
//     -v "$PWD/scripts/backtesting-experiments.md:/app/scripts/backtesting-experiments.md" \
//     -e NODE_OPTIONS=--max-old-space-size=6144 -e GIT_COMMIT=$(git rev-parse --short HEAD) \
//     harvester npx tsx scripts/simulate-stp.ts --dataset backfill
// Options: --exit A|B (default both), --years 2, --dry-run (summary only). Exit B (STP management,
// §1e) is primary and gets the verdicts; exit A (fixed 3R) is a reference with no verdicts.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, etParts, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { backfillSessions } from "@/lib/harvester/universe/backfill";
import { commitId } from "@/lib/eval/commit";
import { lastExperimentNumber } from "@/lib/eval/report";
import { emptyCounts, evaluateGroups, PRIMARY_EXIT, scanSymbol, setupOverlap, simulateSymbol, spyRegimeByDate, type ExitRule, type Overlap, type SymbolCounts, type Trade, type Variant } from "@/lib/eval/stp-sim";
import { simExperimentRow, simMarkdownReport, tradesCsv } from "@/lib/eval/stp-sim-report";

const CACHE_DIR = "scripts/output/backfill-bars";
const LOG_PATH = "scripts/backtesting-experiments.md";
const DAY = 86_400_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const dataset = arg("--dataset") ?? "backfill";
  if (dataset !== "backfill") throw new Error(`only --dataset backfill is supported (got ${dataset})`);
  const requested = arg("--exit")?.toUpperCase();
  if (requested && requested !== "A" && requested !== "B") throw new Error(`--exit must be A or B (got ${requested})`);
  const exits: ExitRule[] = requested ? [requested as ExitRule] : ["B", "A"];
  const years = Number(arg("--years") ?? 2);
  const dryRun = process.argv.includes("--dry-run");
  if (!existsSync(CACHE_DIR)) throw new Error(`${CACHE_DIR} not found: run scripts/backfill-snapshot.ts first (its chart cache is the input)`);

  const now = new Date();
  const load = (file: string): DailyBar[] => parseChartBars(JSON.parse(readFileSync(join(CACHE_DIR, file), "utf8")), now);
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  const spyFile = `${BENCHMARK_SYMBOL}.json`;
  if (!files.includes(spyFile)) throw new Error(`${spyFile} missing from ${CACHE_DIR}`);
  const spy = load(spyFile);
  const sessionList = backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, etParts(now).date);
  const sessions = new Set(sessionList);
  const regime = spyRegimeByDate(spy);
  const symbols = files.filter((f) => f !== spyFile).map((f) => f.replace(/\.json$/, "")).sort();
  console.log(`[stp-sim] ${symbols.length} symbols, ${sessionList.length} sessions ${sessionList[0]}..${sessionList.at(-1)}, exits ${exits.join(", ")}`);

  const t0 = Date.now();
  const fresh = () => ({ trades: [] as Trade[], counts: { calendar: emptyCounts(), rolling: emptyCounts() } as Record<Variant, SymbolCounts> });
  const byExit: Record<ExitRule, ReturnType<typeof fresh>> = { A: fresh(), B: fresh() };
  const overlap: Overlap = { both: 0, calendarOnly: 0, rollingOnly: 0 };
  for (const [k, sym] of symbols.entries()) {
    let bars: DailyBar[];
    try {
      bars = load(`${sym}.json`);
    } catch {
      console.warn(`[stp-sim] ${sym}: unreadable cache file, skipped`);
      continue;
    }
    if (bars.length < 60) continue;
    const scanned = scanSymbol(sym, bars, sessions); // once per symbol (stocks: rolling 5/20), shared by both exits
    const o = setupOverlap(scanned.setups, scanned.rollingSetups);
    overlap.both += o.both;
    overlap.calendarOnly += o.calendarOnly;
    overlap.rollingOnly += o.rollingOnly;
    for (const exit of exits)
      for (const variant of ["calendar", "rolling"] as const) {
        const r = simulateSymbol(sym, bars, exit, { regime, scanned, variant });
        byExit[exit].trades.push(...r.trades);
        for (const key of Object.keys(r.counts) as (keyof SymbolCounts)[]) byExit[exit].counts[variant][key] += r.counts[key];
      }
    if ((k + 1) % 100 === 0) console.log(`[stp-sim] ${k + 1}/${symbols.length} symbols, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const date = now.toISOString().slice(0, 10);
  const commit = commitId();
  for (const exit of exits) {
    const { trades, counts } = byExit[exit];
    const results = evaluateGroups(trades, { verdicts: exit === PRIMARY_EXIT });
    const prim = results.filter((r) => r.primary);
    const n = (v: string) => prim.filter((r) => r.verdict === v).length;
    const verdictText = exit === PRIMARY_EXIT ? `primary groups ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT` : "reference exit, no verdicts";
    console.log(`P3-0i exit ${exit}: ${trades.length} trades (${counts.calendar.filled} calendar, ${counts.rolling.filled} rolling); ${verdictText}`);
    for (const r of prim.filter((x) => x.verdict === "KEEP")) console.log(`  KEEP ${r.group}: ${r.reason}`);
    if (dryRun) continue;
    mkdirSync("scripts/output", { recursive: true });
    const reportPath = `scripts/output/stp-sim-backfill-exit${exit}-${date}.md`;
    writeFileSync(reportPath, simMarkdownReport(results, counts.calendar, { date, commit, exit, symbols: symbols.length, rollingCounts: counts.rolling, overlap }));
    writeFileSync(`scripts/output/stp-sim-backfill-exit${exit}-${date}-trades.csv`, tradesCsv(trades));
    const md = readFileSync(LOG_PATH, "utf8");
    const row = simExperimentRow(results, { number: lastExperimentNumber(md) + 1, date, commit, exit, reportPath, trades: trades.length });
    appendFileSync(LOG_PATH, (md.endsWith("\n") ? "" : "\n") + row + "\n");
    console.log(`Report: ${reportPath}\nAppended experiment row to ${LOG_PATH}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
