// Phase 3 feature validation (docs/PHASE3-PREP.md P3-0b), under the rules fixed in
// docs/PHASE3-PREREG.md. Read-only on the database; changes no rule, score or label.
// Refuses to run if any outcome is not strictly after its scan (look-ahead).
//
// Run (needs DATABASE_URL; fetches SPY daily closes from Yahoo):
//   npx tsx scripts/validate-features.ts             # report + one experiment-log row
//   npx tsx scripts/validate-features.ts --dry-run   # print the summary only, write nothing

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { fetchYahooChart } from "@/lib/harvester/yahoo-chart";
import { etParts, parseChartBars } from "@/lib/harvester/universe/bar-metrics";
import { buildEvalRows, type SpyClose, type StoredTickerRow } from "@/lib/eval/dataset";
import { candidateKeys, evaluateFeature } from "@/lib/eval/features";
import { experimentSummaryRow, lastExperimentNumber, markdownReport } from "@/lib/eval/report";

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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const [stored, spy] = await Promise.all([loadRows(), loadSpy()]);
  const rows = buildEvalRows(stored, spy); // throws on look-ahead
  const scans = new Set(rows.map((r) => r.scanId)).size;
  const results = candidateKeys(rows).map((k) => evaluateFeature(rows, k));
  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  console.log(`Phase 3: ${rows.length} rows, ${scans} scans, ${results.length} features: ${count("KEEP")} KEEP, ${count("DROP")} DROP, ${count("INSUFFICIENT")} INSUFFICIENT`);
  for (const r of results.filter((x) => x.verdict === "KEEP")) console.log(`  KEEP ${r.key}: ${r.reason}`);
  if (!dryRun) {
    const reportPath = `scripts/output/phase3-validation-${date}.md`;
    mkdirSync("scripts/output", { recursive: true });
    writeFileSync(reportPath, markdownReport(results, { date, commit, rows: rows.length, scans }));
    const md = readFileSync(LOG_PATH, "utf8");
    const row = experimentSummaryRow(results, { number: lastExperimentNumber(md) + 1, date, commit, rows: rows.length, scans, reportPath });
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
