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
import { extrasFor } from "@/lib/eval/funnel-sim";
import { eventBeforeIndices } from "@/lib/harvester/macro-calendar";
import { MOVE_VARIANTS } from "@/lib/eval/moves";
import { moveInputs, newMoveStatsTable, P3K4_COMPARISONS, P3K4_GATE_STEPS, p3k3SimOptionsWithMoves, p3k4ExperimentRow, p3k4Lines, p3k4SimOptions, symbolMoves, withMoves } from "@/lib/eval/moves-sim";
import { atrSeries } from "@/lib/eval/stp-sim";
import { calendarInsideUturn, p3k3Trigger, P3K3_CAL_RUN, gateCountsByVariant, gateTable, p3k3ExperimentRow, P3K3_COMPARISONS, P3K3_GATE_STEPS, P3K3_RUNS, P3K_GATE_STEPS, p3k3Candidates, p3k3Lines, p3k3Member, p3k3SimOptions } from "@/lib/eval/aligned-v2-sim";
import { FUDGE_VARIANTS, heldOutFrom, sweepRow, sweepSymbol, sweepTable, type SweepOutcome } from "@/lib/eval/fudge-sweep";

const P3K_POPS = new Set(["p3k", "p3k_all", "p3k_noopt", "p3k_opens", "p3k_mas"]);
type GateRows = ReturnType<typeof gateCountsByVariant>;
const addGates = (acc: GateRows | null, g: GateRows): GateRows => (acc ? acc.map((r, k) => ({ ...r, calendar: r.calendar + g[k].calendar, rolling: r.rolling + g[k].rolling })) : g);



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
  // P3-0k3 accumulators (per symbol, so no candidate keeps its bars alive)
  const g3: { long: GateRows | null; short: GateRows | null } = { long: null, short: null };
  let roomNoProfile = 0;
  // P3-0k4 accumulators
  const g4: { long: GateRows | null; short: GateRows | null } = { long: null, short: null };
  const moveStats = newMoveStatsTable();
  const fudge23: Record<string, SweepOutcome[]> = { "both 11%": [], "both 23%": [] };
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
      // Same entry triggers as live watch_entry_ready: rolling inside / U-turn, calendar mech1 / mech2
      const wc = p3kCandidates(input, layers, ctx, undefined, p3k3Trigger);
      for (const p of ["watch_volume", "watch_volume_any"] as const) {
        const base = p3kSimOptions("p3k");
        const r = simulateFunnelSymbol(input, wc, p, "stop", ctx, { ...base, member: watchMember(p, spikes) });
        trades.push(...r.trades);
        const c = (counts[`${p} / stop`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
        for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
      }
    }
    all.push(...cands);
    // P3-0k3: aligned trend v2 on the same triggers
    // P3-0k3's own trigger set: rolling inside / U-turn, calendar mech1 / mech2
    const c3base = p3k3Candidates(input, layers, ctx);
    // P3-0k4: moves over the whole history (primary rules) and each descriptive variant
    const inp4 = moveInputs(bars, input.pivots, atrSeries(bars));
    const det = symbolMoves(inp4);
    for (const [name, opts] of Object.entries(MOVE_VARIANTS)) {
      const dv = name === "primary" ? det : symbolMoves(inp4, opts);
      moveStats[name].long.add(dv[1].moves);
      moveStats[name].short.add(dv[-1].moves);
    }
    const c3 = withMoves(c3base, inp4, det);
    // descriptive comparison: the dropped calendar inside / U-turn triggers under the same gates
    const cIU = p3k3Candidates(input, layers, ctx, undefined, calendarInsideUturn);
    {
      const r = simulateFunnelSymbol(input, cIU, P3K3_CAL_RUN, "stop", ctx, p3k3SimOptions(P3K3_CAL_RUN));
      trades.push(...r.trades);
      const c = (counts[`${P3K3_CAL_RUN} / stop`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
      for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
    }
    for (const [d, k] of [[1, "long"], [-1, "short"]] as const) g3[k] = addGates(g3[k], gateCountsByVariant(c3.filter((c) => c.dir === d), P3K3_GATE_STEPS));
    roomNoProfile += c3.filter((c) => c.v2.ma && c.v2.opens && c.v2.screens && c.v2.earnings && c.v2.rr && c.v2.optimal && !c.room.hasProfile).length;
    for (const [d, k] of [[1, "long"], [-1, "short"]] as const) g4[k] = addGates(g4[k], gateCountsByVariant(c3.filter((c) => c.dir === d), P3K4_GATE_STEPS));
    {
      const r = simulateFunnelSymbol(input, c3, "p3k4", "stop", ctx, p3k4SimOptions());
      trades.push(...r.trades);
      const c = (counts["p3k4 / stop"] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
      for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
    }
    for (const p of P3K3_RUNS) {
      const r = simulateFunnelSymbol(input, c3, p, "stop", ctx, p3k3SimOptionsWithMoves(p));
      trades.push(...r.trades);
      const c = (counts[`${p} / stop`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
      for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
    }
    const dates = bars.map((b) => barDateOf(b) ?? "");
    const evB = eventBeforeIndices(dates, ctx.events);
    const mem = c3.filter((c) => p3k3Member.p3k3(c));
    const bySetup = new Map(mem.map((c) => [c.setup, c]));
    for (const id of ["both 11%", "both 23%"] as const)
      fudge23[id].push(...sweepSymbol(bars, mem.map((c) => c.setup), FUDGE_VARIANTS.find((v) => v.id === id)!, { baseRisk: (s) => 200 * bySetup.get(s)!.sizeV2, extras: (f) => extrasFor(f, dates, evB, input.earnings).extra }));
    for (const [p, a] of P3K_RUNS) {
      const r = simulateFunnelSymbol(input, cands, p, a, ctx, p3kSimOptions(p));
      trades.push(...r.trades);
      const c = (counts[`${p} / ${a}`] ??= { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 });
      for (const k of Object.keys(c) as (keyof FunnelCounts)[]) c[k] += r.counts[k];
    }
    if ((n + 1) % 200 === 0) console.log(`[aligned] ${n + 1}/${symbols.length} symbols, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  // Verdicts on the P3-0k populations only, so the descriptive watch trades can't move the held-out cut
  const results = evaluateFunnel(trades.filter((t) => P3K_POPS.has(t.population)), P3K_COMPARISONS);
  // Verdicts on the P3-0k3 runs only (the calendar inside / U-turn comparison can't move the cut)
  const P3K3_POPS = new Set<string>(P3K3_RUNS);
  const results3 = evaluateFunnel(trades.filter((t) => P3K3_POPS.has(t.population)), P3K3_COMPARISONS);
  // P3-0k4 verdicts on the P3-0k3 runs plus p3k4 (the same held-out cut basis as P3-0k3)
  const P3K4_POPS = new Set<string>([...P3K3_RUNS, "p3k4"]);
  const results4 = evaluateFunnel(trades.filter((t) => P3K4_POPS.has(t.population)), P3K4_COMPARISONS);
  const g0 = { long: gateCountsByVariant(all.filter((c) => c.dir === 1), P3K_GATE_STEPS), short: gateCountsByVariant(all.filter((c) => c.dir === -1), P3K_GATE_STEPS) };
  const held23 = heldOutFrom(fudge23["both 11%"].map((o) => o.scanId));
  const fudgeLines = sweepTable("P3-0k3 fudge (descriptive): 11% vs 23% on entry and stop", (["both 11%", "both 23%"] as const).map((id) => sweepRow(id, fudge23[id], held23)), held23);
  const gates = { long: gateCounts(all.filter((c) => c.dir === 1)), short: gateCounts(all.filter((c) => c.dir === -1)) };
  console.log(
    `P3-0k aligned: triggers ${gates.long.triggers} long / ${gates.short.triggers} short; pass every gate ${gates.long.optimal} / ${gates.short.optimal}; ${trades.length} simulated trades; ` +
      results.map((r) => `${r.id} ${r.verdict}`).join(", "),
  );
  console.log(`P3-0k3 aligned v2 (provisional): ${results3.map((r) => `${r.id} ${r.verdict}`).join(", ")}`);
  console.log(`P3-0k4 moves (provisional): ${results4.map((r) => `${r.id} ${r.verdict}`).join(", ")}`);
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
    }) +
      "\n\n" + [...gateTable("P3-0k long (rolling-trigger check)", g0.long), ...gateTable("P3-0k short (rolling-trigger check)", g0.short)].join("\n") +
      "\n\n" + p3k3Lines(results3, trades, { long: g3.long ?? [], short: g3.short ?? [] }, { fudge23: fudgeLines, roomNoProfile }).join("\n") +
      "\n\n" + p3k4Lines(results4, trades, { long: g4.long ?? [], short: g4.short ?? [] }, moveStats).join("\n") +
      "\n\n" + watchVolumeLines(trades, spikeCount, groupMetrics).join("\n"),
  );
  writeFileSync(`scripts/output/aligned-backfill-${date}-trades.csv`, alignedTradesCsv(trades));
  const md = readFileSync(LOG_PATH, "utf8");
  const n0 = lastExperimentNumber(md) + 1;
  appendFileSync(
    LOG_PATH,
    (md.endsWith("\n") ? "" : "\n") +
      alignedExperimentRow(results, { number: n0, date, commit, reportPath, trades: trades.length }) + "\n" +
      p3k3ExperimentRow(results3, { number: n0 + 1, date, commit, reportPath, trades: trades.length }) + "\n" +
      p3k4ExperimentRow(results4, { number: n0 + 2, date, commit, reportPath, trades: trades.length }) + "\n",
  );
  console.log(`Report: ${reportPath}\nAppended experiment row to ${LOG_PATH}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
