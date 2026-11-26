/**
 * P3-0k4 simulation glue (docs/PHASE3-PREP.md §P3-0k4): U-turn triggers over a symbol's whole
 * history, the move inputs, the p3k4 population (the P3-0k3 gates with the move gate in place of
 * the room gate), the 4 provisional comparisons, and the descriptive report section.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf, windowStart } from "@/lib/harvester/universe/backfill";
import { computeStp } from "@/lib/harvester/universe/stp";
import { computeStpRolling, ROLLING_WINDOWS, type RollingWindows } from "@/lib/harvester/universe/stp-rolling";
import { screensOn } from "@/lib/harvester/universe/finviz-screens";
import type { Pivot } from "@/lib/harvester/universe/swings";
import { groupMetrics, stoppedEarly, type Dir, type GroupMetrics } from "./stp-sim";
import {
  detectMoves,
  movePosition,
  MOVE_PRIMARY,
  MOVE_VARIANTS,
  summarizeMoves,
  type Move,
  type MoveInputs,
  type MoveOptions,
  type MovePosition,
  type MoveSummary,
  type MoveTrigger,
} from "./moves";
import { gateTable, p3k3SimOptions, type P3k3Candidate, type gateCountsByVariant } from "./aligned-v2-sim";
import type { Candidate, Comparison, ComparisonResult, FunnelTrade } from "./funnel-sim";

/** The candle shapes of a bullish / bearish U-turn (the STP pattern before its trend conditions). */
function uturnShape(b: DailyBar, p: DailyBar): 1 | -1 | 0 {
  if (b.open == null || p.open == null) return 0;
  if (b.high < p.high && p.close < p.open && b.close > p.close && b.low < p.low && b.close > p.low && b.close > b.open) return 1;
  if (b.low > p.low && p.close > p.open && b.close < p.close && b.high > p.high && b.close < p.high && b.close < b.open) return -1;
  return 0;
}

/**
 * butn / brutn triggers, calendar or rolling, on every bar of the history (not only the scanned
 * window), each from STP on the bar's live-window slice. STP runs only on bars with the candle shape.
 */
export function uturnTriggers(bars: readonly DailyBar[], windows: RollingWindows = ROLLING_WINDOWS.stock): MoveTrigger[] {
  const dates = bars.map((b) => barDateOf(b) ?? "");
  const out: MoveTrigger[] = [];
  let start = 0;
  for (let i = 1; i < bars.length; i++) {
    const shape = uturnShape(bars[i], bars[i - 1]);
    if (!shape || !dates[i]) continue;
    const ws = windowStart(dates[i]);
    while (start < i && dates[start] <= ws) start++;
    const slice = bars.slice(start, i + 1);
    const rule = shape === 1 ? "butn+" : "brutn-";
    if (computeStp(slice).firedRules.includes(rule) || computeStpRolling(slice, windows).firedRules.includes(rule)) out.push({ i, dir: shape, type: shape === 1 ? "butn" : "brutn" });
  }
  return out;
}

/** Move inputs for one symbol; F25/F22 (shorts F08/F13) evaluated on demand and cached. */
export function moveInputs(bars: readonly DailyBar[], pivots: readonly Pivot[], atr: ReadonlyArray<number | null>, triggers: readonly MoveTrigger[] = uturnTriggers(bars)): MoveInputs {
  const cache = new Map<number, ReturnType<typeof screensOn>>();
  const screen = (i: number) => cache.get(i) ?? cache.set(i, screensOn(bars, i, atr)).get(i)!;
  return {
    bars,
    pivots,
    atr,
    triggers,
    breakoutScreen: (i, dir) => {
      const s = screen(i).screens;
      return dir === 1 ? s.F25 === true || s.F22 === true : s.F08 === true || s.F13 === true;
    },
  };
}

export type SymbolMoves = Record<Dir, ReturnType<typeof detectMoves>>;

export const symbolMoves = (inp: MoveInputs, opts: MoveOptions = MOVE_PRIMARY): SymbolMoves => ({ 1: detectMoves(inp, 1, opts), [-1]: detectMoves(inp, -1, opts) }) as SymbolMoves;

export interface P3k4Candidate extends P3k3Candidate {
  move: MovePosition;
}

/** The P3-0k3 candidates with their move position at D. */
export function withMoves(cands: readonly P3k3Candidate[], inp: MoveInputs, det: SymbolMoves): P3k4Candidate[] {
  return cands.map((c) => ({ ...c, move: movePosition(inp, det[c.dir], c.setup.i, c.dir, c.setup.entry, c.setup.type) }));
}

const core = (c: P3k3Candidate) => c.v2.ma && c.v2.opens && c.v2.earnings && c.v2.rr && c.v2.optimal && c.v2.screens;
export const p3k4Member = (c: P3k4Candidate) => core(c) && c.move.pass;

/** Move tags for any P3-0k3/0k4 trade whose candidate carries a move position. */
export const moveTags = (c: Candidate): Partial<FunnelTrade> => {
  const m = (c as Partial<P3k4Candidate>).move;
  return m ? { moveActive: m.active, moveStart: m.startType, movePauses: m.pausesSoFar, moveUsed: m.moveUsed, moveProfile: m.profile != null } : {};
};

/** simulateFunnelSymbol options for p3k4: the P3-0k3 size, tags and management, the move gate as membership. */
export function p3k4SimOptions() {
  const base = p3k3SimOptions("p3k3");
  return { ...base, member: (c: Candidate) => p3k4Member(c as P3k4Candidate), tag: (c: Candidate) => ({ ...base.tag(c), ...moveTags(c) }) };
}

/** P3-0k3 run options with the move tags added (membership unchanged). */
export function p3k3SimOptionsWithMoves(p: Parameters<typeof p3k3SimOptions>[0]) {
  const base = p3k3SimOptions(p);
  return { ...base, tag: (c: Candidate) => ({ ...base.tag(c), ...moveTags(c) }) };
}

const side = (d: Dir) => (d === 1 ? "long" : "short");
/** The 4 P3-0k3 comparisons with the move gate in place of the room gate (provisional). */
export const P3K4_COMPARISONS: readonly Comparison[] = ([1, -1] as const).flatMap((d): Comparison[] => [
  {
    id: `p3k4:vs-all:${side(d)}`,
    label: `aligned v2 + move gate vs all STP trades, ${side(d)}`,
    kind: "bench",
    sel: (t) => t.arm === "stop" && t.population === "p3k4" && t.dir === d,
    bench: (t) => t.arm === "stop" && t.population === "p3k3_all" && t.dir === d,
    provisional: true,
  },
  {
    id: `p3k4:vs-control:${side(d)}`,
    label: `aligned v2 + move gate vs its after-trigger matched control, ${side(d)}`,
    kind: "control",
    sel: (t) => t.arm === "stop" && t.population === "p3k4" && t.dir === d,
    provisional: true,
  },
]);

export const P3K4_GATE_STEPS: ReadonlyArray<[string, (c: P3k4Candidate) => boolean]> = [
  ["MAs (either order)", (c) => c.v2.ma],
  ["weekly or rolling-5 open", (c) => c.v2.opens],
  ["a named screen", (c) => c.v2.screens],
  ["no earnings ≤ 5 sessions", (c) => c.v2.earnings],
  ["R/R ≥ 3", (c) => c.v2.rr],
  ["optimal entry", (c) => c.v2.optimal],
  ["an active move at D", (c) => c.move.active],
  ["a move profile (≥ 3 completed moves)", (c) => c.move.profile != null],
  ["pauses so far 1 or 2", (c) => c.move.pausesSoFar === 1 || c.move.pausesSoFar === 2],
  ["move used ≤ 0.5", (c) => c.move.pass],
];

/** Universe-wide move statistics without keeping every move (per variant and direction). */
export class MoveStats {
  private sizes: number[] = [];
  private legs: number[] = [];
  private durations: number[] = [];
  private pauseDepths: number[] = [];
  moves = 0;
  failed = 0;
  open = 0;
  startMix: MoveSummary["startMix"] = { swing: 0, uturn: 0, breakout: 0 };
  endMix: MoveSummary["endMix"] = { uturn_volume: 0, mx_break: 0, structure: 0, failed_breakout: 0 };
  failedByStart: MoveSummary["failedByStart"] = { swing: { n: 0, failed: 0 }, uturn: { n: 0, failed: 0 }, breakout: { n: 0, failed: 0 } };

  add(moves: readonly Move[]): void {
    const s = summarizeMoves(moves);
    this.moves += s.moves;
    this.failed += s.failed;
    this.open += s.open;
    for (const k of Object.keys(s.startMix) as Array<keyof MoveSummary["startMix"]>) {
      this.startMix[k] += s.startMix[k];
      this.failedByStart[k].n += s.failedByStart[k].n;
      this.failedByStart[k].failed += s.failedByStart[k].failed;
    }
    for (const k of Object.keys(s.endMix) as Array<keyof MoveSummary["endMix"]>) this.endMix[k] += s.endMix[k];
    for (const m of moves)
      if (m.endBar != null && !m.failed) {
        this.sizes.push(m.size);
        this.legs.push(m.legs);
        this.durations.push(m.duration);
        this.pauseDepths.push(...m.pauses);
      }
  }

  private static q(xs: number[], q: number): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
  }

  summary() {
    const mean = this.legs.length ? this.legs.reduce((a, b) => a + b, 0) / this.legs.length : null;
    return {
      moves: this.moves,
      failed: this.failed,
      open: this.open,
      medianSize: MoveStats.q(this.sizes, 0.5),
      p75Size: MoveStats.q(this.sizes, 0.75),
      medianLegs: MoveStats.q(this.legs, 0.5),
      meanLegs: mean,
      medianDuration: MoveStats.q(this.durations, 0.5),
      medianPauseDepth: MoveStats.q(this.pauseDepths, 0.5),
      startMix: this.startMix,
      endMix: this.endMix,
      failedByStart: this.failedByStart,
    };
  }
}

/** Per variant name, per direction. */
export type MoveStatsTable = Record<string, Record<"long" | "short", MoveStats>>;
export const newMoveStatsTable = (): MoveStatsTable =>
  Object.fromEntries(Object.keys(MOVE_VARIANTS).map((k) => [k, { long: new MoveStats(), short: new MoveStats() }]));

const r2 = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(2));
const r3 = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

function row(label: string, ts: readonly FunnelTrade[]): string {
  const m: GroupMetrics = groupMetrics(ts);
  const early = ts.filter(stoppedEarly).length;
  return `| ${label} | ${m.trades} | ${r3(m.expectancy)} | ${pct(m.winRate)} | ${pct(m.reached3RRate)} | ${pct(ts.length ? early / ts.length : null)} | ${m.controls} | ${r3(m.controlExpectancy)} |`;
}
const HEAD = ["| group | trades | net exp R | win | reached 3R | stopped ≤ 3 sessions | controls | control exp R |", "|---|---|---|---|---|---|---|---|"];

/** The P3-0k4 report section: descriptive first (as the spec orders it), then the pre-registered verdicts. */
export function p3k4Lines(
  results: readonly ComparisonResult[],
  trades: readonly FunnelTrade[],
  gates: { long: ReturnType<typeof gateCountsByVariant>; short: ReturnType<typeof gateCountsByVariant> },
  stats: MoveStatsTable,
): string[] {
  const pick = (p: string) => trades.filter((t) => t.population === p && t.arm === "stop");
  const noroom = pick("p3k3_noroom");
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const prim = stats.primary;
  const profileRows = (["long", "short"] as const).map((d) => {
    const s = prim[d].summary();
    return `| ${d} | ${s.moves} | ${s.failed} (${pct(s.moves ? s.failed / s.moves : null)}) | ${s.open} | ${r2(s.medianSize)} | ${r2(s.p75Size)} | ${r2(s.medianLegs)} | ${r2(s.meanLegs)} | ${r2(s.medianDuration)} | ${r2(s.medianPauseDepth)} |`;
  });
  const mixRows = (["long", "short"] as const).flatMap((d) => {
    const s = prim[d].summary();
    const fr = (k: keyof typeof s.failedByStart) => pct(s.failedByStart[k].n ? s.failedByStart[k].failed / s.failedByStart[k].n : null);
    return [
      `| ${d} | swing ${s.startMix.swing}, U-turn ${s.startMix.uturn}, breakout ${s.startMix.breakout} | U-turn on volume ${s.endMix.uturn_volume}, mX/pmX break ${s.endMix.mx_break}, structure ${s.endMix.structure}, failed breakout ${s.endMix.failed_breakout} | swing ${fr("swing")}, U-turn ${fr("uturn")}, breakout ${fr("breakout")} |`,
    ];
  });
  const variantRows = Object.entries(stats).flatMap(([name, byDir]) =>
    (["long", "short"] as const).map((d) => {
      const s = byDir[d].summary();
      return `| ${name} | ${d} | ${s.moves} | ${pct(s.moves ? s.failed / s.moves : null)} | ${r2(s.medianSize)} | ${r2(s.medianLegs)} | ${r2(s.meanLegs)} | swing ${s.startMix.swing} / U-turn ${s.startMix.uturn} / breakout ${s.startMix.breakout} |`;
    }),
  );
  const bucket = (t: FunnelTrade) => (!t.moveActive ? "no active move" : t.movePauses == null ? "n/a" : t.movePauses >= 4 ? "4+" : String(t.movePauses));
  const withUsed = noroom.filter((t) => t.moveUsed != null).sort((a, b) => a.moveUsed! - b.moveUsed!);
  return [
    "## P3-0k4: moves, not legs (provisional; replaces the P3-0k3 room gate)",
    "",
    "A move starts on a higher confirmed k = 2 swing low, a butn trigger, or a close above a ≤ 3 ATR 20-session range passing F25/F22 (shorts mirrored); it ends on a brutn with volume above its 20-session average, a close below an armed mX/pmX level, a lower swing high then a close below the last swing low, or a failed breakout. " +
      "Profile: the stock's completed moves ending by D in the last 750 sessions (≥ 3; moves under 1 ATR are failed starts). Gate: an active move, pauses so far 1 or 2, move used ≤ 0.5 of the median move. Everything else as P3-0k3.",
    "",
    "**1. Universe move profile (primary rules; completed moves, failed starts excluded from the sizes):**",
    "",
    "| dir | completed moves | failed starts (< 1 ATR) | open at the end | median size ATR | 75th size ATR | median legs | mean legs | median duration (sessions) | median pause depth ATR |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...profileRows,
    "",
    "| dir | start types | end types | failed-start rate by start |",
    "|---|---|---|---|",
    ...mixRows,
    "",
    "**2. P3-0k3 trades with the room gate off, by position in the move:**",
    "",
    ...HEAD,
    ...["no active move", "0", "1", "2", "3", "4+"].map((b) => row(`pauses so far ${b}`, noroom.filter((t) => bucket(t) === b))),
    ...[0, 1, 2, 3, 4].map((q) => {
      const g = withUsed.slice(Math.floor((q * withUsed.length) / 5), Math.floor(((q + 1) * withUsed.length) / 5));
      return row(`move used Q${q + 1}${g.length ? ` (${g[0].moveUsed!.toFixed(2)}–${g[g.length - 1].moveUsed!.toFixed(2)})` : ""}`, g);
    }),
    "",
    "**3–4. Rule variants (legs per move near 1 means the end rule is too tight):**",
    "",
    "| variant | dir | completed moves | failed-start rate | median size ATR | median legs | mean legs | start mix |",
    "|---|---|---|---|---|---|---|---|",
    ...variantRows,
    "",
    "**5. Old room gate side by side (stop entry):**",
    "",
    ...HEAD,
    row("P3-0k3 with the room gate (p3k3)", pick("p3k3")),
    row("P3-0k3 with the move gate (p3k4)", pick("p3k4")),
    row("P3-0k3 with neither (p3k3_noroom)", noroom),
    "",
    ...gateTable("P3-0k4 long", gates.long),
    ...gateTable("P3-0k4 short", gates.short),
    `**Pre-registered (${results.length} comparisons, provisional): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT.**`,
    "",
    "| comparison | verdict | held-out trades | held-out net exp R | baseline held-out exp R | folds passed | reason |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (r) => `| ${r.group} | ${r.verdict}${r.verdict === "KEEP" ? " (provisional)" : ""} | ${r.heldOut.trades} | ${r3(r.heldOut.expectancy)} | ${r3(r.kind === "control" ? r.heldOut.controlExpectancy : r.benchHeldOut?.expectancy)} | ${r.foldsPassed} | ${cell(r.reason)} |`,
    ),
    "",
  ];
}

export function p3k4ExperimentRow(results: readonly ComparisonResult[], meta: { number: number; date: string; commit: string; reportPath: string; trades: number }): string {
  const keep = results.filter((r) => r.verdict === "KEEP");
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const desc =
    `P3-0k4 MOVES (provisional, set after the second P3-0k3 run): P3-0k3 with the move gate (active move, pauses 1–2, move used ≤ 0.5) in place of the room gate, backfill, exit B + event and earnings rules: ${results.length} pre-registered comparisons. ` +
    `${keep.length} KEEP (provisional), ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. Survivorship-biased (current members only). Report: ${meta.reportPath}.`;
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${results.length} | Moves gate (prereg, provisional) | ${keep.length ? "keep (provisional)" : "discard"} | ${cell(keep.map((r) => r.id).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}

