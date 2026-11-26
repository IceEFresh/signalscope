// P3-0j: the stock selection funnel on the backfill (docs/PHASE3-PREP.md §P3-0j), under the
// rules pre-registered in docs/PHASE3-PREREG.md "Selection funnel (P3-0j)". Inputs, all
// produced by earlier steps and read only:
//   - scripts/output/backfill-bars/        (P3-0g chart cache, SPY included)
//   - scripts/output/backfill-etf-bars/    (P3-0i layer ETFs; run simulate-stp once first)
//   - scripts/output/backfill-earnings/    (P3-0i3 EDGAR earnings sessions)
//   - src/lib/harvester/macro-calendar.json (checked in)
//   - the latest universe's sector/industry profiles (read-only DB query)
//
// On the NAS:
//   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
//     -v "$PWD/scripts/backtesting-experiments.md:/app/scripts/backtesting-experiments.md" \
//     -e NODE_OPTIONS=--max-old-space-size=6144 -e GIT_COMMIT=$(git rev-parse --short HEAD) \
//     harvester npx tsx scripts/simulate-funnel.ts
// Options: --years 2, --dry-run (summary only).

import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { parseChartBars, etParts, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { backfillSessions, barDateOf } from "@/lib/harvester/universe/backfill";
import { SECTOR_ETFS, industryEtfFor } from "@/lib/harvester/universe/sector-rotation";
import { loadUniverse, loadUniverseProfiles, type UniverseProfiles } from "@/lib/harvester/universe/store";
import { etfStates, MARKET_ETFS, type EtfState } from "@/lib/harvester/universe/pyramid";
import { zigzag } from "@/lib/harvester/universe/swings";
import { earningsFromFile, earningsSessionsFromFile, egopSessionsFromFile } from "@/lib/harvester/edgar-earnings";
import { calendarExpiry, macroCalendar } from "@/lib/harvester/macro-calendar";
import { commitId } from "@/lib/eval/commit";
import { lastExperimentNumber } from "@/lib/eval/report";
import { scanSymbol, spyRegimeByDate } from "@/lib/eval/stp-sim";
import { LEVEL_SWING_K, type EntryArm } from "@/lib/eval/funnel";
import {
  evaluateFunnel,
  rankCandidates,
  simulateFunnelSymbol,
  symbolCandidates,
  type Candidate,
  type FunnelContext,
  type FunnelCounts,
  type FunnelTrade,
  type Population,
  type SymbolInput,
} from "@/lib/eval/funnel-sim";
import { funnelExperimentRow, funnelMarkdownReport, funnelTradesCsv } from "@/lib/eval/funnel-report";

const BARS_DIR = "scripts/output/backfill-bars";
const ETF_DIR = "scripts/output/backfill-etf-bars";
const EARNINGS_DIR = "scripts/output/backfill-earnings";
const LOG_PATH = "scripts/backtesting-experiments.md";
const DAY = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Population × arm runs: both arms on every population, plus the descriptive low + fudge limit on top 5. */
const RUNS: ReadonlyArray<[Population, EntryArm]> = [
  ...(["all", "funnel", "top5", "top3"] as const).flatMap((p) => (["stop", "pullback"] as const).map((a): [Population, EntryArm] => [p, a])),
  ["top5", "pullback_low"],
  ["top5_noair", "stop"], // P3-0j3 descriptive: the ranking with open_air left out
];

async function main() {
  const years = Number(arg("--years") ?? 2);
  const dryRun = process.argv.includes("--dry-run");
  if (!existsSync(BARS_DIR)) throw new Error(`${BARS_DIR} not found: run scripts/backfill-snapshot.ts first`);
  const now = new Date();
  const load = (dir: string, f: string): DailyBar[] => parseChartBars(JSON.parse(readFileSync(join(dir, f), "utf8")), now);
  const spy = load(BARS_DIR, `${BENCHMARK_SYMBOL}.json`);
  const allSessions = [...new Set(spy.map(barDateOf).filter((d): d is string => d != null))].sort();
  const sessionList = backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, etParts(now).date);
  const sessions = new Set(sessionList);

  const events = macroCalendar();
  const expiry = calendarExpiry(events, etParts(now).date);
  if (!events.length) throw new Error(`${expiry.line}: the event size and stop rules need it`);
  console.log(expiry.line);

  const states = new Map<string, Map<string, EtfState>>([[BENCHMARK_SYMBOL, etfStates(spy)]]);
  if (existsSync(ETF_DIR)) for (const f of readdirSync(ETF_DIR).filter((x) => x.endsWith(".json"))) states.set(f.replace(/\.json$/, ""), etfStates(load(ETF_DIR, f)));
  let profiles: UniverseProfiles = {};
  try {
    const u = await loadUniverse();
    if (u) profiles = await loadUniverseProfiles(u.id);
  } catch (err) {
    console.warn(`[funnel] no sector/industry profiles (${err instanceof Error ? err.message : err}); sector layers count as mixed`);
  }

  const ctx: FunnelContext = { sessions: allSessions, events, regime: spyRegimeByDate(spy) };
  const symbols = readdirSync(BARS_DIR).filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_SYMBOL}.json`).map((f) => f.replace(/\.json$/, "")).sort();
  const inputs: SymbolInput[] = [];
  const cands: Candidate[] = [];
  let earningsSymbols = 0;
  const t0 = Date.now();
  for (const [n, symbol] of symbols.entries()) {
    let bars: DailyBar[];
    try {
      bars = load(BARS_DIR, `${symbol}.json`);
    } catch {
      continue;
    }
    if (bars.length < 60) continue;
    const ef = join(EARNINGS_DIR, `${symbol}.json`);
    const efJson = existsSync(ef) ? (JSON.parse(readFileSync(ef, "utf8")) as unknown) : null;
    // The earnings gate and exit rule use every release; EGOP only pre-open and after-close ones (Chris)
    const earnings = efJson ? earningsSessionsFromFile(efJson) : undefined;
    const egop = efJson ? egopSessionsFromFile(efJson) : undefined;
    if (earnings) earningsSymbols++;
    const prof = profiles[symbol];
    const sectorEtf = prof?.sector ? SECTOR_ETFS[prof.sector] ?? null : null;
    const industryEtf = industryEtfFor(prof?.industry);
    const input: SymbolInput = {
      symbol,
      bars,
      scanned: scanSymbol(symbol, bars, sessions, undefined, egop),
      pivots: zigzag(bars, LEVEL_SWING_K),
      pyramid: {
        market: MARKET_ETFS.map((e) => states.get(e) ?? null),
        sector: sectorEtf ? states.get(sectorEtf) ?? null : null,
        industry: industryEtf ? states.get(industryEtf) ?? null : null,
      },
      earnings,
      earningsFrom: efJson ? earningsFromFile(efJson) : undefined,
    };
    inputs.push(input);
    cands.push(...symbolCandidates(input, ctx));
    if ((n + 1) % 200 === 0) console.log(`[funnel] scanned ${n + 1}/${symbols.length}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  rankCandidates(cands);
  const bySymbol = new Map<string, Candidate[]>();
  for (const c of cands) (bySymbol.get(c.symbol) ?? bySymbol.set(c.symbol, []).get(c.symbol)!).push(c);

  const trades: FunnelTrade[] = [];
  const counts: Record<string, FunnelCounts> = {};
  for (const input of inputs) {
    const mine = (bySymbol.get(input.symbol) ?? []).sort((a, b) => a.setup.i - b.setup.i);
    for (const [p, a] of RUNS) {
      const r = simulateFunnelSymbol(input, mine, p, a, ctx);
      trades.push(...r.trades);
      const c = (counts[`${p} / ${a}`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
      for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
    }
  }
  const results = evaluateFunnel(trades);
  const passing = cands.filter((c) => c.gates.pass).length;
  console.log(`P3-0j funnel: ${cands.length} triggers, ${passing} pass the gates, ${trades.length} simulated trades; ` +
    results.map((r) => `${r.id} ${r.verdict}`).join(", "));
  if (dryRun) return;

  const date = now.toISOString().slice(0, 10);
  const commit = commitId();
  mkdirSync("scripts/output", { recursive: true });
  const reportPath = `scripts/output/funnel-backfill-${date}.md`;
  writeFileSync(
    reportPath,
    funnelMarkdownReport(results, trades, {
      date, commit, symbols: inputs.length, sessions: sessionList.length, candidates: cands.length, passing, counts, earningsSymbols, calendarEvents: events.length, calendarLine: expiry.line,
    }),
  );
  writeFileSync(`scripts/output/funnel-backfill-${date}-trades.csv`, funnelTradesCsv(trades));
  const md = readFileSync(LOG_PATH, "utf8");
  appendFileSync(LOG_PATH, (md.endsWith("\n") ? "" : "\n") + funnelExperimentRow(results, { number: lastExperimentNumber(md) + 1, date, commit, reportPath, trades: trades.length }) + "\n");
  console.log(`Report: ${reportPath}\nAppended experiment row to ${LOG_PATH}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
