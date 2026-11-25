/**
 * P3-0k simulation: aligned-trend candidates on the backfill (docs/PHASE3-PREP.md §P3-0k).
 * Pure. Reuses the P3-0j simulator (entry arms, exit B + event and earnings rules, the
 * after-trigger matched control) with P3-0k's own membership and size.
 */
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { screensOn } from "@/lib/harvester/universe/finviz-screens";
import { swingEntry } from "@/lib/harvester/universe/swings";
import { outOfHoursWithin } from "@/lib/harvester/macro-calendar";
import { atrSeries, type Dir, type Setup } from "./stp-sim";
import { earningsWithin, LEVEL_SWING_K, RR_MIN, riskReward, type EntryArm } from "./funnel";
import { alignmentAt, forDir, marketAlignment, optimalEntry, p3kLayerSize, p3kSize, type Alignment, type AlignState } from "./aligned";
import type { Candidate, Comparison, FunnelContext, FunnelTrade, Population, SymbolInput } from "./funnel-sim";

/** STP patterns P3-0k trades: inside, U-turns (butn/brutn), mech1, mech2. EGOP is descriptive from P3-0k on. */
export const P3K_TYPES = new Set(["inside", "butn", "brutn", "mech1", "mech2"]);

/** Long-direction alignment by date for the stock's layer ETFs. */
export interface LayerSeries {
  industry: ReadonlyMap<string, Alignment> | null;
  sector: ReadonlyMap<string, Alignment> | null;
  /** SPY, QQQ, DIA. */
  market: ReadonlyArray<ReadonlyMap<string, Alignment> | null>;
}

export interface P3kGates {
  finviz: boolean;
  aligned: boolean;
  opensAligned: boolean;
  masAligned: boolean;
  earnings: boolean;
  rr: boolean;
  optimal: boolean;
}

export interface P3kCandidate extends Candidate {
  variantSource: "calendar" | "rolling";
  stock: Alignment;
  industry: AlignState | null;
  sector: AlignState | null;
  market: AlignState | null;
  p3k: P3kGates;
  stopBeyondAtr: number | null;
}

/** Layer states for a direction on a date (null when the ETF has no value that day). */
export function layerStates(layers: LayerSeries, date: string, dir: Dir): { industry: AlignState | null; sector: AlignState | null; market: AlignState | null } {
  const at = (m: ReadonlyMap<string, Alignment> | null) => forDir(m?.get(date)?.state, dir);
  return { industry: at(layers.industry), sector: at(layers.sector), market: marketAlignment(layers.market.map(at)) };
}

/**
 * Every P3-0k-type STP trigger for one symbol (calendar and rolling; when both fire the same
 * day and direction, the calendar one is kept), with its gates.
 */
export function p3kCandidates(input: SymbolInput, layers: LayerSeries, ctx: FunnelContext): P3kCandidate[] {
  const { bars, scanned, pivots, earnings, symbol } = input;
  const closes = bars.map((b) => b.close);
  const atr = atrSeries(bars);
  const seen = new Set<string>();
  const setups: Array<[Setup, "calendar" | "rolling"]> = [];
  for (const [list, v] of [[scanned.setups, "calendar"], [scanned.rollingSetups, "rolling"]] as const)
    for (const s of list) {
      const key = `${s.i}|${s.dir}`;
      if (!P3K_TYPES.has(s.type) || seen.has(key)) continue;
      seen.add(key);
      setups.push([s, v]);
    }
  setups.sort((a, b) => a[0].i - b[0].i);
  const out: P3kCandidate[] = [];
  for (const [s, variantSource] of setups) {
    const date = barDateOf(bars[s.i]) ?? s.date;
    const stock = alignmentAt(bars, closes, s.i, s.dir);
    const rr = riskReward(bars, closes, s.i, s.dir, s.entry, s.stop, atr[s.i], pivots);
    const opt = optimalEntry(bars, closes, s.i, s.dir, s.entry, s.stop, atr[s.i], pivots);
    const earnings5 = earningsWithin(date, earnings, ctx.sessions);
    const finviz = screensOn(bars, s.i, atr).base === true;
    const l = layerStates(layers, date, s.dir);
    const p3k: P3kGates = {
      finviz,
      aligned: stock.state === "aligned",
      opensAligned: stock.opens === "aligned",
      masAligned: stock.mas === "aligned",
      earnings: earnings5 !== true,
      rr: rr.rr != null && rr.rr >= RR_MIN,
      optimal: opt.optimal,
    };
    const risk = s.dir * (s.entry - s.stop);
    const a = atr[s.i];
    const pass = p3k.finviz && p3k.aligned && p3k.earnings && p3k.rr && p3k.optimal;
    out.push({
      symbol, setup: s, date, dir: s.dir, rr, rallyUsed: risk > 0 ? swingEntry(bars, s.i, s.entry, risk, s.dir, LEVEL_SWING_K, pivots).rallyUsed : null,
      eventHalf: !!outOfHoursWithin(date, ctx.events, ctx.sessions), earnings5, rank: null, rankNoAir: null,
      stopAtr: a != null && a > 0 && risk > 0 ? risk / a : null,
      gates: { pass, gateFinviz: finviz, gateEarnings5: p3k.earnings, gateRr: p3k.rr, rrMin: RR_MIN, countertrend: false },
      variantSource, stock, ...l, p3k, stopBeyondAtr: opt.stopBeyondAtr,
    });
  }
  return out;
}

const base = (c: P3kCandidate) => c.p3k.finviz && c.p3k.earnings && c.p3k.rr;
/** Membership per P3-0k population. */
export const p3kMember: Record<Extract<Population, `p3k${string}`>, (c: P3kCandidate) => boolean> = {
  p3k_all: () => true,
  p3k: (c) => base(c) && c.p3k.aligned && c.p3k.optimal,
  p3k_noopt: (c) => base(c) && c.p3k.aligned,
  p3k_opens: (c) => base(c) && c.p3k.opensAligned && c.p3k.optimal,
  p3k_mas: (c) => base(c) && c.p3k.masAligned && c.p3k.optimal,
};

export const p3kCandidateSize = (c: P3kCandidate) => p3kSize([c.industry, c.sector, c.market], c.eventHalf);

/** Population × arm runs: the primary p3k on both arms, every other population on the stop entry. */
export const P3K_RUNS: ReadonlyArray<[Extract<Population, `p3k${string}`>, EntryArm]> = [
  ["p3k_all", "stop"],
  ["p3k", "stop"],
  ["p3k", "pullback"],
  ["p3k_noopt", "stop"],
  ["p3k_opens", "stop"],
  ["p3k_mas", "stop"],
];

/** Options for simulateFunnelSymbol: membership, the P3-0k size, and the trade tags. */
export function p3kSimOptions(population: Extract<Population, `p3k${string}`>) {
  return {
    member: (c: Candidate) => p3kMember[population](c as P3kCandidate),
    size: (c: Candidate) => p3kCandidateSize(c as P3kCandidate),
    tag: (c: Candidate): Partial<FunnelTrade> => {
      const p = c as P3kCandidate;
      return { p3kLayerSize: p3kLayerSize([p.industry, p.sector, p.market]), alignIndustry: p.industry, alignSector: p.sector, alignMarket: p.market, setupVariant: p.variantSource };
    },
  };
}

const side = (d: Dir) => (d === 1 ? "long" : "short");
/** The 4 pre-registered P3-0k comparisons (stop entry). */
export const P3K_COMPARISONS: readonly Comparison[] = ([1, -1] as const).flatMap((d): Comparison[] => [
  {
    id: `p3k:vs-all:${side(d)}`,
    label: `aligned + optimal entry vs all STP trades, ${side(d)}`,
    kind: "bench",
    sel: (t) => t.arm === "stop" && t.population === "p3k" && t.dir === d,
    bench: (t) => t.arm === "stop" && t.population === "p3k_all" && t.dir === d,
    provisional: false,
  },
  {
    id: `p3k:vs-control:${side(d)}`,
    label: `aligned + optimal entry vs its after-trigger matched control, ${side(d)}`,
    kind: "control",
    sel: (t) => t.arm === "stop" && t.population === "p3k" && t.dir === d,
    provisional: false,
  },
]);

export interface GateCounts {
  triggers: number;
  finviz: number;
  aligned: number;
  earnings: number;
  rr: number;
  optimal: number;
}

/** Candidates left after each gate, in order (the report's funnel counts). */
export function gateCounts(cands: readonly P3kCandidate[]): GateCounts {
  let xs = [...cands];
  const triggers = xs.length;
  xs = xs.filter((c) => c.p3k.finviz);
  const finviz = xs.length;
  xs = xs.filter((c) => c.p3k.aligned);
  const aligned = xs.length;
  xs = xs.filter((c) => c.p3k.earnings);
  const earnings = xs.length;
  xs = xs.filter((c) => c.p3k.rr);
  const rr = xs.length;
  xs = xs.filter((c) => c.p3k.optimal);
  return { triggers, finviz, aligned, earnings, rr, optimal: xs.length };
}
