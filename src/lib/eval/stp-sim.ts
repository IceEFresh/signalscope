/**
 * P3-0i: STP trigger trade simulation (pure), docs/PHASE3-PREP.md, under the rules
 * fixed in docs/PHASE3-PREREG.md "STP trigger trades (P3-0i)". LOG ONLY.
 *
 * Setups come from computeStp on each day's live-window slice (same slicing as the
 * P3-0g backfill: bars dated ≤ D, after D minus 3 months). Every trade decision on
 * day D+1 or later reads only that day's own bar and earlier ones.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sma } from "@/lib/harvester/universe/bar-features";
import { computeStp, htfOpensAt } from "@/lib/harvester/universe/stp";
import { barDateOf, windowStart } from "@/lib/harvester/universe/backfill";
import { computeStpRolling, ROLLING_WINDOWS, type RollingWindows } from "@/lib/harvester/universe/stp-rolling";
import { timeSplit, walkForwardFolds, FOLDS_REQUIRED, MIN_FOLD_ROWS, MIN_HELDOUT_ROWS, WALK_FORWARD_FOLDS } from "./rules";

export const SIM_VERSION = 1;
/** Round-trip cost as a share of the fill price (0.10%), charged in R per trade. */
export const COST_ROUND_TRIP = 0.001;
/** Fixed seed for the matched controls (pre-registered). */
export const CONTROL_SEED = 20261125;
/** Controls are drawn from non-trigger sessions within ±this many sessions of the trigger. */
export const CONTROL_WINDOW = 20;
/** Random control sessions tried, without replacement, until one fills. */
export const CONTROL_TRIES = 5;

export type ExitRule = "A" | "B";
export const EXIT_RULES: Record<ExitRule, { targetR: number; maxSessions: number; trailing: boolean }> = {
  A: { targetR: 2, maxSessions: 10, trailing: false },
  B: { targetR: 3, maxSessions: 20, trailing: true },
};

export type Dir = 1 | -1;

/** Which trend definition produced the setup: calendar weekly/monthly opens (computeStp) or rolling opens (step 1c). */
export type Variant = "calendar" | "rolling";

export interface Setup {
  variant: Variant;
  /** stp_htf_opens on the trigger bar (calendar opens), for the step 1b alignment split. */
  htf: number | null;
  symbol: string;
  /** Trigger bar's date (ET) and index in the symbol's bars. */
  date: string;
  i: number;
  dir: Dir;
  type: string;
  firedRules: string[];
  entry: number;
  stop: number;
  fudge: number;
}

export interface BarInfo {
  date: string;
  /** computeStp on that day's slice: +1, −1, 0, or null when it can't be computed. */
  trigger: number | null;
  /** computeStpRolling (inside and U-turn with rolling opens) on the same slice. */
  triggerRolling: number | null;
  fudge: number | null;
}

export interface Scanned {
  setups: Setup[];
  rollingSetups: Setup[];
  info: BarInfo[];
}

/**
 * computeStp and computeStpRolling for every bar (dated in `sessions`, when given) on the
 * live-window slice ending at it. `windows` is the rolling window (5/20 stocks, 7/30 crypto).
 */
export function scanSymbol(symbol: string, bars: readonly DailyBar[], sessions?: ReadonlySet<string>, windows: RollingWindows = ROLLING_WINDOWS.stock): Scanned {
  const dates = bars.map((b) => barDateOf(b) ?? "");
  const info: BarInfo[] = [];
  const setups: Setup[] = [];
  const rollingSetups: Setup[] = [];
  let start = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = dates[i];
    if (!d || (sessions && !sessions.has(d))) {
      info.push({ date: d, trigger: null, triggerRolling: null, fudge: null });
      continue;
    }
    const ws = windowStart(d);
    while (start < i && dates[start] <= ws) start++;
    const slice = bars.slice(start, i + 1);
    const s = computeStp(slice);
    const r = computeStpRolling(slice, windows);
    info.push({ date: d, trigger: s.trigger, triggerRolling: r.trigger, fudge: s.fudge });
    if ((s.trigger === 1 || s.trigger === -1) && s.entry != null && s.stop != null && s.fudge != null && s.triggerType) {
      setups.push({ variant: "calendar", htf: s.htfOpens, symbol, date: d, i, dir: s.trigger, type: s.triggerType, firedRules: s.firedRules, entry: s.entry, stop: s.stop, fudge: s.fudge });
    }
    if ((r.trigger === 1 || r.trigger === -1) && r.entry != null && r.stop != null && r.fudge != null && r.triggerType) {
      rollingSetups.push({ variant: "rolling", htf: s.htfOpens, symbol, date: d, i, dir: r.trigger, type: r.triggerType, firedRules: r.firedRules, entry: r.entry, stop: r.stop, fudge: r.fudge });
    }
  }
  return { setups, rollingSetups, info };
}

export interface Overlap {
  both: number;
  calendarOnly: number;
  rollingOnly: number;
}

/** Step 1c overlap: inside and U-turn setups (same ticker, date and direction) that both definitions fire, or only one. */
export function setupOverlap(calendar: readonly Setup[], rolling: readonly Setup[]): Overlap {
  const key = (s: Setup) => `${s.symbol}|${s.date}|${s.dir}`;
  const cal = new Set(calendar.filter((s) => s.type === "inside" || s.type === "butn" || s.type === "brutn").map(key));
  const rol = new Set(rolling.map(key));
  let both = 0;
  for (const k of cal) if (rol.has(k)) both++;
  return { both, calendarOnly: cal.size - both, rollingOnly: rol.size - both };
}

export type EntryOutcome =
  | { status: "filled"; fill: number; risk: number }
  | { status: "cancelled" }
  | { status: "skipped_gap" }
  | { status: "no_bar" };

/**
 * The D+1 stop order, valid one session. Long fills if the D+1 high reaches the entry,
 * at max(entry, open); a gap past the stop, or R ≤ 0, skips the setup. Short mirrored.
 * Reads only bar D+1.
 */
export function entryOnNextBar(next: DailyBar | undefined, dir: Dir, entry: number, stop: number): EntryOutcome {
  if (!next) return { status: "no_bar" };
  const open = next.open ?? null;
  if (dir === 1) {
    if (next.high < entry) return { status: "cancelled" };
    if (open != null && open <= stop) return { status: "skipped_gap" };
    const fill = open != null ? Math.max(entry, open) : entry;
    const risk = fill - stop;
    return risk > 0 ? { status: "filled", fill, risk } : { status: "skipped_gap" };
  }
  if (next.low > entry) return { status: "cancelled" };
  if (open != null && open >= stop) return { status: "skipped_gap" };
  const fill = open != null ? Math.min(entry, open) : entry;
  const risk = stop - fill;
  return risk > 0 ? { status: "filled", fill, risk } : { status: "skipped_gap" };
}

const crossesBelow = (p: number | null, pl: number | null, c: number | null, cl: number | null) => p != null && pl != null && c != null && cl != null && p >= pl && c < cl;
const crossesAbove = (p: number | null, pl: number | null, c: number | null, cl: number | null) => p != null && pl != null && c != null && cl != null && p <= pl && c > cl;

/**
 * Exit B trailing stop after bar t closes (docs/STP-SIGNALS.md "Exits"), applied from
 * bar t+1. Long: mX (close or sma10 crosses below sma20) and pmX (trendDirection[t−1] ≥ 1
 * and close crosses below sma10) move the stop to low[t] − fudge; the bar stop (while
 * trendDirection ≥ 1 and close > low[t−1]) trails at low[t−1] − fudge. Short mirrored.
 * The stop only ever tightens. Uses bars ≤ t only.
 */
export function trailStop(bars: readonly DailyBar[], closes: readonly number[], t: number, dir: Dir, stop: number, fudge: number): number {
  if (t < 1) return stop;
  const s10 = sma(closes, 10, t);
  const s20 = sma(closes, 20, t);
  const s10p = sma(closes, 10, t - 1);
  const s20p = sma(closes, 20, t - 1);
  const c = closes[t];
  const cp = closes[t - 1];
  const td = htfOpensAt(bars, t);
  const tdPrev = htfOpensAt(bars, t - 1);
  const cands: number[] = [];
  if (dir === 1) {
    if (crossesBelow(cp, s20p, c, s20) || crossesBelow(s10p, s20p, s10, s20)) cands.push(bars[t].low - fudge);
    if (tdPrev != null && tdPrev >= 1 && crossesBelow(cp, s10p, c, s10)) cands.push(bars[t].low - fudge);
    if (td != null && td >= 1 && c > bars[t - 1].low) cands.push(bars[t - 1].low - fudge);
    return Math.max(stop, ...cands);
  }
  if (crossesAbove(cp, s20p, c, s20) || crossesAbove(s10p, s20p, s10, s20)) cands.push(bars[t].high + fudge);
  if (tdPrev != null && tdPrev <= -1 && crossesAbove(cp, s10p, c, s10)) cands.push(bars[t].high + fudge);
  if (td != null && td <= -1 && c < bars[t - 1].high) cands.push(bars[t - 1].high + fudge);
  return Math.min(stop, ...cands);
}

export type ExitReason = "stop" | "stop_gap" | "trail_stop" | "target" | "time" | "end_of_data";

export interface TradeExit {
  exitIndex: number;
  exit: number;
  reason: ExitReason;
  grossR: number;
  netR: number;
  holding: number;
}

export const costInR = (fill: number, risk: number) => (COST_ROUND_TRIP * fill) / risk;

/**
 * Walk the trade from the fill bar f. Per bar: a gap through the stop exits at the open,
 * a gap through the target exits at the target (conservative); a bar touching both the
 * stop and the target exits at the stop, including the fill bar; then the target; then
 * the time exit at the close of session f + maxSessions. Data ending first exits at the
 * last close.
 */
export function simulateExit(
  bars: readonly DailyBar[],
  closes: readonly number[],
  f: number,
  dir: Dir,
  fill: number,
  risk: number,
  stop0: number,
  fudge: number,
  rule: ExitRule,
): TradeExit {
  const { targetR, maxSessions, trailing } = EXIT_RULES[rule];
  const target = fill + dir * targetR * risk;
  let stop = stop0;
  const last = Math.min(bars.length - 1, f + maxSessions);
  const done = (j: number, exit: number, reason: ExitReason): TradeExit => {
    const grossR = (dir * (exit - fill)) / risk;
    return { exitIndex: j, exit, reason, grossR, netR: grossR - costInR(fill, risk), holding: j - f };
  };
  for (let j = f; j <= last; j++) {
    const b = bars[j];
    if (j > f && b.open != null) {
      if (dir === 1 ? b.open <= stop : b.open >= stop) return done(j, b.open, "stop_gap");
      if (dir === 1 ? b.open >= target : b.open <= target) return done(j, target, "target");
    }
    const hitStop = dir === 1 ? b.low <= stop : b.high >= stop;
    const hitTarget = dir === 1 ? b.high >= target : b.low <= target;
    if (hitStop) return done(j, stop, stop === stop0 ? "stop" : "trail_stop");
    if (hitTarget) return done(j, target, "target");
    if (j === f + maxSessions) return done(j, b.close, "time");
    if (trailing) stop = trailStop(bars, closes, j, dir, stop, fudge);
  }
  return done(last, bars[last].close, "end_of_data");
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-trade seed from the fixed seed, the symbol and the trigger date, so controls don't depend on run order. */
export function controlSeed(symbol: string, date: string, base = CONTROL_SEED): number {
  let h = base | 0;
  for (const ch of `${symbol}|${date}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

export interface ControlResult {
  i: number;
  netR: number;
}

/**
 * Matched control for a filled trade: a random non-trigger session within ±CONTROL_WINDOW
 * of the trigger, same direction, entry high + fudge (low − fudge short) and the mirror
 * stop from that bar, then the same fill, exit and cost rules. Up to CONTROL_TRIES
 * sessions are tried until one fills; null if none does.
 */
export function matchedControl(
  setup: Setup,
  bars: readonly DailyBar[],
  closes: readonly number[],
  info: readonly BarInfo[],
  rule: ExitRule,
  seedBase = CONTROL_SEED,
): ControlResult | null {
  const pool: number[] = [];
  for (let c = setup.i - CONTROL_WINDOW; c <= setup.i + CONTROL_WINDOW; c++) {
    if (c === setup.i || c < 0 || c + 1 >= bars.length) continue;
    const trig = setup.variant === "rolling" ? info[c]?.triggerRolling : info[c]?.trigger;
    if (trig === 0 && info[c].fudge != null) pool.push(c);
  }
  const r = rng(controlSeed(setup.symbol, setup.date, seedBase));
  for (let k = 0; k < CONTROL_TRIES && pool.length > 0; k++) {
    const c = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const fudge = info[c].fudge!;
    const entry = setup.dir === 1 ? bars[c].high + fudge : bars[c].low - fudge;
    const stop = setup.dir === 1 ? bars[c].low - fudge : bars[c].high + fudge;
    const e = entryOnNextBar(bars[c + 1], setup.dir, entry, stop);
    if (e.status !== "filled") continue;
    const x = simulateExit(bars, closes, c + 1, setup.dir, e.fill, e.risk, stop, fudge, rule);
    return { i: c, netR: x.netR };
  }
  return null;
}

export type Alignment = "aligned" | "partial" | "against";

/** Step 1b: stp_htf_opens × direction: +1 aligned, −1 against, anything else (±0.5, 0) partial; null unknown. */
export function htfAlignment(htf: number | null, dir: Dir): Alignment | null {
  if (htf == null) return null;
  const a = htf * dir;
  return a >= 1 ? "aligned" : a <= -1 ? "against" : "partial";
}

export interface Trade {
  variant: Variant;
  alignment: Alignment | null;
  symbol: string;
  /** Trigger date: the time key for the split. */
  scanId: string;
  scanStart: Date;
  fillDate: string;
  exitDate: string;
  dir: Dir;
  type: string;
  firedRules: string[];
  entry: number;
  fill: number;
  stop: number;
  exit: number;
  risk: number;
  grossR: number;
  netR: number;
  reason: ExitReason;
  holding: number;
  controlNetR: number | null;
  /** SPY close vs its SMA20 on the trigger day. */
  regime: "spy_above_sma20" | "spy_below_sma20" | null;
  quarter: string;
}

export interface SymbolCounts {
  setups: number;
  filled: number;
  cancelled: number;
  skippedGap: number;
  skippedOverlap: number;
  noBar: number;
  noControl: number;
}

export const emptyCounts = (): SymbolCounts => ({ setups: 0, filled: 0, cancelled: 0, skippedGap: 0, skippedOverlap: 0, noBar: 0, noControl: 0 });

/** SPY above/below its SMA20 by date, from SPY's own bars. */
export function spyRegimeByDate(spy: readonly DailyBar[]): Map<string, Trade["regime"]> {
  const closes = spy.map((b) => b.close);
  const out = new Map<string, Trade["regime"]>();
  spy.forEach((b, i) => {
    const d = barDateOf(b);
    const s = sma(closes, 20, i);
    if (d) out.set(d, s == null ? null : b.close > s ? "spy_above_sma20" : "spy_below_sma20");
  });
  return out;
}

export const quarterOf = (date: string) => `${date.slice(0, 4)}Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;

/** All trades for one symbol under one exit rule, one position at a time. */
export function simulateSymbol(
  symbol: string,
  bars: readonly DailyBar[],
  rule: ExitRule,
  opts: { sessions?: ReadonlySet<string>; regime?: ReadonlyMap<string, Trade["regime"]>; scanned?: Scanned; variant?: Variant } = {},
): { trades: Trade[]; counts: SymbolCounts } {
  const scanned = opts.scanned ?? scanSymbol(symbol, bars, opts.sessions);
  const variant = opts.variant ?? "calendar";
  const setups = variant === "rolling" ? scanned.rollingSetups : scanned.setups;
  const info = scanned.info;
  const closes = bars.map((b) => b.close);
  const counts = emptyCounts();
  const trades: Trade[] = [];
  let openUntil = -1; // exit bar of the open trade; a trigger on the exit day itself is allowed
  for (const s of setups) {
    counts.setups++;
    if (s.i < openUntil) {
      counts.skippedOverlap++;
      continue;
    }
    const e = entryOnNextBar(bars[s.i + 1], s.dir, s.entry, s.stop);
    if (e.status === "cancelled") counts.cancelled++;
    else if (e.status === "skipped_gap") counts.skippedGap++;
    else if (e.status === "no_bar") counts.noBar++;
    if (e.status !== "filled") continue;
    counts.filled++;
    const x = simulateExit(bars, closes, s.i + 1, s.dir, e.fill, e.risk, s.stop, s.fudge, rule);
    openUntil = x.exitIndex;
    const control = matchedControl(s, bars, closes, info, rule);
    if (!control) counts.noControl++;
    trades.push({
      variant,
      alignment: htfAlignment(s.htf, s.dir),
      symbol,
      scanId: s.date,
      scanStart: new Date(`${s.date}T21:00:00Z`),
      fillDate: info[s.i + 1]?.date || barDateOf(bars[s.i + 1]) || "",
      exitDate: barDateOf(bars[x.exitIndex]) ?? "",
      dir: s.dir,
      type: s.type,
      firedRules: s.firedRules,
      entry: s.entry,
      fill: e.fill,
      stop: s.stop,
      exit: x.exit,
      risk: e.risk,
      grossR: x.grossR,
      netR: x.netR,
      reason: x.reason,
      holding: x.holding,
      controlNetR: control?.netR ?? null,
      regime: opts.regime?.get(s.date) ?? null,
      quarter: quarterOf(s.date),
    });
  }
  return { trades, counts };
}

// ── Metrics and verdicts ───────────────────────────────────────────────────────

export interface GroupMetrics {
  trades: number;
  winRate: number | null;
  avgR: number | null; // net
  medianR: number | null; // net
  avgGrossR: number | null;
  expectancy: number | null; // = avgR (net), the primary metric
  profitFactor: number | null;
  avgHolding: number | null;
  maxDrawdownR: number | null;
  controls: number;
  controlExpectancy: number | null;
  edge: number | null; // expectancy − controlExpectancy
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Max peak-to-trough of cumulative net R, trades in fill-date order (equal R each). */
export function maxDrawdownR(trades: readonly Pick<Trade, "fillDate" | "symbol" | "netR">[]): number | null {
  if (!trades.length) return null;
  const sorted = [...trades].sort((a, b) => a.fillDate.localeCompare(b.fillDate) || a.symbol.localeCompare(b.symbol));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of sorted) {
    cum += t.netR;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

export function groupMetrics(trades: readonly Trade[]): GroupMetrics {
  const net = trades.map((t) => t.netR);
  const wins = net.filter((r) => r > 0);
  const losses = net.filter((r) => r < 0);
  const ctrl = trades.map((t) => t.controlNetR).filter((v): v is number => v != null);
  const exp = mean(net);
  const cExp = mean(ctrl);
  const lossSum = -losses.reduce((s, v) => s + v, 0);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgR: exp,
    medianR: median(net),
    avgGrossR: mean(trades.map((t) => t.grossR)),
    expectancy: exp,
    profitFactor: lossSum > 0 ? wins.reduce((s, v) => s + v, 0) / lossSum : null,
    avgHolding: mean(trades.map((t) => t.holding)),
    maxDrawdownR: maxDrawdownR(trades),
    controls: ctrl.length,
    controlExpectancy: cExp,
    edge: exp != null && cExp != null ? exp - cExp : null,
  };
}

/** Net expectancy > 0 and above the matched control, with at least `min` trades. */
export function passes(m: GroupMetrics, min: number): boolean {
  return m.trades >= min && m.expectancy != null && m.expectancy > 0 && m.controlExpectancy != null && m.expectancy > m.controlExpectancy;
}

export type SimVerdict = "KEEP" | "DROP" | "INSUFFICIENT";

export interface GroupResult {
  group: string;
  primary: boolean;
  all: GroupMetrics;
  heldOut: GroupMetrics;
  folds: GroupMetrics[];
  foldsPassed: number;
  verdict: SimVerdict | null; // null for descriptive groups
  reason: string;
}

export const TRIGGER_TYPES = ["inside", "butn", "brutn", "mech1", "mech2", "egop"] as const;

/** The pre-registered primary groups: all, long, short, and each type × direction the rules allow. */
type GroupKey = Pick<Trade, "dir" | "type" | "variant">;
const cal = (t: GroupKey) => t.variant === "calendar";

/**
 * The pre-registered primary groups, 17 per exit: all, long, short and each type ×
 * direction on the calendar triggers (13), plus inside± and the U-turns with rolling
 * opens (4, step 1c).
 */
export const PRIMARY_GROUPS: ReadonlyArray<{ group: string; match: (t: GroupKey) => boolean }> = [
  { group: "all", match: cal },
  { group: "long", match: (t) => cal(t) && t.dir === 1 },
  { group: "short", match: (t) => cal(t) && t.dir === -1 },
  ...[
    ["inside", 1], ["inside", -1], ["butn", 1], ["brutn", -1], ["mech1", 1], ["mech1", -1], ["mech2", 1], ["mech2", -1], ["egop", 1], ["egop", -1],
  ].map(([type, dir]) => ({ group: `${type}${dir === 1 ? "+" : "-"}`, match: (t: GroupKey) => cal(t) && t.type === type && t.dir === dir })),
  ...[["inside", 1], ["inside", -1], ["butn", 1], ["brutn", -1]].map(([type, dir]) => ({
    group: `rolling:${type}${dir === 1 ? "+" : "-"}`,
    match: (t: GroupKey) => t.variant === "rolling" && t.type === type && t.dir === dir,
  })),
];

/**
 * Split once over every trade (newest 30% of trigger dates held out; 3 expanding folds
 * by trigger date) and apply the same date cut to each group, so groups share one split.
 */
export function evaluateGroups(trades: readonly Trade[]): GroupResult[] {
  const { test } = timeSplit(trades);
  const heldIds = new Set(test.map((t) => t.scanId));
  const foldIds = walkForwardFolds(trades).map((f) => new Set(f.test.map((t) => t.scanId)));
  const judge = (group: string, sel: Trade[], primary: boolean): GroupResult => {
    const heldOut = groupMetrics(sel.filter((t) => heldIds.has(t.scanId)));
    const folds = foldIds.map((ids) => groupMetrics(sel.filter((t) => ids.has(t.scanId))));
    const foldsPassed = folds.filter((f) => passes(f, MIN_FOLD_ROWS)).length;
    let verdict: SimVerdict | null = null;
    let reason = "descriptive only";
    if (primary) {
      if (heldOut.trades < MIN_HELDOUT_ROWS) {
        verdict = "INSUFFICIENT";
        reason = `${heldOut.trades} held-out trades (need ${MIN_HELDOUT_ROWS})`;
      } else if (!passes(heldOut, MIN_HELDOUT_ROWS)) {
        verdict = "DROP";
        reason = "held-out net expectancy not > 0 and above its matched control";
      } else if (foldsPassed < FOLDS_REQUIRED) {
        verdict = "DROP";
        reason = `passes held out but only ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds (need ${FOLDS_REQUIRED})`;
      } else {
        verdict = "KEEP";
        reason = `passes held out and ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds`;
      }
    }
    return { group, primary, all: groupMetrics(sel), heldOut, folds, foldsPassed, verdict, reason };
  };
  const out: GroupResult[] = PRIMARY_GROUPS.map((g) => judge(g.group, trades.filter(g.match), true));
  const calendar = trades.filter((t) => t.variant === "calendar");
  for (const type of TRIGGER_TYPES) out.push(judge(`type:${type}`, calendar.filter((t) => t.type === type), false));
  // Step 1b: do the weekly/monthly opens add anything on top of the MA- and catalyst-based patterns?
  for (const type of ["mech1", "mech2", "egop"] as const)
    for (const a of ["aligned", "partial", "against"] as const)
      out.push(judge(`htf:${type}:${a}`, calendar.filter((t) => t.type === type && t.alignment === a), false));
  for (const r of ["spy_above_sma20", "spy_below_sma20"] as const) out.push(judge(`regime:${r}`, calendar.filter((t) => t.regime === r), false));
  for (const q of [...new Set(calendar.map((t) => t.quarter))].sort()) out.push(judge(`quarter:${q}`, calendar.filter((t) => t.quarter === q), false));
  return out;
}
