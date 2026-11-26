// P3-0k: aligned-trend setups on the backfill (docs/PHASE3-PREP.md §P3-0k), under the rules
// pre-registered in docs/PHASE3-PREREG.md "Aligned-trend setups (P3-0k)". Inputs (read only):
//   - scripts/output/backfill-bars/        (P3-0g chart cache, SPY included)
//   - scripts/output/backfill-etf-bars/    (layer ETFs incl. QQQ and DIA; run simulate-stp once first)
//   - scripts/output/backfill-earnings/    (P3-0i3 EDGAR earnings sessions)
//   - src/lib/harvester/macro-calendar.json
//   - the latest universe's sector/industry profiles (read-only DB query)
//
// On the NAS:
//   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
//     -v "$PWD/scripts/backtesting-experiments.md:/app/scripts/backtesting-experiments.md" \
//     -e NODE_OPTIONS=--max-old-space-size=6144 -e GIT_COMMIT=$(git rev-parse --short HEAD) \
//     harvester npx tsx scripts/simulate-aligned.ts
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
import { MARKET_ETFS } from "@/lib/harvester/universe/pyramid";
import { zigzag } from "@/lib/harvester/universe/swings";
import { earningsSessionsFromFile, egopSessionsFromFile } from "@/lib/harvester/edgar-earnings";
import { calendarExpiry, macroCalendar } from "@/lib/harvester/macro-calendar";
import { commitId } from "@/lib/eval/commit";
import { lastExperimentNumber } from "@/lib/eval/report";
import { scanSymbol, spyRegimeByDate } from "@/lib/eval/stp-sim";
import { LEVEL_SWING_K } from "@/lib/eval/funnel";
import { alignmentSeries, type Alignment } from "@/lib/eval/aligned";
import { evaluateFunnel, simulateFunnelSymbol, type FunnelContext, type FunnelCounts, type FunnelTrade, type SymbolInput } from "@/lib/eval/funnel-sim";
import { gateCounts, P3K_COMPARISONS, P3K_RUNS, p3kCandidates, p3kMember, p3kSimOptions, type P3kCandidate } from "@/lib/eval/aligned-sim";
import { alignedExperimentRow, alignedMarkdownReport, alignedTradesCsv } from "@/lib/eval/aligned-report";
import { volumeSpikes, watchMember, watchVolumeLines } from "@/lib/eval/watch-backfill";
import { groupMetrics } from "@/lib/eval/stp-sim";

/** P3-0l: the watch backfill takes any STP type (EGOP included), calendar or rolling. */
const ALL_STP_TYPES = new Set(["inside", "butn", "brutn", "mech1", "mech2", "egop"]);

const BARS_DIR = "scripts/output/backfill-bars";
const ETF_DIR = "scripts/output/backfill-etf-bars";
const EARNINGS_DIR = "scripts/output/backfill-earnings";
const LOG_PATH = "scripts/backtesting-experiments.md";
const DAY = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

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

  // Layer alignment by date (long direction) for SPY and every cached ETF
  const align = new Map<string, Map<string, Alignment>>([[BENCHMARK_SYMBOL, alignmentSeries(spy, barDateOf)]]);
  if (existsSync(ETF_DIR)) for (const f of readdirSync(ETF_DIR).filter((x) => x.endsWith(".json"))) align.set(f.replace(/\.json$/, ""), alignmentSeries(load(ETF_DIR, f), barDateOf));
  const missingMarket = MARKET_ETFS.filter((e) => !align.has(e));
  if (missingMarket.length) console.warn(`[aligned] market ETFs missing (${missingMarket.join(", ")}): run simulate-stp once to cache them`);
  let profiles: UniverseProfiles = {};
  try {
    const u = await loadUniverse();
    if (u) profiles = await loadUniverseProfiles(u.id);
  } catch (err) {
    console.warn(`[aligned] no sector/industry profiles (${err instanceof Error ? err.message : err}); those layers count as not aligned (halving the size)`);
  }

  const ctx: FunnelContext = { sessions: allSessions, events, regime: spyRegimeByDate(spy) };
  const symbols = readdirSync(BARS_DIR).filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_SYMBOL}.json`).map((f) => f.replace(/\.json$/, "")).sort();
  const trades: FunnelTrade[] = [];
  const counts: Record<string, FunnelCounts> = {};
  const all: P3kCandidate[] = [];
  const t0 = Date.now();
  let used = 0;
  let spikeCount = 0;
  for (const [n, symbol] of symbols.entries()) {
    let bars: DailyBar[];
    try {
      bars = load(BARS_DIR, `${symbol}.json`);
    } catch {
      continue;
    }
    if (bars.length < 60) continue;
    used++;
    const ef = join(EARNINGS_DIR, `${symbol}.json`);
    const efJson = existsSync(ef) ? (JSON.parse(readFileSync(ef, "utf8")) as unknown) : null;
    const prof = profiles[symbol];
    const sectorEtf = prof?.sector ? SECTOR_ETFS[prof.sector] ?? null : null;
    const industryEtf = industryEtfFor(prof?.industry);
    const input: SymbolInput = {
      symbol,
      bars,
      scanned: scanSymbol(symbol, bars, sessions, undefined, efJson ? egopSessionsFromFile(efJson) : undefined),
      pivots: zigzag(bars, LEVEL_SWING_K),
      pyramid: { market: [null, null, null], sector: null, industry: null },
      earnings: efJson ? earningsSessionsFromFile(efJson) : undefined,
    };
    const layers = { industry: industryEtf ? align.get(industryEtf) ?? null : null, sector: sectorEtf ? align.get(sectorEtf) ?? null : null, market: MARKET_ETFS.map((e) => align.get(e) ?? null) };
    const cands = p3kCandidates(input, layers, ctx);
    // P3-0l descriptive: volume spike → STP trigger within 10 sessions
    const spikes = volumeSpikes(bars).filter((s) => sessions.has(barDateOf(bars[s.i]) ?? ""));
    spikeCount += spikes.length;
    if (spikes.length) {
      const wc = p3kCandidates(input, layers, ctx, ALL_STP_TYPES);
      for (const p of ["watch_volume", "watch_volume_any"] as const) {
        const base = p3kSimOptions("p3k");
        const r = simulateFunnelSymbol(input, wc, p, "stop", ctx, { ...base, member: watchMember(p, spikes) });
        trades.push(...r.trades);
        const c = (counts[`${p} / stop`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
        for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
      }
    }
    all.push(...cands);
    for (const [p, a] of P3K_RUNS) {
      const r = simulateFunnelSymbol(input, cands, p, a, ctx, p3kSimOptions(p));
      trades.push(...r.trades);
      const c = (counts[`${p} / ${a}`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
      for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
    }
    if ((n + 1) % 200 === 0) console.log(`[aligned] ${n + 1}/${symbols.length} symbols, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  // Verdicts on the P3-0k populations only, so the descriptive watch trades can't move the held-out cut
  const results = evaluateFunnel(trades.filter((t) => t.population.startsWith("p3k")), P3K_COMPARISONS);
  const gates = { long: gateCounts(all.filter((c) => c.dir === 1)), short: gateCounts(all.filter((c) => c.dir === -1)) };
  console.log(
    `P3-0k aligned: triggers ${gates.long.triggers} long / ${gates.short.triggers} short; pass every gate ${gates.long.optimal} / ${gates.short.optimal}; ${trades.length} simulated trades; ` +
      results.map((r) => `${r.id} ${r.verdict}`).join(", "),
  );
  if (dryRun) return;

  const date = now.toISOString().slice(0, 10);
  const commit = commitId();
  mkdirSync("scripts/output", { recursive: true });
  const reportPath = `scripts/output/aligned-backfill-${date}.md`;
  writeFileSync(
    reportPath,
    alignedMarkdownReport(results, trades, {
      date, commit, symbols: used, sessions: sessionList.length, gates, counts, passing: all.filter((c) => p3kMember.p3k(c)),
      alignFrom: sessionList.find((d) => align.get(BENCHMARK_SYMBOL)?.get(d)?.complete) ?? null,
    }) + "\n\n" + watchVolumeLines(trades, spikeCount, groupMetrics).join("\n"),
  );
  writeFileSync(`scripts/output/aligned-backfill-${date}-trades.csv`, alignedTradesCsv(trades));
  const md = readFileSync(LOG_PATH, "utf8");
  appendFileSync(LOG_PATH, (md.endsWith("\n") ? "" : "\n") + alignedExperimentRow(results, { number: lastExperimentNumber(md) + 1, date, commit, reportPath, trades: trades.length }) + "\n");
  console.log(`Report: ${reportPath}\nAppended experiment row to ${LOG_PATH}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
