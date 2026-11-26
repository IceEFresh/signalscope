/**
 * P3-0k3 simulation: aligned trend v2 candidates, populations, the 4 pre-registered (provisional)
 * comparisons, gate counts by trigger variant, and the descriptive report section. Pure; reuses
 * the P3-0k candidates (triggers, R/R, optimal entry, earnings, layers) and the P3-0j simulator.
 */
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { screensOn } from "@/lib/harvester/universe/finviz-screens";
import { swingProfile } from "@/lib/harvester/universe/swings";
import { BASE_RISK_DOLLARS, atrSeries, groupMetrics, initialShares, stoppedEarly, type Dir, type GroupMetrics } from "./stp-sim";
import { forDir, type AlignState } from "./aligned";
import { p3kCandidates, type LayerSeries, type P3kCandidate } from "./aligned-sim";
import { buildAddQty, maOrderAt, monthlyAndRolling20Green, opensV2, p3k3Size, passingNamedScreens, roomEarly, screensFor, slopeOk, type MaOrder, type RoomEarly } from "./aligned-v2";
import { LEVEL_SWING_K } from "./funnel";
import type { Candidate, Comparison, ComparisonResult, FunnelContext, FunnelTrade, Population, SymbolInput } from "./funnel-sim";

export type P3k3Population = Extract<Population, `p3k3${string}`>;

export interface P3k3Gates {
  ma: boolean;
  opens: boolean;
  screens: boolean;
  base: boolean;
  earnings: boolean;
  rr: boolean;
  optimal: boolean;
  room: boolean;
  room75: boolean;
  slope: boolean;
}

export interface P3k3Candidate extends P3kCandidate {
  v2: P3k3Gates;
  maOrder: MaOrder | null;
  screenIds: string[];
  monthlyR20Green: boolean;
  /** Industry for sizing: null = no ETF or no complete data (neutral). */
  industryV2: AlignState | null;
  room: RoomEarly;
  layerSizeV2: number;
  sizeV2: number;
  /** Per-day sizing inputs (for "build to layer size"). */
  sizeOn: (j: number) => number;
}

/** P3-0k3 candidates from the P3-0k ones (same triggers, R/R, optimal entry, earnings, layers). */
export function p3k3Candidates(input: SymbolInput, layers: LayerSeries, ctx: FunnelContext, base?: readonly P3kCandidate[]): P3k3Candidate[] {
  const { bars, pivots } = input;
  const closes = bars.map((b) => b.close);
  const atr = atrSeries(bars);
  const dates = bars.map((b) => barDateOf(b) ?? "");
  const profileCache = new Map<number, ReturnType<typeof swingProfile>>();
  const profile = (t: number) => profileCache.get(t) ?? profileCache.set(t, swingProfile(bars, t, LEVEL_SWING_K, pivots)).get(t)!;
  const industryAt = (d: string, dir: Dir): AlignState | null => {
    const a = layers.industry?.get(d);
    return a && a.complete ? forDir(a.state, dir) : null;
  };
  const sectorAt = (d: string, dir: Dir) => forDir(layers.sector?.get(d)?.state, dir);
  const marketAt = (d: string, dir: Dir): AlignState | null => {
    const s = layers.market.map((m) => forDir(m?.get(d)?.state, dir));
    if (s.every((x) => x == null)) return null;
    return s.filter((x) => x === "aligned").length >= 2 ? "aligned" : s.filter((x) => x === "against").length >= 2 ? "against" : "mixed";
  };
  return (base ?? p3kCandidates(input, layers, ctx)).map((c) => {
    const i = c.setup.i;
    const dir = c.dir;
    const ma = maOrderAt(closes, i, dir);
    const sc = screensOn(bars, i, atr);
    const screenIds = passingNamedScreens(sc, dir);
    const monthlyR20Green = monthlyAndRolling20Green(bars, i, dir);
    const industryV2 = industryAt(c.date, dir);
    const room = roomEarly(bars, i, dir, c.setup.entry, c.setup.stop, atr[i], pivots, profile);
    const room75 = roomEarly(bars, i, dir, c.setup.entry, c.setup.stop, atr[i], pivots, profile, "p75");
    const inputs = { monthlyR20Green, sector: c.sector, market: c.market, industry: industryV2 };
    const v2: P3k3Gates = {
      ma: ma.pass,
      opens: opensV2(bars, i, dir),
      screens: screenIds.length > 0,
      base: sc.base === true,
      earnings: c.p3k.earnings,
      rr: c.p3k.rr,
      optimal: c.p3k.optimal,
      room: room.pass,
      room75: room75.pass,
      slope: slopeOk(closes, i, dir),
    };
    const sizeOn = (j: number) =>
      p3k3Size({ monthlyR20Green: monthlyAndRolling20Green(bars, j, dir), sector: sectorAt(dates[j], dir), market: marketAt(dates[j], dir), industry: industryAt(dates[j], dir) }, false);
    return { ...c, v2, maOrder: ma.order, screenIds, monthlyR20Green, industryV2, room, layerSizeV2: p3k3Size(inputs, false), sizeV2: p3k3Size(inputs, c.eventHalf), sizeOn };
  });
}

const core = (c: P3k3Candidate) => c.v2.ma && c.v2.opens && c.v2.earnings && c.v2.rr && c.v2.optimal;
export const p3k3Member: Record<P3k3Population, (c: P3k3Candidate) => boolean> = {
  p3k3: (c) => core(c) && c.v2.screens && c.v2.room,
  p3k3_all: () => true,
  p3k3_base: (c) => core(c) && c.v2.base && c.v2.room,
  p3k3_slope: (c) => core(c) && c.v2.screens && c.v2.room && c.v2.slope,
  p3k3_noroom: (c) => core(c) && c.v2.screens,
  p3k3_room75: (c) => core(c) && c.v2.screens && c.v2.room75,
  p3k3_build: (c) => core(c) && c.v2.screens && c.v2.room,
};

export const P3K3_RUNS: ReadonlyArray<P3k3Population> = ["p3k3_all", "p3k3", "p3k3_base", "p3k3_slope", "p3k3_noroom", "p3k3_room75", "p3k3_build"];

/** simulateFunnelSymbol options: membership, the v2 size, tags and (p3k3_build) the build-to-layer-size adds. */
export function p3k3SimOptions(population: P3k3Population) {
  return {
    member: (c: Candidate) => p3k3Member[population](c as P3k3Candidate),
    size: (c: Candidate) => (c as P3k3Candidate).sizeV2,
    tag: (c: Candidate): Partial<FunnelTrade> => {
      const p = c as P3k3Candidate;
      return {
        p3k3Screens: p.screenIds.join(" "), maOrder: p.maOrder, monthlyR20Green: p.monthlyR20Green, roomPass: p.room.pass, roomLeft: p.room.roomLeft,
        rallyUsedV2: p.room.rallyUsed, p3k3LayerSize: p.layerSizeV2, industryV2: p.industryV2, alignSector: p.sector, alignMarket: p.market, setupVariant: p.variantSource,
      };
    },
    ...(population === "p3k3_build"
      ? {
          addQty: (c: Candidate, _shares: number, risk: number) => {
            const p = c as P3k3Candidate;
            const full = initialShares(BASE_RISK_DOLLARS, risk);
            return (j: number, current: number) => buildAddQty(current, initialShares(BASE_RISK_DOLLARS * p.sizeOn(j), risk), full);
          },
        }
      : {}),
  };
}

const side = (d: Dir) => (d === 1 ? "long" : "short");
/** The 4 pre-registered P3-0k3 comparisons (stop entry); any KEEP is provisional (defined after a P3-0k run). */
export const P3K3_COMPARISONS: readonly Comparison[] = ([1, -1] as const).flatMap((d): Comparison[] => [
  {
    id: `p3k3:vs-all:${side(d)}`,
    label: `aligned v2 vs all STP trades, ${side(d)}`,
    kind: "bench",
    sel: (t) => t.arm === "stop" && t.population === "p3k3" && t.dir === d,
    bench: (t) => t.arm === "stop" && t.population === "p3k3_all" && t.dir === d,
    provisional: true,
  },
  {
    id: `p3k3:vs-control:${side(d)}`,
    label: `aligned v2 vs its after-trigger matched control, ${side(d)}`,
    kind: "control",
    sel: (t) => t.arm === "stop" && t.population === "p3k3" && t.dir === d,
    provisional: true,
  },
]);

/** Candidates left after each gate, by trigger variant (the rolling-trigger check). */
export function gateCountsByVariant<C extends { variantSource: "calendar" | "rolling" }>(cands: readonly C[], steps: ReadonlyArray<[string, (c: C) => boolean]>): Array<{ step: string; calendar: number; rolling: number }> {
  let xs = [...cands];
  const out = [{ step: "STP triggers", calendar: xs.filter((c) => c.variantSource === "calendar").length, rolling: xs.filter((c) => c.variantSource === "rolling").length }];
  for (const [step, f] of steps) {
    xs = xs.filter(f);
    out.push({ step, calendar: xs.filter((c) => c.variantSource === "calendar").length, rolling: xs.filter((c) => c.variantSource === "rolling").length });
  }
  return out;
}

export const P3K3_GATE_STEPS: ReadonlyArray<[string, (c: P3k3Candidate) => boolean]> = [
  ["MAs (either order)", (c) => c.v2.ma],
  ["weekly or rolling-5 open", (c) => c.v2.opens],
  ["a named screen", (c) => c.v2.screens],
  ["no earnings ≤ 5 sessions", (c) => c.v2.earnings],
  ["R/R ≥ 3", (c) => c.v2.rr],
  ["optimal entry", (c) => c.v2.optimal],
  ["room to 3R (median rally)", (c) => c.v2.room],
];

export const P3K_GATE_STEPS: ReadonlyArray<[string, (c: P3kCandidate) => boolean]> = [
  ["Finviz base", (c) => c.p3k.finviz],
  ["stock aligned", (c) => c.p3k.aligned],
  ["no earnings ≤ 5 sessions", (c) => c.p3k.earnings],
  ["R/R ≥ 3", (c) => c.p3k.rr],
  ["optimal entry", (c) => c.p3k.optimal],
];

const r3 = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

function row(label: string, ts: readonly FunnelTrade[]): string {
  const m: GroupMetrics = groupMetrics(ts);
  const early = ts.filter(stoppedEarly).length;
  return `| ${label} | ${m.trades} | ${r3(m.expectancy)} | ${pct(m.winRate)} | ${pct(m.reached3RRate)} | ${pct(ts.length ? early / ts.length : null)} | ${m.controls} | ${r3(m.controlExpectancy)} |`;
}
const HEAD = ["| group | trades | net exp R | win | reached 3R | stopped ≤ 3 sessions | controls | control exp R |", "|---|---|---|---|---|---|---|---|"];

export function gateTable(title: string, counts: ReadonlyArray<{ step: string; calendar: number; rolling: number }>): string[] {
  return [`**${title}: candidates left after each gate, calendar vs rolling trigger**`, "", "| gate | calendar | rolling |", "|---|---|---|", ...counts.map((c) => `| ${c.step} | ${c.calendar} | ${c.rolling} |`), ""];
}

/** The P3-0k3 report section (pre-registered verdicts + descriptive), appended to the P3-0k report. */
export function p3k3Lines(
  results: readonly ComparisonResult[],
  trades: readonly FunnelTrade[],
  gates: { long: ReturnType<typeof gateCountsByVariant>; short: ReturnType<typeof gateCountsByVariant> },
  extra: { fudge23: string[]; roomNoProfile: number },
): string[] {
  const pick = (p: string, a = "stop") => trades.filter((t) => t.population === p && t.arm === a);
  const main = pick("p3k3");
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const out: string[] = [
    "## P3-0k3: aligned trend v2 (provisional; defined after the first P3-0k run)",
    "",
    "Stock gates: close beyond both sma20 and sma50, which are both beyond sma200 (either order; ties fail); close beyond the weekly or the rolling-5 open; at least one of Chris's named Finviz screens in the trade direction (F18/F19 need short float: live only); no earnings within 5 sessions; a calendar or rolling STP trigger (inside, U-turn, mech1, mech2); R/R ≥ 3; optimal entry; room to 3R left in the stock's median rally (k = 2 swing profile, ATR14 at D). " +
      "Size 1.0, halved once if the monthly or rolling-20 open isn't green, once each for sector and market not aligned, once for industry not aligned (no industry data is neutral), × 0.5 for an out-of-hours event, floor 0.25. Exit B with the event and earnings rules; after-trigger controls.",
    "",
    ...gateTable("Long", gates.long),
    ...gateTable("Short", gates.short),
    `Candidates without a swing profile (fewer than 4 legs; never candidates): ${extra.roomNoProfile}.`,
    "",
    `**Pre-registered (${results.length} comparisons, provisional): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT.**`,
    "",
    "| comparison | verdict | held-out trades | held-out net exp R | baseline held-out exp R | folds passed | reason |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (r) => `| ${r.group} | ${r.verdict}${r.verdict === "KEEP" ? " (provisional)" : ""} | ${r.heldOut.trades} | ${r3(r.heldOut.expectancy)} | ${r3(r.kind === "control" ? r.heldOut.controlExpectancy : r.benchHeldOut?.expectancy)} | ${r.foldsPassed} | ${cell(r.reason)} |`,
    ),
    "",
    "**Descriptive (stop entry, all trades):**",
    "",
    ...HEAD,
    row("all STP trades (p3k3_all)", pick("p3k3_all")),
    row("aligned v2 (p3k3)", main),
    row("plain Finviz base instead of the named screens", pick("p3k3_base")),
    row("with the slope variant (sma50, sma200 rising)", pick("p3k3_slope")),
    row("without the room gate", pick("p3k3_noroom")),
    row("room gate failed (in no-room, not in p3k3)", pick("p3k3_noroom").filter((t) => t.roomPass === false)),
    row("75th-percentile rally in the room gate", pick("p3k3_room75")),
    row("order 20 > 50", main.filter((t) => t.maOrder === "20>50")),
    row("order 50 > 20", main.filter((t) => t.maOrder === "50>20")),
    ...[1, 0.5, 0.25].map((s) => row(`layer size ${s}`, main.filter((t) => t.p3k3LayerSize === s))),
    row("monthly + rolling-20 green", main.filter((t) => t.monthlyR20Green === true)),
    row("monthly or rolling-20 not green", main.filter((t) => t.monthlyR20Green === false)),
    ...(["sector", "market", "industry"] as const).flatMap((l) => {
      const get = (t: FunnelTrade) => (l === "sector" ? t.alignSector : l === "market" ? t.alignMarket : t.industryV2);
      return [row(`${l} aligned`, main.filter((t) => get(t) === "aligned")), row(`${l} not aligned${l === "industry" ? " (data present)" : ""}`, main.filter((t) => get(t) != null && get(t) !== "aligned")), ...(l === "industry" ? [row("industry: no data (neutral)", main.filter((t) => get(t) == null))] : [])];
    }),
    row("calendar trigger", main.filter((t) => t.setupVariant === "calendar")),
    row("rolling trigger", main.filter((t) => t.setupVariant === "rolling")),
    "",
    "**Per named screen (a trade counts under every screen it passed):**",
    "",
    ...HEAD,
    ...[...new Set([...screensFor(1), ...screensFor(-1)].map((s) => s.id))].map((id) => row(id, main.filter((t) => (t.p3k3Screens ?? "").split(" ").includes(id)))),
    "",
    `**rally_used quintiles (leg so far ÷ median rally):**`,
    "",
    ...HEAD,
    ...(() => {
      const s = main.filter((t) => t.rallyUsedV2 != null).sort((a, b) => a.rallyUsedV2! - b.rallyUsedV2!);
      return [0, 1, 2, 3, 4].map((q) => {
        const g = s.slice(Math.floor((q * s.length) / 5), Math.floor(((q + 1) * s.length) / 5));
        return row(`Q${q + 1}${g.length ? ` (${g[0].rallyUsedV2!.toFixed(2)}–${g[g.length - 1].rallyUsedV2!.toFixed(2)})` : ""}`, g);
      });
    })(),
    "",
    "**Build to layer size vs the primary adds (descriptive):**",
    "",
    "| adds | trades | net exp R | mean size reached at exit (× full) |",
    "|---|---|---|---|",
    ...([["primary (50% at +2/+4/+6 ATR)", main], ["build to layer size (never beyond full)", pick("p3k3_build")]] as const).map(([l, ts]) => {
      const m = groupMetrics(ts);
      const reached = ts.length ? ts.reduce((s, t) => s + (t.sizeCombined ?? 1) * t.size, 0) / ts.length : null;
      return `| ${l} | ${m.trades} | ${r3(m.expectancy)} | ${r3(reached)} |`;
    }),
    "",
    ...extra.fudge23,
  ];
  return out;
}

export function p3k3ExperimentRow(results: readonly ComparisonResult[], meta: { number: number; date: string; commit: string; reportPath: string; trades: number }): string {
  const keep = results.filter((r) => r.verdict === "KEEP");
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const desc =
    `P3-0k3 ALIGNED TREND V2 (provisional, defined after the first P3-0k run), backfill, exit B + event and earnings rules: ${results.length} pre-registered comparisons. ` +
    `${keep.length} KEEP (provisional), ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. Survivorship-biased (current members only). Report: ${meta.reportPath}.`;
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${results.length} | Aligned trend v2 (prereg, provisional) | ${keep.length ? "keep (provisional)" : "discard"} | ${cell(keep.map((r) => r.id).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
