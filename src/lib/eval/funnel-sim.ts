/**
 * P3-0j funnel simulation on the backfill (docs/PHASE3-PREP.md §P3-0j). Pure: the script
 * loads the bars, ETF states, earnings and macro calendar and calls these.
 *
 * Per symbol, every calendar STP trigger becomes a candidate with its gates and R/R. Each
 * day's passing candidates are ranked by R/R across the universe. Then each population is
 * simulated per symbol with one position per ticker: `all` (every trigger, no gates, the
 * P3-0i baseline under the same management), `funnel` (all passing the gates), `top5` and
 * `top3`; arms `stop` and `pullback` (and `pullback_low` on top5, descriptive). Management:
 * exit B (adds every 2 × ATR, max 3, breakeven, trail after 3R) plus the event stop rule and
 * the earnings rule; size × 0.5 with an out-of-hours event within 5 sessions.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { pyramidLayers, type PyramidInputs } from "@/lib/harvester/universe/pyramid";
import { swingEntry, type Pivot } from "@/lib/harvester/universe/swings";
import { screensOn } from "@/lib/harvester/universe/finviz-screens";
import { eventBeforeIndices, outOfHoursWithin, type MacroEvent } from "@/lib/harvester/macro-calendar";
import { timeSplit, walkForwardFolds, FOLDS_REQUIRED, MIN_FOLD_ROWS, MIN_HELDOUT_ROWS, WALK_FORWARD_FOLDS } from "./rules";
import {
  BASE_RISK_DOLLARS,
  CONTROL_SEED,
  CONTROL_TRIES,
  atrSeries,
  controlPoolRange,
  passesWindow,
  PROVISIONAL_AFTER_ONLY,
  type ControlMode,
  controlSeed,
  entryOnNextBar,
  groupMetrics,
  initialShares,
  quarterOf,
  rng,
  simulateExit,
  stockFactor,
  type Dir,
  type EntryOutcome,
  type EventTier,
  type ExitExtras,
  type GroupMetrics,
  type GroupResult,
  type Scanned,
  type Setup,
  type SimVerdict,
  type Trade,
} from "./stp-sim";
import {
  FUNNEL_TOP,
  FUNNEL_TOP3,
  LEVEL_SWING_K,
  earningsWithin,
  funnelGates,
  funnelSize,
  limitEntryOnNextBar,
  nextEarnings,
  pullbackLimit,
  rankDay,
  riskReward,
  type EntryArm,
  type Gates,
  type RiskReward,
} from "./funnel";

/** P3-0j3: top5_noair is the descriptive ranking with open_air candidates left out. */
export type Population = "all" | "funnel" | "top5" | "top3" | "top5_noair";

export interface SymbolInput {
  symbol: string;
  bars: readonly DailyBar[];
  scanned: Scanned;
  /** Zigzag pivots at k = 2 (levels and rally_used). */
  pivots: readonly Pivot[];
  pyramid: PyramidInputs;
  /** EDGAR earnings sessions; undefined = no dates for this symbol. */
  earnings?: ReadonlySet<string>;
}

export interface FunnelContext {
  /** All SPY sessions, sorted (calendar for "sessions after D"). */
  sessions: readonly string[];
  events: readonly MacroEvent[];
  regime?: ReadonlyMap<string, Trade["regime"]>;
}

export interface Candidate {
  symbol: string;
  setup: Setup;
  date: string;
  dir: Dir;
  rr: RiskReward;
  gates: Gates;
  rallyUsed: number | null;
  eventHalf: boolean;
  /** null: no EDGAR dates for the symbol (not blocked). */
  earnings5: boolean | null;
  rank: number | null;
  /** P3-0j3 descriptive: rank among the day's passing candidates that aren't open_air. */
  rankNoAir: number | null;
  /** P3-0j3: entry − stop over ATR14 on D. */
  stopAtr: number | null;
}

/** Step 1 + 3 for one symbol: every calendar trigger with its gates and R/R. */
export function symbolCandidates(input: SymbolInput, ctx: FunnelContext): Candidate[] {
  const { bars, scanned, pivots, pyramid, earnings, symbol } = input;
  const closes = bars.map((b) => b.close);
  const atr = atrSeries(bars);
  const out: Candidate[] = [];
  for (const s of scanned.setups) {
    const rr = riskReward(bars, closes, s.i, s.dir, s.entry, s.stop, atr[s.i], pivots);
    const marketLong = pyramidLayers(pyramid, s.date, 1).market;
    const earnings5 = earningsWithin(s.date, earnings, ctx.sessions);
    const gates = funnelGates({ dir: s.dir, finvizBase: screensOn(bars, s.i, atr).base, earnings5, rr: rr.rr, marketLong });
    const risk = s.dir * (s.entry - s.stop);
    const rallyUsed = risk > 0 ? swingEntry(bars, s.i, s.entry, risk, s.dir, LEVEL_SWING_K, pivots).rallyUsed : null;
    const a = atr[s.i];
    out.push({
      symbol, setup: s, date: s.date, dir: s.dir, rr, gates, rallyUsed, eventHalf: !!outOfHoursWithin(s.date, ctx.events, ctx.sessions), earnings5,
      rank: null, rankNoAir: null, stopAtr: a != null && a > 0 && risk > 0 ? risk / a : null,
    });
  }
  return out;
}

/** Step 3: rank each day's passing candidates across the universe (sets `rank`). */
export function rankCandidates(cands: readonly Candidate[]): void {
  const byDate = new Map<string, Array<Candidate & { rr: RiskReward }>>();
  for (const c of cands) if (c.gates.pass && c.rr.rr != null) (byDate.get(c.date) ?? byDate.set(c.date, []).get(c.date)!).push(c);
  for (const day of byDate.values()) {
    const ranks = rankDay(day.map((c) => ({ c, rr: c.rr.rr!, rallyUsed: c.rallyUsed, symbol: c.symbol })));
    for (const [k, r] of ranks) k.c.rank = r;
    const noAir = rankDay(day.filter((c) => !c.rr.openAir).map((c) => ({ c, rr: c.rr.rr!, rallyUsed: c.rallyUsed, symbol: c.symbol })));
    for (const [k, r] of noAir) k.c.rankNoAir = r;
  }
}

export const inPopulation = (c: Candidate, p: Population) =>
  p === "all"
    ? true
    : p === "funnel"
      ? c.gates.pass
      : p === "top5"
        ? c.rank != null && c.rank <= FUNNEL_TOP
        : p === "top3"
          ? c.rank != null && c.rank <= FUNNEL_TOP3
          : c.rankNoAir != null && c.rankNoAir <= FUNNEL_TOP;

export interface FunnelTrade extends Trade {
  population: Population;
  arm: EntryArm;
  rank: number | null;
  rr: number | null;
  rrLevel: string | null;
  openAir: boolean;
  countertrend: boolean;
  eventHalf: boolean;
  eventTiers: EventTier[];
  /** The next earnings session after entry, and whether it fell < 10 sessions after the fill (look-ahead count). */
  earningsSession: string | null;
  earningsSoon: boolean;
  earningsUnknown: boolean;
  /** P3-0j3: the same trade with the event stop rule off (top5 only; null elsewhere). */
  netRNoEvent: number | null;
  stopAtr: number | null;
}

function entryFor(arm: EntryArm, bars: readonly DailyBar[], i: number, dir: Dir, entry: number, stop: number, fudge: number): EntryOutcome {
  if (arm === "stop") return entryOnNextBar(bars[i + 1], dir, entry, stop);
  return limitEntryOnNextBar(bars[i + 1], dir, pullbackLimit(bars[i], dir, fudge, arm), stop);
}

function extrasFor(f: number, dates: readonly string[], eventBefore: ReadonlySet<number>, earnings: ReadonlySet<string> | undefined): { extra: ExitExtras; e: string | null } {
  const e = nextEarnings(dates[f - 1], earnings);
  const eIdx = e ? dates.findIndex((d, k) => k >= f && d >= e) : -1;
  return { extra: { eventBefore, earningsAt: eIdx >= 0 ? eIdx : null }, e };
}

/**
 * Matched random-day control (as P3-0i's): a non-trigger session within ±20 of the trigger,
 * same direction, the same arm's entry from that bar (stop: high + fudge; pullback: that
 * bar's midpoint or low + fudge), stop low − fudge, the same size and management.
 */
export function funnelControl(
  c: Candidate,
  bars: readonly DailyBar[],
  closes: readonly number[],
  atr: ReadonlyArray<number | null>,
  dates: readonly string[],
  info: Scanned["info"],
  arm: EntryArm,
  baseRisk: number,
  eventBefore: ReadonlySet<number>,
  earnings: ReadonlySet<string> | undefined,
  mode: ControlMode = "after",
): { i: number; netR: number } | null {
  const pool: number[] = [];
  const range = controlPoolRange(c.setup.i, c.setup.type, bars.length, mode);
  for (let k = range.lo; k <= range.hi; k++) {
    if (k === c.setup.i) continue;
    if (info[k]?.trigger === 0 && info[k].fudge != null) pool.push(k);
  }
  const r = rng(controlSeed(c.symbol, `${c.date}|${arm}`, CONTROL_SEED));
  for (let t = 0; t < CONTROL_TRIES && pool.length > 0; t++) {
    const k = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const fudge = info[k].fudge!;
    const entry = c.dir === 1 ? bars[k].high + fudge : bars[k].low - fudge;
    const stop = c.dir === 1 ? bars[k].low - fudge : bars[k].high + fudge;
    const e = entryFor(arm, bars, k, c.dir, entry, stop, fudge);
    if (e.status !== "filled" || initialShares(baseRisk, e.risk) < 1) continue;
    const { extra } = extrasFor(k + 1, dates, eventBefore, earnings);
    return { i: k, netR: simulateExit(bars, closes, atr, k + 1, c.dir, e.fill, e.risk, stop, fudge, c.setup.type, "B", baseRisk, extra).netR };
  }
  return null;
}

export interface FunnelCounts {
  candidates: number;
  filled: number;
  notFilled: number;
  skippedOverlap: number;
  sizeSkip: number;
  noControl: number;
}

/** Steps 4–6 for one symbol, one population and one arm, one position per ticker. */
export function simulateFunnelSymbol(
  input: SymbolInput,
  cands: readonly Candidate[],
  population: Population,
  arm: EntryArm,
  ctx: FunnelContext,
): { trades: FunnelTrade[]; counts: FunnelCounts } {
  const { bars, scanned, pyramid, earnings, symbol } = input;
  const closes = bars.map((b) => b.close);
  const atr = atrSeries(bars);
  const dates = bars.map((b) => barDateOf(b) ?? "");
  const eventBefore = eventBeforeIndices(dates, ctx.events);
  const counts: FunnelCounts = { candidates: 0, filled: 0, notFilled: 0, skippedOverlap: 0, sizeSkip: 0, noControl: 0 };
  const trades: FunnelTrade[] = [];
  let openUntil = -1;
  for (const c of cands) {
    if (!inPopulation(c, population)) continue;
    counts.candidates++;
    const s = c.setup;
    if (s.i < openUntil) {
      counts.skippedOverlap++;
      continue;
    }
    const e = entryFor(arm, bars, s.i, s.dir, s.entry, s.stop, s.fudge);
    if (e.status !== "filled") {
      counts.notFilled++;
      continue;
    }
    const layers = pyramidLayers(pyramid, s.date, s.dir);
    const stock = stockFactor(s.htf, s.maState, s.dir);
    const size = funnelSize(stock, layers.sizeMult, c.eventHalf);
    const baseRisk = BASE_RISK_DOLLARS * size;
    if (initialShares(baseRisk, e.risk) < 1) {
      counts.sizeSkip++;
      continue;
    }
    counts.filled++;
    const f = s.i + 1;
    const { extra, e: earnSession } = extrasFor(f, dates, eventBefore, earnings);
    const x = simulateExit(bars, closes, atr, f, s.dir, e.fill, e.risk, s.stop, s.fudge, s.type, "B", baseRisk, extra);
    openUntil = x.exitIndex;
    const control = funnelControl(c, bars, closes, atr, dates, scanned.info, arm, baseRisk, eventBefore, earnings);
    const controlW = funnelControl(c, bars, closes, atr, dates, scanned.info, arm, baseRisk, eventBefore, earnings, "window");
    if (control == null) counts.noControl++;
    // P3-0j3 counterfactual: the same top-5 trade with the event stop rule off
    const noEvent = population === "top5" ? simulateExit(bars, closes, atr, f, s.dir, e.fill, e.risk, s.stop, s.fudge, s.type, "B", baseRisk, { ...extra, eventBefore: new Set() }).netR : null;
    const fillDate = dates[f] ?? "";
    const soonIdx = earnSession ? dates.findIndex((d, k) => k >= f && d >= earnSession) : -1;
    trades.push({
      population, arm, rank: c.rank, rr: c.rr.rr, rrLevel: c.rr.level, openAir: c.rr.openAir, countertrend: c.gates.countertrend, eventHalf: c.eventHalf,
      eventTiers: x.eventTiers ?? [], earningsSession: earnSession, earningsSoon: soonIdx >= 0 && soonIdx - f < 10, earningsUnknown: !earnings,
      variant: "calendar", swing: {}, layerMarket: layers.market, layerSector: layers.sector, layerIndustry: layers.industry,
      sizeMult: layers.sizeMult, sizeMultIndustry: layers.sizeMultIndustry, sizeMultOpens: layers.sizeMultOpens, sizeMultTrend: layers.sizeMultTrend,
      stockFactor: stock, sizeCombined: size, floorHit: stock * layers.sizeMult * (c.eventHalf ? 0.5 : 1) < 0.25, absFullFixedHalf: false,
      finvizBase: c.gates.gateFinviz, finvizScreens: [], baseRisk, shares: x.shares, sharesAtExit: x.sharesAtExit, dollarGross: x.dollarGross, dollarNet: x.dollarNet,
      alignment: null, weekUsed: null, monthUsed: null, roomW: null, symbol, scanId: s.date, scanStart: new Date(`${s.date}T21:00:00Z`),
      fillDate, exitDate: dates[x.exitIndex] ?? "", dir: s.dir, type: s.type, firedRules: s.firedRules, entry: s.entry, fill: e.fill, stop: s.stop,
      exit: x.exit, risk: e.risk, grossR: x.grossR, netR: x.netR, reason: x.reason, holding: x.holding, adds: x.adds, addGapSkips: x.addGapSkips,
      addCapReached: x.addCapReached, reached3R: x.reached3R, size: x.size, initialUnitR: x.initialUnitR, controlNetR: control?.netR ?? null,
      controlPost: control ? control.i > s.i : null,
      controlWindowNetR: controlW?.netR ?? null,
      controlWindowPost: controlW ? controlW.i > s.i : null,
      netRNoEvent: noEvent,
      stopAtr: c.stopAtr,
      regime: ctx.regime?.get(s.date) ?? null, quarter: quarterOf(s.date),
    });
  }
  return { trades, counts };
}

// ── Evaluation: the 10 pre-registered comparisons ─────────────────────────────

export type Comparison = { id: string; label: string; kind: "control" | "bench" | "arm"; sel: (t: FunnelTrade) => boolean; bench?: (t: FunnelTrade) => boolean; provisional: boolean };

const side = (d: Dir) => (d === 1 ? "long" : "short");

/** The 10 comparisons: per arm (stop, pullback) top5 vs all and top5 vs control, long and short; plus pullback vs stop on top5. */
export const FUNNEL_COMPARISONS: readonly Comparison[] = [
  ...(["stop", "pullback"] as const).flatMap((arm) =>
    ([1, -1] as const).flatMap((d): Comparison[] => [
      {
        id: `${arm}:top5-vs-all:${side(d)}`,
        label: `${arm} entry: funnel top-5 vs all trades, ${side(d)}`,
        kind: "bench",
        sel: (t) => t.arm === arm && t.population === "top5" && t.dir === d,
        bench: (t) => t.arm === arm && t.population === "all" && t.dir === d,
        provisional: arm === "pullback",
      },
      {
        id: `${arm}:top5-vs-control:${side(d)}`,
        label: `${arm} entry: funnel top-5 vs its matched random-day control, ${side(d)}`,
        kind: "control",
        sel: (t) => t.arm === arm && t.population === "top5" && t.dir === d,
        provisional: arm === "pullback",
      },
    ]),
  ),
  ...([1, -1] as const).map((d): Comparison => ({
    id: `arm:pullback-vs-stop:${side(d)}`,
    label: `funnel top-5: pullback vs stop entry, ${side(d)}`,
    kind: "arm",
    sel: (t) => t.arm === "pullback" && t.population === "top5" && t.dir === d,
    bench: (t) => t.arm === "stop" && t.population === "top5" && t.dir === d,
    provisional: true,
  })),
];

export interface ComparisonResult extends GroupResult {
  id: string;
  kind: Comparison["kind"];
  provisional: boolean;
  benchHeldOut: GroupMetrics | null;
}

/**
 * KEEP rule (as P3-0i): held-out net expectancy > 0 and above the baseline, with ≥ the
 * minimum held-out trades, and the same in ≥ 2 of 3 walk-forward folds. The baseline is the
 * matched control (`control`), all trades of the arm and direction (`bench`), or the stop
 * entry on the same top-5 (`arm`). The split is by trigger date over every simulated trade.
 */
export function evaluateFunnel(trades: readonly FunnelTrade[], comparisons: readonly Comparison[] = FUNNEL_COMPARISONS): ComparisonResult[] {
  const { test } = timeSplit(trades);
  const heldIds = new Set(test.map((t) => t.scanId));
  const foldIds = walkForwardFolds(trades).map((f) => new Set(f.test.map((t) => t.scanId)));
  return comparisons.map((c) => {
    const sel = trades.filter(c.sel);
    const bench = c.bench ? trades.filter(c.bench) : null;
    const within = (xs: readonly FunnelTrade[], ids: ReadonlySet<string>) => xs.filter((t) => ids.has(t.scanId));
    const ok = (m: GroupMetrics, ids: ReadonlySet<string>, min: number) => {
      if (m.trades < min || m.expectancy == null || m.expectancy <= 0) return false;
      if (c.kind === "control") return m.controlExpectancy != null && m.expectancy > m.controlExpectancy;
      const b = groupMetrics(within(bench!, ids));
      return b.expectancy != null && m.expectancy > b.expectancy;
    };
    const heldOut = groupMetrics(within(sel, heldIds));
    const folds = foldIds.map((ids) => groupMetrics(within(sel, ids)));
    const foldsPassed = folds.filter((f, k) => ok(f, foldIds[k], MIN_FOLD_ROWS)).length;
    let verdict: SimVerdict;
    let reason: string;
    const base = c.kind === "control" ? "its matched control" : c.kind === "bench" ? "all trades of its arm and direction" : "the stop entry on the same top-5";
    if (heldOut.trades < MIN_HELDOUT_ROWS) {
      verdict = "INSUFFICIENT";
      reason = `${heldOut.trades} held-out trades (need ${MIN_HELDOUT_ROWS})`;
    } else if (!ok(heldOut, heldIds, MIN_HELDOUT_ROWS)) {
      verdict = "DROP";
      reason = `held-out net expectancy not > 0 and above ${base}`;
    } else if (foldsPassed < FOLDS_REQUIRED) {
      verdict = "DROP";
      reason = `passes held out but only ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds (need ${FOLDS_REQUIRED})`;
    } else {
      verdict = "KEEP";
      reason = `passes held out and ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds` + (c.provisional ? "; PROVISIONAL until confirmed on ≥ 6 months of live data" : "");
      // P3-0j3: a control-kind KEEP must also hold against the ±20 control, or it's provisional
      if (c.kind === "control") {
        const wHeld = passesWindow(heldOut, MIN_HELDOUT_ROWS);
        const wFolds = folds.filter((f) => passesWindow(f, MIN_FOLD_ROWS)).length;
        if (!(wHeld && wFolds >= FOLDS_REQUIRED)) reason += `; ${PROVISIONAL_AFTER_ONLY}`;
      }
    }
    return {
      id: c.id, group: c.label, kind: c.kind, provisional: c.provisional, primary: true, all: groupMetrics(sel), heldOut, folds, foldsPassed, verdict, reason,
      benchHeldOut: bench ? groupMetrics(within(bench, heldIds)) : null,
    };
  });
}
