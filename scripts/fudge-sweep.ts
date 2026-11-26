// P3-0k2 descriptive: STP fudge sweep on the backfill (Chris, 2026-11-25). No verdicts, no
// experiment-log row. Variants: fudge at 11 / 17 / 19 / 23% of ATR14 ($0.02 floor) on entry and
// stop, and stop-only (entry at 11%). Populations: P3-0i all calendar trades (P3-0i sizing, exit
// B) and P3-0k p3k / p3k_all (P3-0k sizing, exit B + event and earnings rules). The trigger and
// candidate sets are fixed at the standard 11% levels; trailing stops keep 11%.
//
// Inputs as simulate-stp and simulate-aligned (read only). On the NAS:
//   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
//     -e NODE_OPTIONS=--max-old-space-size=6144 -e GIT_COMMIT=$(git rev-parse --short HEAD) \
//     harvester npx tsx scripts/fudge-sweep.ts [--years 2]

import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { parseChartBars, etParts, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { backfillSessions, barDateOf } from "@/lib/harvester/universe/backfill";
import { SECTOR_ETFS, industryEtfFor } from "@/lib/harvester/universe/sector-rotation";
import { loadUniverse, loadUniverseProfiles, type UniverseProfiles } from "@/lib/harvester/universe/store";
import { etfStates, MARKET_ETFS, pyramidLayers, type EtfState, type PyramidInputs } from "@/lib/harvester/universe/pyramid";
import { zigzag } from "@/lib/harvester/universe/swings";
import { earningsSessionsFromFile, egopSessionsFromFile } from "@/lib/harvester/edgar-earnings";
import { eventBeforeIndices, macroCalendar } from "@/lib/harvester/macro-calendar";
import { commitId } from "@/lib/eval/commit";
import { SURVIVORSHIP_NOTE } from "@/lib/eval/report";
import { BASE_RISK_DOLLARS, combinedSize, scanSymbol, stockFactor, type Setup } from "@/lib/eval/stp-sim";
import { LEVEL_SWING_K } from "@/lib/eval/funnel";
import { alignmentSeries, type Alignment } from "@/lib/eval/aligned";
import { extrasFor, type FunnelContext } from "@/lib/eval/funnel-sim";
import { p3kCandidates, p3kCandidateSize, p3kMember, type P3kCandidate } from "@/lib/eval/aligned-sim";
import { FUDGE_VARIANTS, heldOutFrom, sweepRow, sweepSymbol, sweepTable, type SweepOutcome } from "@/lib/eval/fudge-sweep";

const BARS_DIR = "scripts/output/backfill-bars";
const ETF_DIR = "scripts/output/backfill-etf-bars";
const EARNINGS_DIR = "scripts/output/backfill-earnings";
const DAY = 86_400_000;
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type Pop = "P3-0i all calendar trades" | "P3-0k p3k (aligned + optimal entry)" | "P3-0k p3k_all (all STP trades of the P3-0k types)";
const POPS: readonly Pop[] = ["P3-0i all calendar trades", "P3-0k p3k (aligned + optimal entry)", "P3-0k p3k_all (all STP trades of the P3-0k types)"];

async function main() {
  const years = Number(arg("--years") ?? 2);
  if (!existsSync(BARS_DIR)) throw new Error(`${BARS_DIR} not found: run scripts/backfill-snapshot.ts first`);
  const now = new Date();
  const load = (dir: string, f: string): DailyBar[] => parseChartBars(JSON.parse(readFileSync(join(dir, f), "utf8")), now);
  const spy = load(BARS_DIR, `${BENCHMARK_SYMBOL}.json`);
  const allSessions = [...new Set(spy.map(barDateOf).filter((d): d is string => d != null))].sort();
  const sessions = new Set(backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, etParts(now).date));
  const events = macroCalendar();

  const states = new Map<string, Map<string, EtfState>>([[BENCHMARK_SYMBOL, etfStates(spy)]]);
  const align = new Map<string, Map<string, Alignment>>([[BENCHMARK_SYMBOL, alignmentSeries(spy, barDateOf)]]);
  if (existsSync(ETF_DIR))
    for (const f of readdirSync(ETF_DIR).filter((x) => x.endsWith(".json"))) {
      const bars = load(ETF_DIR, f);
      const etf = f.replace(/\.json$/, "");
      states.set(etf, etfStates(bars));
      align.set(etf, alignmentSeries(bars, barDateOf));
    }
  let profiles: UniverseProfiles = {};
  try {
    const u = await loadUniverse();
    if (u) profiles = await loadUniverseProfiles(u.id);
  } catch (err) {
    console.warn(`[fudge-sweep] no sector/industry profiles (${err instanceof Error ? err.message : err})`);
  }

  const ctx: FunnelContext = { sessions: allSessions, events };
  const outcomes = new Map<string, SweepOutcome[]>(); // `${pop}|${variant}`
  const push = (pop: Pop, variant: string, xs: SweepOutcome[]) => (outcomes.get(`${pop}|${variant}`) ?? outcomes.set(`${pop}|${variant}`, []).get(`${pop}|${variant}`)!).push(...xs);
  const symbols = readdirSync(BARS_DIR).filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_SYMBOL}.json`).map((f) => f.replace(/\.json$/, "")).sort();
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
    const earnings = efJson ? earningsSessionsFromFile(efJson) : undefined;
    const prof = profiles[symbol];
    const sectorEtf = prof?.sector ? SECTOR_ETFS[prof.sector] ?? null : null;
    const industryEtf = industryEtfFor(prof?.industry);
    const pyramid: PyramidInputs = {
      market: MARKET_ETFS.map((e) => states.get(e) ?? null),
      sector: sectorEtf ? states.get(sectorEtf) ?? null : null,
      industry: industryEtf ? states.get(industryEtf) ?? null : null,
    };
    const scanned = scanSymbol(symbol, bars, sessions, undefined, efJson ? egopSessionsFromFile(efJson) : undefined);
    const dates = bars.map((b) => barDateOf(b) ?? "");
    const eventBefore = eventBeforeIndices(dates, events);
    const p3kExtras = (f: number) => extrasFor(f, dates, eventBefore, earnings).extra;
    const cands = p3kCandidates(
      { symbol, bars, scanned, pivots: zigzag(bars, LEVEL_SWING_K), pyramid, earnings },
      { industry: industryEtf ? align.get(industryEtf) ?? null : null, sector: sectorEtf ? align.get(sectorEtf) ?? null : null, market: MARKET_ETFS.map((e) => align.get(e) ?? null) },
      ctx,
    );
    const bySetup = new Map<Setup, P3kCandidate>(cands.map((c) => [c.setup, c]));
    const p3kRisk = (s: Setup) => BASE_RISK_DOLLARS * p3kCandidateSize(bySetup.get(s)!);
    const p3iRisk = (s: Setup) => BASE_RISK_DOLLARS * combinedSize(stockFactor(s.htf, s.maState, s.dir), pyramidLayers(pyramid, s.date, s.dir).sizeMult);
    for (const v of FUDGE_VARIANTS) {
      push(POPS[0], v.id, sweepSymbol(bars, scanned.setups, v, { baseRisk: p3iRisk }));
      push(POPS[1], v.id, sweepSymbol(bars, cands.filter((c) => p3kMember.p3k(c)).map((c) => c.setup), v, { baseRisk: p3kRisk, extras: p3kExtras }));
      push(POPS[2], v.id, sweepSymbol(bars, cands.map((c) => c.setup), v, { baseRisk: p3kRisk, extras: p3kExtras }));
    }
    if ((n + 1) % 200 === 0) console.log(`[fudge-sweep] ${n + 1}/${symbols.length} symbols, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const date = now.toISOString().slice(0, 10);
  const lines = [
    `# STP fudge sweep (descriptive, no verdicts): backfill, ${date} (${commitId()})`,
    "",
    SURVIVORSHIP_NOTE,
    "",
    "Entry = trigger high + fudge, stop = trigger low − fudge (short mirrored), fudge = max(pct × ATR14, $0.02). **both**: the swept fudge on entry and stop; **stop-only**: entry at 11%, stop at the swept fudge. " +
      "The trigger and candidate sets are fixed at the standard 11% levels; trailing stops keep their 11% per-bar fudge; sizing and management as in each population's simulation. " +
      "Fill rate = filled / setups attempted (one position per ticker); stopped within 3 sessions = an exit at the initial stop or a gap through it on the fill day or the next 2 sessions. Held out = the newest 30% of trigger dates, the same cut for every variant.",
    "",
  ];
  for (const pop of POPS) {
    const held = heldOutFrom((outcomes.get(`${pop}|${FUDGE_VARIANTS[0].id}`) ?? []).map((o) => o.scanId));
    lines.push(...sweepTable(pop, FUDGE_VARIANTS.map((v) => sweepRow(v.id, outcomes.get(`${pop}|${v.id}`) ?? [], held)), held));
  }
  mkdirSync("scripts/output", { recursive: true });
  const path = `scripts/output/fudge-sweep-${date}.md`;
  writeFileSync(path, lines.join("\n"));
  console.log(lines.filter((l) => l.startsWith("|") || l.startsWith("**")).join("\n"));
  console.log(`Report: ${path}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
