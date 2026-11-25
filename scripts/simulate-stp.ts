// P3-0i: STP trigger trade simulation on the backfill bars (docs/PHASE3-PREP.md), under
// the rules fixed in docs/PHASE3-PREREG.md "STP trigger trades (P3-0i)". Reads the P3-0g chart
// cache in scripts/output/backfill-bars/ (the DB backfill rows hold only closes, so they can't
// stand in for it). §1g also needs:
//   - ETF bars for the Power Pyramid layers (QQQ, DIA, the 11 sector SPDRs and the mapped
//     industry ETFs), fetched once into scripts/output/backfill-etf-bars/ and reused;
//   - each stock's sector and industry from the latest stored universe (read-only DB query;
//     today's mapping, a survivorship caveat). Without the DB, every sector/industry layer
//     is null and counts as mixed.
//
// On the NAS (same pattern as validate-features):
//   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
//     -v "$PWD/scripts/backtesting-experiments.md:/app/scripts/backtesting-experiments.md" \
//     -e NODE_OPTIONS=--max-old-space-size=6144 -e GIT_COMMIT=$(git rev-parse --short HEAD) \
//     harvester npx tsx scripts/simulate-stp.ts --dataset backfill
// Options: --exit A|B (default both), --years 2, --dry-run (summary only). Exit B (STP management,
// §1e) is primary and gets the verdicts; exit A (fixed 3R) is a reference with no verdicts.

import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { fetchYahooChart } from "@/lib/harvester/yahoo-chart";
import { parseChartBars, etParts, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { backfillSessions, WARMUP_DAYS } from "@/lib/harvester/universe/backfill";
import { SECTOR_ETFS, industryEtfFor, INDUSTRY_ETFS } from "@/lib/harvester/universe/sector-rotation";
import { loadUniverse, loadUniverseProfiles, type UniverseProfiles } from "@/lib/harvester/universe/store";
import { etfStates, MARKET_ETFS, type EtfState, type PyramidInputs } from "@/lib/harvester/universe/pyramid";
import { SWING_KS, swingProfile, zigzag } from "@/lib/harvester/universe/swings";
import { commitId } from "@/lib/eval/commit";
import { lastExperimentNumber } from "@/lib/eval/report";
import {
  emptyCounts,
  evaluateGroups,
  portfolioStats,
  PRIMARY_EXIT,
  scanSymbol,
  setupOverlap,
  simulateSymbol,
  spyRegimeByDate,
  type ExitRule,
  type Overlap,
  type SymbolCounts,
  type Trade,
  type Variant,
} from "@/lib/eval/stp-sim";
import { simExperimentRow, simMarkdownReport, tradesCsv, type ProfileSummary } from "@/lib/eval/stp-sim-report";

const CACHE_DIR = "scripts/output/backfill-bars";
const ETF_DIR = "scripts/output/backfill-etf-bars";
const LOG_PATH = "scripts/backtesting-experiments.md";
const DAY = 86_400_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const dataset = arg("--dataset") ?? "backfill";
  if (dataset !== "backfill") throw new Error(`only --dataset backfill is supported (got ${dataset})`);
  const requested = arg("--exit")?.toUpperCase();
  if (requested && requested !== "A" && requested !== "B") throw new Error(`--exit must be A or B (got ${requested})`);
  const exits: ExitRule[] = requested ? [requested as ExitRule] : ["B", "A"];
  const years = Number(arg("--years") ?? 2);
  const dryRun = process.argv.includes("--dry-run");
  if (!existsSync(CACHE_DIR)) throw new Error(`${CACHE_DIR} not found: run scripts/backfill-snapshot.ts first (its chart cache is the input)`);

  const now = new Date();
  const loadFrom = (dir: string, file: string): DailyBar[] => parseChartBars(JSON.parse(readFileSync(join(dir, file), "utf8")), now);
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  const spyFile = `${BENCHMARK_SYMBOL}.json`;
  if (!files.includes(spyFile)) throw new Error(`${spyFile} missing from ${CACHE_DIR}`);
  const spy = loadFrom(CACHE_DIR, spyFile);
  const sessionList = backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, etParts(now).date);
  const sessions = new Set(sessionList);
  const regime = spyRegimeByDate(spy);
  const symbols = files.filter((f) => f !== spyFile).map((f) => f.replace(/\.json$/, "")).sort();

  // §1g: ETF bars for the layers, cached once (same window as the P3-0g backfill)
  mkdirSync(ETF_DIR, { recursive: true });
  const etfList = [...new Set(["QQQ", "DIA", ...Object.values(SECTOR_ETFS), ...Object.values(INDUSTRY_ETFS)])].sort();
  const period2 = Math.floor(now.getTime() / 1000);
  const period1 = Math.floor((now.getTime() - (years * 365 + WARMUP_DAYS) * DAY) / 1000);
  const states = new Map<string, Map<string, EtfState>>([[BENCHMARK_SYMBOL, etfStates(spy)]]);
  let fetched = 0;
  for (const etf of etfList) {
    const file = `${etf}.json`;
    if (!existsSync(join(ETF_DIR, file))) {
      const res = await fetchYahooChart(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(etf)}?interval=1d&period1=${period1}&period2=${period2}`);
      if (!res.ok) {
        console.warn(`[stp-sim] ETF ${etf}: chart failed (status ${res.status ?? "network"}); its layer is null (mixed)`);
        continue;
      }
      writeFileSync(join(ETF_DIR, file), JSON.stringify(res.json));
      fetched++;
      await new Promise((r) => setTimeout(r, 300));
    }
    states.set(etf, etfStates(loadFrom(ETF_DIR, file)));
  }
  console.log(`[stp-sim] layer ETFs: ${states.size}/${etfList.length + 1} available (${fetched} fetched now)`);

  // §1g: today's sector/industry per stock (read-only)
  let profiles: UniverseProfiles = {};
  try {
    const u = await loadUniverse();
    if (u) profiles = await loadUniverseProfiles(u.id);
  } catch (err) {
    console.warn(`[stp-sim] no sector/industry profiles (${err instanceof Error ? err.message : err}); sector and industry layers count as mixed`);
  }
  console.log(`[stp-sim] ${symbols.length} symbols (${Object.keys(profiles).length} with a sector/industry profile), ${sessionList.length} sessions ${sessionList[0]}..${sessionList.at(-1)}, exits ${exits.join(", ")}`);

  const t0 = Date.now();
  const fresh = () => ({
    trades: [] as Trade[],
    counts: { calendar: emptyCounts(), rolling: emptyCounts() } as Record<Variant, SymbolCounts>,
    sizeSkipByType: {} as Record<string, number>,
  });
  const byExit: Record<ExitRule, ReturnType<typeof fresh>> = { A: fresh(), B: fresh() };
  const overlap: Overlap = { both: 0, calendarOnly: 0, rollingOnly: 0 };
  const profileAcc: Record<string, { rally: number[]; pullback: number[]; rallyBars: number[]; pullbackBars: number[] }> = Object.fromEntries(
    SWING_KS.map((k) => [String(k), { rally: [], pullback: [], rallyBars: [], pullbackBars: [] }]),
  );
  for (const [n, sym] of symbols.entries()) {
    let bars: DailyBar[];
    try {
      bars = loadFrom(CACHE_DIR, `${sym}.json`);
    } catch {
      console.warn(`[stp-sim] ${sym}: unreadable cache file, skipped`);
      continue;
    }
    if (bars.length < 60) continue;
    const scanned = scanSymbol(sym, bars, sessions); // once per symbol (stocks: rolling 5/20), shared by both exits
    const pivots = Object.fromEntries(SWING_KS.map((k) => [String(k), zigzag(bars, k)]));
    for (const k of SWING_KS) {
      const p = swingProfile(bars, bars.length - 1, k, pivots[String(k)]);
      const acc = profileAcc[String(k)];
      if (p.rally) {
        acc.rally.push(p.rally.medianAtr);
        acc.rallyBars.push(p.rally.medianBars);
      }
      if (p.pullback) {
        acc.pullback.push(p.pullback.medianAtr);
        acc.pullbackBars.push(p.pullback.medianBars);
      }
    }
    const prof = profiles[sym];
    const sectorEtf = prof?.sector ? SECTOR_ETFS[prof.sector] ?? null : null;
    const industryEtf = industryEtfFor(prof?.industry);
    const pyramid: PyramidInputs = {
      market: MARKET_ETFS.map((e) => states.get(e) ?? null),
      sector: sectorEtf ? states.get(sectorEtf) ?? null : null,
      industry: industryEtf ? states.get(industryEtf) ?? null : null,
    };
    const o = setupOverlap(scanned.setups, scanned.rollingSetups);
    overlap.both += o.both;
    overlap.calendarOnly += o.calendarOnly;
    overlap.rollingOnly += o.rollingOnly;
    for (const exit of exits)
      for (const variant of ["calendar", "rolling"] as const) {
        const r = simulateSymbol(sym, bars, exit, { regime, scanned, variant, pyramid, pivots });
        byExit[exit].trades.push(...r.trades);
        for (const key of Object.keys(r.counts) as (keyof SymbolCounts)[]) byExit[exit].counts[variant][key] += r.counts[key];
        if (variant === "calendar")
          for (const [type, c] of Object.entries(r.sizeSkipByType)) byExit[exit].sizeSkipByType[type] = (byExit[exit].sizeSkipByType[type] ?? 0) + c;
      }
    if ((n + 1) % 100 === 0) console.log(`[stp-sim] ${n + 1}/${symbols.length} symbols, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const profilesSummary: ProfileSummary[] = SWING_KS.map((k) => {
    const a = profileAcc[String(k)];
    return { k, stocks: a.rally.length, rallyAtr: median(a.rally), pullbackAtr: median(a.pullback), rallyBars: median(a.rallyBars), pullbackBars: median(a.pullbackBars) };
  });

  const date = now.toISOString().slice(0, 10);
  const commit = commitId();
  for (const exit of exits) {
    const { trades, counts, sizeSkipByType } = byExit[exit];
    // §1g needs each stock's sector: without profiles (no DB), its groups are NOT_RUN rather than judged on market-only data.
    const withSector = trades.filter((t) => t.variant === "calendar" && !!profiles[t.symbol]?.sector).length;
    const notRun = Object.keys(profiles).length === 0 ? [{ prefix: "pyramid:", reason: "no sector/industry profiles this run (DB unavailable)" }] : [];
    const results = evaluateGroups(trades, { verdicts: exit === PRIMARY_EXIT, notRun });
    const prim = results.filter((r) => r.primary);
    const v = (x: string) => prim.filter((r) => r.verdict === x).length;
    const verdictText = exit === PRIMARY_EXIT ? `primary groups ${v("KEEP")} KEEP, ${v("DROP")} DROP, ${v("INSUFFICIENT")} INSUFFICIENT, ${v("NOT_RUN")} NOT_RUN` : "reference exit, no verdicts";
    console.log(`P3-0i exit ${exit}: ${trades.length} trades (${counts.calendar.filled} calendar, ${counts.rolling.filled} rolling); ${verdictText}`);
    for (const r of prim.filter((x) => x.verdict === "KEEP")) console.log(`  KEEP ${r.group}: ${r.reason}`);
    if (dryRun) continue;
    mkdirSync("scripts/output", { recursive: true });
    const reportPath = `scripts/output/stp-sim-backfill-exit${exit}-${date}.md`;
    const portfolio = {
      calendar: portfolioStats(trades.filter((t) => t.variant === "calendar"), sessionList.length),
      rolling: portfolioStats(trades.filter((t) => t.variant === "rolling"), sessionList.length),
    };
    writeFileSync(
      reportPath,
      simMarkdownReport(results, counts.calendar, {
        date, commit, exit, symbols: symbols.length, rollingCounts: counts.rolling, overlap, portfolio, sizeSkipByType, profiles: profilesSummary,
        sectorProfiles: { tradesWith: withSector, trades: counts.calendar.filled },
        finvizPrice: {
          base: median(trades.filter((t) => t.variant === "calendar" && t.finvizBase === true).map((t) => t.fill)),
          all: median(trades.filter((t) => t.variant === "calendar").map((t) => t.fill)),
        },
      }),
    );
    writeFileSync(`scripts/output/stp-sim-backfill-exit${exit}-${date}-trades.csv`, tradesCsv(trades));
    const md = readFileSync(LOG_PATH, "utf8");
    const row = simExperimentRow(results, { number: lastExperimentNumber(md) + 1, date, commit, exit, reportPath, trades: trades.length });
    appendFileSync(LOG_PATH, (md.endsWith("\n") ? "" : "\n") + row + "\n");
    console.log(`Report: ${reportPath}\nAppended experiment row to ${LOG_PATH}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
