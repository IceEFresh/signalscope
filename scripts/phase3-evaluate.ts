// Phase 3 evaluation (PLAN.md "Phase 3: Validate"): runs every pre-registered candidate
// in src/lib/eval/candidates.ts against the testing rules in src/lib/eval/rules.ts.
// Read-only on the database. Changes no rule, score or label.
//
// Run (needs DATABASE_URL; fetches SPY daily closes from Yahoo):
//   npx tsx scripts/phase3-evaluate.ts            # print results
//   npx tsx scripts/phase3-evaluate.ts --log      # also append one row per candidate to scripts/backtesting-experiments.md

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { fetchYahooChart } from "@/lib/harvester/yahoo-chart";
import { etParts, parseChartBars } from "@/lib/harvester/universe/bar-metrics";
import { buildEvalRows, type SpyClose, type StoredTickerRow } from "@/lib/eval/dataset";
import { evaluateCandidate } from "@/lib/eval/rules";
import { CANDIDATES } from "@/lib/eval/candidates";
import { consoleTable, experimentRows, lastExperimentNumber } from "@/lib/eval/report";

const LOG_PATH = "scripts/backtesting-experiments.md";

async function loadSpy(): Promise<SpyClose[]> {
  const res = await fetchYahooChart("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=2y");
  if (!res.ok) throw new Error(`SPY chart failed (status ${res.status})`);
  return parseChartBars(res.json)
    .filter((b) => b.time != null)
    .map((b) => ({ date: etParts(new Date(b.time! * 1000)).date, close: b.close }));
}

async function loadRows(): Promise<StoredTickerRow[]> {
  // Only scans that used the liquid universe (PR 1-0 onward).
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
  const log = process.argv.includes("--log");
  const [stored, spy] = await Promise.all([loadRows(), loadSpy()]);
  const rows = buildEvalRows(stored, spy);
  const scans = new Set(rows.map((r) => r.scanId)).size;
  console.log(`Phase 3: ${rows.length} eligible rows from ${scans} scans; SPY closes ${spy[0]?.date ?? "?"}..${spy.at(-1)?.date ?? "?"}\n`);
  const results = CANDIDATES.map((c) => evaluateCandidate(rows, c));
  console.log(consoleTable(results));
  if (log) {
    const md = readFileSync(LOG_PATH, "utf8");
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
    const lines = experimentRows(results, { date: new Date().toISOString().slice(0, 10), commit, startAfter: lastExperimentNumber(md) });
    appendFileSync(LOG_PATH, (md.endsWith("\n") ? "" : "\n") + lines.join("\n") + "\n");
    console.log(`\nAppended ${lines.length} rows to ${LOG_PATH}`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
