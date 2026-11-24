// Phase 3 feature validation (docs/PHASE3-PREP.md P3-0b), under the rules fixed in
// docs/PHASE3-PREREG.md. Read-only on the database; changes no rule, score or label.
// Refuses to run if any outcome is not strictly after its scan (look-ahead).
//
// Run (needs DATABASE_URL; fetches SPY daily closes from Yahoo):
//   npx tsx scripts/validate-features.ts                       # signal tickers: report + one experiment-log row
//   npx tsx scripts/validate-features.ts --dataset universe    # P3-0c universe snapshots (reported separately)
//   npx tsx scripts/validate-features.ts --dataset backfill    # P3-0g backfilled snapshots (separate; SPY from its own rows)
//   npx tsx scripts/validate-features.ts --dry-run             # print the summary only, write nothing

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { fetchYahooChart } from "@/lib/harvester/yahoo-chart";
import { etParts, parseChartBars } from "@/lib/harvester/universe/bar-metrics";
import { buildEvalRows, type SpyClose, type StoredTickerRow } from "@/lib/eval/dataset";
import { candidateKeys, evaluateFeature } from "@/lib/eval/features";
import { experimentSummaryRow, lastExperimentNumber, markdownReport, type DatasetName } from "@/lib/eval/report";
import { buildUniverseRows, type StoredSnapshotRow } from "@/lib/eval/universe-dataset";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { BACKFILL_SCAN_PREFIX } from "@/lib/harvester/universe/backfill";
import type { EvalRow } from "@/lib/eval/rules";

const LOG_PATH = "scripts/backtesting-experiments.md";

async function loadSpy(): Promise<SpyClose[]> {
  const res = await fetchYahooChart("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=2y");
  if (!res.ok) throw new Error(`SPY chart failed (status ${res.status})`);
  return parseChartBars(res.json)
    .filter((b) => b.time != null)
    .map((b) => ({ date: etParts(new Date(b.time! * 1000)).date, close: b.close }));
}

async function loadRows(): Promise<StoredTickerRow[]> {
  // Liquid-universe rows only (PR 1-0 onward).
  const tickers = await prisma.validatedTicker.findMany({
    where: { inUniverse: true, scan: { universeId: { not: null } } },
    select: {
      scanId: true, symbol: true, inUniverse: true, stage: true, recommendation: true, aiScore: true,
      opportunityScore: true, sourceCount: true, signalType: true, features: true,
      scan: { select: { startedAt: true, regimeFeatures: true } },
      performance: {
        select: {
          corporateActionDetected: true, return1d: true, return3d: true, return7d: true,
          snapped1dAt: true, snapped3dAt: true, snapped7dAt: true,
        },
      },
    },
  });
  return tickers.map((t) => ({
    scanId: t.scanId,
    scanStartedAt: t.scan.startedAt,
    symbol: t.symbol,
    inUniverse: t.inUniverse,
    stage: t.stage,
    recommendation: t.recommendation,
    aiScore: t.aiScore,
    opportunityScore: t.opportunityScore,
    sourceCount: t.sourceCount,
    signalType: t.signalType,
    features: (t.features as Record<string, unknown> | null) ?? null,
    regimeFeatures: (t.scan.regimeFeatures as Record<string, unknown> | null) ?? null,
    performance: t.performance,
  }));
}

async function loadSnapshots(backfill: boolean): Promise<StoredSnapshotRow[]> {
  // Backfill rows sit under synthetic scans marked in Scan.error; the builder also filters on features.backfill.
  const snaps = await prisma.universeSnapshot.findMany({
    where: backfill
      ? { scan: { error: { startsWith: BACKFILL_SCAN_PREFIX } } }
      : { scan: { OR: [{ error: null }, { NOT: { error: { startsWith: BACKFILL_SCAN_PREFIX } } }] } },
    select: { scanId: true, symbol: true, sessionDate: true, close: true, features: true, scan: { select: { startedAt: true, regimeFeatures: true } } },
  });
  return snaps.map((s) => ({
    scanId: s.scanId,
    scanStartedAt: s.scan.startedAt,
    symbol: s.symbol,
    sessionDate: s.sessionDate,
    close: s.close,
    features: (s.features as Record<string, unknown> | null) ?? null,
    regimeFeatures: (s.scan.regimeFeatures as Record<string, unknown> | null) ?? null,
  }));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const di = process.argv.indexOf("--dataset");
  const arg = di >= 0 ? process.argv[di + 1] : undefined;
  const dataset: DatasetName = arg === "universe" || arg === "backfill" ? arg : "signals";
  // All builders throw on look-ahead
  let rows: EvalRow[];
  if (dataset === "signals") rows = buildEvalRows(await loadRows(), await loadSpy());
  else {
    const snaps = await loadSnapshots(dataset === "backfill");
    // The backfill covers ~2 years, longer than loadSpy's range: use the backfill's own SPY rows.
    const spy = dataset === "backfill"
      ? snaps.filter((s) => s.symbol === BENCHMARK_SYMBOL).map((s) => ({ date: s.sessionDate, close: s.close }))
      : await loadSpy();
    rows = buildUniverseRows(snaps, spy, { backfill: dataset === "backfill" });
  }
  const scans = new Set(rows.map((r) => r.scanId)).size;
  const results = candidateKeys(rows).map((k) => evaluateFeature(rows, k));
  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  console.log(`Phase 3 (${dataset} dataset): ${rows.length} rows, ${scans} scans, ${results.length} features: ${count("KEEP")} KEEP, ${count("DROP")} DROP, ${count("INSUFFICIENT")} INSUFFICIENT`);
  for (const r of results.filter((x) => x.verdict === "KEEP")) console.log(`  KEEP ${r.key}: ${r.reason}`);
  if (!dryRun) {
    const reportPath = `scripts/output/phase3-validation-${dataset}-${date}.md`;
    mkdirSync("scripts/output", { recursive: true });
    writeFileSync(reportPath, markdownReport(results, { date, commit, rows: rows.length, scans, dataset }));
    const md = readFileSync(LOG_PATH, "utf8");
    const row = experimentSummaryRow(results, { number: lastExperimentNumber(md) + 1, date, commit, rows: rows.length, scans, reportPath, dataset });
    appendFileSync(LOG_PATH, (md.endsWith("\n") ? "" : "\n") + row + "\n");
    console.log(`Report: ${reportPath}\nAppended experiment row to ${LOG_PATH}`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
