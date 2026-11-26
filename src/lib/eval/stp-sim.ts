/**
 * P3-0i: STP trigger trade simulation (pure), docs/PHASE3-PREP.md, under the rules
 * fixed in docs/PHASE3-PREREG.md "STP trigger trades (P3-0i)". LOG ONLY.
 *
 * Setups come from computeStp on each day's live-window slice (same slicing as the
 * P3-0g backfill: bars dated ≤ D, after D minus 3 months). Every trade decision on
 * day D+1 or later reads only that day's own bar and earlier ones.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sma, weekStart, wilderAtr } from "@/lib/harvester/universe/bar-features";
import { computeStp, htfOpensAt } from "@/lib/harvester/universe/stp";
import { barDateOf, windowStart } from "@/lib/harvester/universe/backfill";
import { computeStpRolling, ROLLING_WINDOWS, type RollingWindows } from "@/lib/harvester/universe/stp-rolling";
import { SWING_KS, swingEntry, zigzag, type Pivot } from "@/lib/harvester/universe/swings";
import { pyramidLayers, type LayerState, type PyramidInputs } from "@/lib/harvester/universe/pyramid";
import { BACKFILL_SCREEN_TESTS, passingScreens, screensOn, type ScreenId } from "@/lib/harvester/universe/finviz-screens";
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

export type ExitRule = "A" | "B" | "C";
/**
 * §1e (Chris, 2026-11-25): exit B, the STP management, is PRIMARY and gets the verdicts;
 * exit A (fixed 3R target, 10 sessions) is a reference with no verdicts.
 */
export const EXIT_RULES: Record<ExitRule, { targetR: number; maxSessions: number }> = {
  A: { targetR: 3, maxSessions: 10 },
  B: { targetR: 3, maxSessions: 60 },
  C: { targetR: 2, maxSessions: 60 },
};

/**
 * §1j (Chris's Pine): STP management parameters. B, the primary: adds every 2 × ATR14(D),
 * trail once 3R is touched. C, the descriptive "choppy" variant (Pine atrFactor = 1 when
 * RR = 2): adds every 1 × ATR14(D), trail once 2R is touched. No verdicts on C.
 */
export const MANAGEMENT: Record<"B" | "C", { addAtr: number; trailAfterR: number }> = {
  B: { addAtr: 2, trailAfterR: 3 },
  C: { addAtr: 1, trailAfterR: 2 },
};
export const PRIMARY_EXIT: ExitRule = "B";

export type Dir = 1 | -1;

/** Which trend definition produced the setup: calendar weekly/monthly opens (computeStp) or rolling opens (step 1c). */
export type Variant = "calendar" | "rolling";

export interface Setup {
  variant: Variant;
  /** stp_htf_opens on the trigger bar (calendar opens), for the step 1b alignment split and the §1j stock factor. */
  htf: number | null;
  /** stp_ma_state on the trigger bar: +1 close > sma20, close > sma50, sma20 > sma50; −1 mirrored; 0 otherwise. */
  maState?: number | null;
  /** The live Pine `shareSizeFactor` with its abs(): 1 when |htf| = 1 and maState ≠ 0, else 0.5. */
  sizeFactorAbs?: number | null;
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
 * P3-0i3: `earningsSessions` (EDGAR 8-K 2.02, the session whose open first reflects the
 * release) lets EGOP fire: on such a bar computeStp gets that bar's own time as earningsTs,
 * which isFirstBarAfterEarnings reads as "released after the prior bar, by this open".
 */
export function scanSymbol(
  symbol: string,
  bars: readonly DailyBar[],
  sessions?: ReadonlySet<string>,
  windows: RollingWindows = ROLLING_WINDOWS.stock,
  earningsSessions?: ReadonlySet<string>,
): Scanned {
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
    const s = computeStp(slice, earningsSessions?.has(d) ? bars[i].time ?? null : null);
    const r = computeStpRolling(slice, windows);
    info.push({ date: d, trigger: s.trigger, triggerRolling: r.trigger, fudge: s.fudge });
    if ((s.trigger === 1 || s.trigger === -1) && s.entry != null && s.stop != null && s.fudge != null && s.triggerType) {
      setups.push({ variant: "calendar", htf: s.htfOpens, maState: s.maState, sizeFactorAbs: s.sizeFactor, symbol, date: d, i, dir: s.trigger, type: s.triggerType, firedRules: s.firedRules, entry: s.entry, stop: s.stop, fudge: s.fudge });
    }
    if ((r.trigger === 1 || r.trigger === -1) && r.entry != null && r.stop != null && r.fudge != null && r.triggerType) {
      rollingSetups.push({ variant: "rolling", htf: s.htfOpens, maState: s.maState, sizeFactorAbs: s.sizeFactor, symbol, date: d, i, dir: r.trigger, type: r.triggerType, firedRules: r.firedRules, entry: r.entry, stop: r.stop, fudge: r.fudge });
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
  | { status: "gap_skip" }
  | { status: "skipped_gap" }
  | { status: "no_bar" };

/**
 * §1e: the D+1 entry is a stop-limit day order. Long fills at `entry` only if D+1 opens at
 * or below the entry and trades up through it; an open above the entry is no fill
 * (`gap_skip`). An open at or past the stop skips the setup (§2). Short mirrored. Reads
 * only bar D+1.
 */
export function entryOnNextBar(next: DailyBar | undefined, dir: Dir, entry: number, stop: number): EntryOutcome {
  if (!next) return { status: "no_bar" };
  const open = next.open ?? null;
  const risk = dir === 1 ? entry - stop : stop - entry;
  if (dir === 1) {
    if (open != null && open > entry) return { status: "gap_skip" };
    if (next.high < entry) return { status: "cancelled" };
    if (open != null && open <= stop) return { status: "skipped_gap" };
  } else {
    if (open != null && open < entry) return { status: "gap_skip" };
    if (next.low > entry) return { status: "cancelled" };
    if (open != null && open >= stop) return { status: "skipped_gap" };
  }
  return risk > 0 ? { status: "filled", fill: entry, risk } : { status: "skipped_gap" };
}

const crossesBelow = (p: number | null, pl: number | null, c: number | null, cl: number | null) => p != null && pl != null && c != null && cl != null && p >= pl && c < cl;
const crossesAbove = (p: number | null, pl: number | null, c: number | null, cl: number | null) => p != null && pl != null && c != null && cl != null && p <= pl && c > cl;

/** STP fudge on a bar: max(0.11 × ATR14, 0.02), as computeStp; null without an ATR. */
export const barFudge = (atr: number | null | undefined) => (atr == null ? null : Math.max(0.11 * atr, 0.02));

/** Mechanical trades trail with mX only (§1e). */
export const isMechanical = (type: string) => type === "mech1" || type === "mech2";

/** Wilder ATR14 ending at each bar (null before 15 bars), over the symbol's whole history. */
export function atrSeries(bars: readonly DailyBar[]): Array<number | null> {
  const s = wilderAtr(bars); // element k ends at bar k + 14
  return bars.map((_, i) => (i >= 14 ? s[i - 14] ?? null : null));
}

/**
 * Exit B trailing candidate after bar t closes (§1e), applied from bar t+1; the caller
 * keeps the tighter of it and the current stop. Long:
 * - mech1/mech2: mX only. Close crosses below sma20, or sma10 crosses below sma20 → low[t] − fudge.
 * - others: if close − sma10 > 1 × ATR14 → low[t] − fudge (bar stop); otherwise pmX:
 *   trendDirection[t−1] ≥ 1 and close crosses below sma10 → low[t] − fudge.
 * Short mirrored. `fudge` is bar t's (max(0.11 × ATR14[t], 0.02), as Pine computes it per
 * bar); the trigger bar's fudge is only a fallback before ATR exists. Null when no rule
 * fires. Uses bars ≤ t only.
 */
export function trailCandidate(
  bars: readonly DailyBar[],
  closes: readonly number[],
  atr: ReadonlyArray<number | null>,
  t: number,
  dir: Dir,
  fallbackFudge: number,
  mechanical: boolean,
): number | null {
  if (t < 1) return null;
  // Pine's fudgeFactor is a series: max(0.11 × ATR14, 0.02) on the current bar (stp.pine:231, mechSL :724).
  const fudge = barFudge(atr[t]) ?? fallbackFudge;
  const s10 = sma(closes, 10, t);
  const s20 = sma(closes, 20, t);
  const s10p = sma(closes, 10, t - 1);
  const s20p = sma(closes, 20, t - 1);
  const c = closes[t];
  const cp = closes[t - 1];
  const level = dir === 1 ? bars[t].low - fudge : bars[t].high + fudge;
  const below = dir === 1 ? crossesBelow : crossesAbove;
  if (mechanical) return below(cp, s20p, c, s20) || below(s10p, s20p, s10, s20) ? level : null;
  const a = atr[t];
  if (s10 != null && a != null && dir * (c - s10) > a) return level; // extended: bar stop
  const tdPrev = htfOpensAt(bars, t - 1);
  if (tdPrev != null && dir * tdPrev >= 1 && below(cp, s10p, c, s10)) return level; // pmX
  return null;
}

export type ExitReason = "stop" | "stop_gap" | "trail_stop" | "be_stop" | "target" | "time" | "time_cap" | "end_of_data" | "event_stop" | "earnings_stop" | "earnings";

/** P3-0j event stop tiers, set at the close of the session before a macro event. */
export type EventTier = "event_bar" | "event_be" | "event_hold";

/**
 * P3-0j extra exit rules (off by default, so P3-0i is unchanged):
 * - `eventBefore`: bar indices whose close is the last close before a macro event. Open
 *   profit there (close − fill, long) ≥ 2R → bar stop (that bar's low − fudge); ≥ 1 ATR14 →
 *   breakeven (size-weighted cost); otherwise hold. Live from the next bar; never loosens.
 * - `earningsAt`: bar index of the next earnings session E. The bar stop applies on E−2 and
 *   E−1 (set at the closes of E−3 and E−2) when tighter; any position is sold at the close
 *   of E−1 (`earnings`).
 */
export interface ExitExtras {
  eventBefore?: ReadonlySet<number>;
  earningsAt?: number | null;
}

export interface TradeExit {
  exitIndex: number;
  exit: number;
  reason: ExitReason;
  /** Dollar P&L over the initial base risk (§1h): all units. */
  grossR: number;
  netR: number;
  /** The initial shares alone, net of their two legs' costs, over the base risk. */
  initialUnitR: number;
  holding: number;
  adds: number;
  /** Fill prices of the adds, in order. */
  addPrices: number[];
  addGapSkips: number;
  /** P3-0i4: the position reached MAX_ADDS adds, so no further add was placed. */
  addCapReached: boolean;
  /** P3-0j: the event-stop tier applied at each macro event during the trade, in order. */
  eventTiers?: EventTier[];
  reached3R: boolean;
  /** Shares at the exit over the initial shares (1, 1.5, 2.2, …). */
  size: number;
  shares: number;
  sharesAtExit: number;
  dollarGross: number;
  dollarNet: number;
}

export const costInR = (fill: number, risk: number) => (COST_ROUND_TRIP * fill) / risk;
/** §1e: costs are 0.10% of traded value per leg (entry, each add, exit). */
export const COST_PER_LEG = COST_ROUND_TRIP;
export const ADD_FRACTION = 0.5;
/** P3-0i4 (Chris, 2026-11-25): Exits B and C stop adding after the 3rd add (largest position 1.5³ = 3.375 units). Set after the first run's blow-up, not tuned on results. */
export const MAX_ADDS = 3;
export const TRAIL_AFTER_R = 3;
export const EXIT_B_CAP = 60;
/** §1j: every position risks $200 × size (was $100 in §1h). No max-trade-size cap. */
export const BASE_RISK_DOLLARS = 200;
/** §1j: Chris never enters at less than 1/4 size. */
export const MIN_SIZE = 0.25;

/** §1h: floor(base risk / per-share risk); 0 means no trade (size_skip). */
export const initialShares = (baseRisk: number, risk: number) => (risk > 0 ? Math.floor(baseRisk / risk + 1e-9) : 0);

function finish(
  legs: ReadonlyArray<{ qty: number; price: number }>,
  dir: Dir,
  exit: number,
  baseRisk: number,
  base: Omit<TradeExit, "grossR" | "netR" | "initialUnitR" | "size" | "shares" | "sharesAtExit" | "dollarGross" | "dollarNet" | "exit" | "addPrices">,
): TradeExit {
  const shares = legs[0].qty;
  const sharesAtExit = legs.reduce((sum, l) => sum + l.qty, 0);
  const dollarGross = legs.reduce((sum, l) => sum + l.qty * dir * (exit - l.price), 0);
  const costs = COST_PER_LEG * (legs.reduce((sum, l) => sum + l.qty * l.price, 0) + sharesAtExit * exit);
  const dollarNet = dollarGross - costs;
  const fill = legs[0].price;
  const initialUnitR = (shares * dir * (exit - fill) - COST_PER_LEG * shares * (fill + exit)) / baseRisk;
  return { ...base, addPrices: legs.slice(1).map((l) => l.price), exit, grossR: dollarGross / baseRisk, netR: dollarNet / baseRisk, initialUnitR, size: sharesAtExit / shares, shares, sharesAtExit, dollarGross, dollarNet };
}

/**
 * Exit A (reference, no verdicts): stop, 3R target as a limit order (a gap through it
 * exits at the open), time exit at the close of session f + 10. A gap through the stop
 * exits at the open; a bar touching both exits at the stop, fill bar included.
 * Sized by §1h: floor(baseRisk / risk) shares, no adds.
 */
export function simulateExitA(bars: readonly DailyBar[], f: number, dir: Dir, fill: number, risk: number, stop: number, baseRisk = BASE_RISK_DOLLARS): TradeExit {
  const { targetR, maxSessions } = EXIT_RULES.A;
  const target = fill + dir * targetR * risk;
  const last = Math.min(bars.length - 1, f + maxSessions);
  const legs = [{ qty: initialShares(baseRisk, risk), price: fill }];
  const done = (j: number, exit: number, reason: ExitReason) =>
    finish(legs, dir, exit, baseRisk, { exitIndex: j, reason, holding: j - f, adds: 0, addGapSkips: 0, addCapReached: false, reached3R: dir * (exit - fill) >= 3 * risk });
  for (let j = f; j <= last; j++) {
    const b = bars[j];
    if (j > f && b.open != null) {
      if (dir === 1 ? b.open <= stop : b.open >= stop) return done(j, b.open, "stop_gap");
      if (dir === 1 ? b.open >= target : b.open <= target) return done(j, b.open, "target");
    }
    if (dir === 1 ? b.low <= stop : b.high >= stop) return done(j, stop, "stop");
    if (dir === 1 ? b.high >= target : b.low <= target) return done(j, target, "target");
    if (j === f + maxSessions) return done(j, b.close, "time");
  }
  return done(last, bars[last].close, "end_of_data");
}

/**
 * Exit B, STP management (§1e, primary), sized by §1h/§1j. Starts with
 * floor(baseRisk / risk) shares at `fill` and the initial stop. Per bar, in order: a gap
 * through the stop exits at the open; a bar touching the stop exits at the stop (before
 * any add on that bar); adds at fill ± n × addStep (§1j: 2 × ATR14 at the trigger bar),
 * never on the entry day, as stop-limit orders, each
 * floor(50% of current shares) (0 → no add); an add level opened through is skipped and
 * the next level stays live; after MAX_ADDS (3) fills, no more adds. After an add, the stop moves to the size-weighted breakeven
 * when that's tighter, from the next bar. Once a high (low, short) reaches fill ± 3R, each
 * completed bar can tighten the stop with trailCandidate, from the next bar; the stop
 * never loosens. No target; a 60-session cap exits at that close. R = dollar P&L over the
 * base risk.
 */
export function simulateExitB(
  bars: readonly DailyBar[],
  closes: readonly number[],
  atr: ReadonlyArray<number | null>,
  f: number,
  dir: Dir,
  fill: number,
  risk: number,
  stop0: number,
  fudge: number,
  type: string,
  baseRisk: number,
  /** §1j: distance between add levels, in price (2 × ATR14 at the trigger bar for B, 1 × for C). */
  addStep: number,
  trailAfterR = TRAIL_AFTER_R,
  extra?: ExitExtras,
): TradeExit {
  const legs: Array<{ qty: number; price: number }> = [{ qty: initialShares(baseRisk, risk), price: fill }];
  const size = () => legs.reduce((s, l) => s + l.qty, 0);
  const avgCost = () => legs.reduce((s, l) => s + l.qty * l.price, 0) / size();
  const tighter = (a: number, b: number) => (dir === 1 ? Math.max(a, b) : Math.min(a, b));
  let stop = stop0;
  let movedToBE = false;
  let trailed = false;
  let nextAdd = 1; // the next add level is fill ± nextAdd × 2R
  let addGapSkips = 0;
  let reached3R = false;
  const threeR = fill + dir * trailAfterR * risk; // the trail starts once this is touched (3R; 2R in the choppy variant)
  const last = Math.min(bars.length - 1, f + EXIT_B_CAP);
  const mech = isMechanical(type);

  const eventTiers: EventTier[] = [];
  /** P3-0j: the rule that last set the stop, when it was an event or earnings rule. */
  let setBy: "event_stop" | "earnings_stop" | null = null;
  const done = (j: number, exit: number, reason: ExitReason) =>
    finish(legs, dir, exit, baseRisk, {
      exitIndex: j, reason, holding: j - f, adds: legs.length - 1, addGapSkips, addCapReached: legs.length - 1 >= MAX_ADDS, reached3R,
      ...(extra ? { eventTiers } : {}),
    });
  const stopReason = (): ExitReason => setBy ?? (trailed ? "trail_stop" : movedToBE ? "be_stop" : "stop");
  const tighten = (c: number | null, by: "event_stop" | "earnings_stop") => {
    if (c != null && tighter(stop, c) === c && c !== stop) {
      stop = c;
      setBy = by;
    }
  };

  for (let j = f; j <= last; j++) {
    const b = bars[j];
    if (j > f && b.open != null && (dir === 1 ? b.open <= stop : b.open >= stop)) return done(j, b.open, "stop_gap");
    if (dir === 1 ? b.low <= stop : b.high >= stop) return done(j, stop, stopReason());
    // Adds: stop-limit orders at successive 2R levels; a level the bar opened through is skipped.
    // Never on the entry day (Chris, §1e): from f+1 on, a level the fill bar already passed follows the gap rule.
    let pendingStop: number | null = null;
    for (; j > f && legs.length - 1 < MAX_ADDS; ) {
      const level = fill + dir * nextAdd * addStep;
      if (b.open != null && (dir === 1 ? b.open > level : b.open < level)) {
        addGapSkips++;
        nextAdd++;
        continue;
      }
      if (dir === 1 ? b.high < level : b.low > level) break;
      nextAdd++;
      const qty = Math.floor(size() * ADD_FRACTION);
      if (qty < 1) continue; // §1h: an add rounding to 0 is no add
      legs.push({ qty, price: level });
      const be = avgCost();
      if (tighter(stop, be) === be && be !== stop) pendingStop = be;
    }
    if (dir === 1 ? b.high >= threeR : b.low <= threeR) reached3R = true;
    // P3-0j: never hold through earnings: sold at the close of E−1
    if (extra?.earningsAt != null && j === extra.earningsAt - 1) return done(j, b.close, "earnings");
    if (j === f + EXIT_B_CAP) return done(j, b.close, "time_cap");
    // From the next bar: breakeven after adds, then the trail once 3R has been touched.
    if (pendingStop != null && tighter(stop, pendingStop) === pendingStop && pendingStop !== stop) {
      stop = pendingStop;
      movedToBE = true;
      setBy = null;
    }
    if (reached3R) {
      const c = trailCandidate(bars, closes, atr, j, dir, fudge, mech);
      if (c != null && tighter(stop, c) === c && c !== stop) {
        stop = c;
        trailed = true;
        setBy = null;
      }
    }
    if (extra) {
      const barStop = dir === 1 ? b.low - (barFudge(atr[j]) ?? fudge) : b.high + (barFudge(atr[j]) ?? fudge);
      if (extra.eventBefore?.has(j)) {
        const profit = dir * (b.close - fill);
        const a = atr[j];
        if (profit >= 2 * risk) {
          eventTiers.push("event_bar");
          tighten(barStop, "event_stop");
        } else if (a != null && profit >= a) {
          eventTiers.push("event_be");
          tighten(avgCost(), "event_stop");
        } else eventTiers.push("event_hold");
      }
      const E = extra.earningsAt;
      if (E != null && j >= E - 3 && j < E - 1) tighten(barStop, "earnings_stop");
    }
  }
  return done(last, bars[last].close, "end_of_data");
}

/** Simulate one filled entry under an exit rule. */
export function simulateExit(
  bars: readonly DailyBar[],
  closes: readonly number[],
  atr: ReadonlyArray<number | null>,
  f: number,
  dir: Dir,
  fill: number,
  risk: number,
  stop: number,
  fudge: number,
  type: string,
  rule: ExitRule,
  baseRisk = BASE_RISK_DOLLARS,
  extra?: ExitExtras,
): TradeExit {
  if (rule === "A") return simulateExitA(bars, f, dir, fill, risk, stop, baseRisk);
  // §1j: add spacing from ATR14 on the trigger bar (f − 1); computeStp needs 51 bars, so it exists at a trigger.
  const m = MANAGEMENT[rule];
  const atrD = atr[f - 1] ?? atr[f] ?? risk;
  return simulateExitB(bars, closes, atr, f, dir, fill, risk, stop, fudge, type, baseRisk, m.addAtr * atrD, m.trailAfterR, extra);
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

/** P3-0k2 descriptive: an exit at the initial stop (stop or stop_gap) within this many sessions, counting the fill day as session 1. */
export const STOPPED_EARLY_SESSIONS = 3;
export const stoppedEarly = (t: { reason: ExitReason; holding: number }) => (t.reason === "stop" || t.reason === "stop_gap") && t.holding < STOPPED_EARLY_SESSIONS;

/** P3-0j3: verdict controls come from after the trigger; the ±20 window is kept as a descriptive control. */
export type ControlMode = "after" | "window";

/**
 * The sessions a matched control may be drawn from.
 * - "after" (verdicts): only sessions after the trigger (c > i, up to i + 20). P3-0j2 did
 *   this for EGOP (a control before the gap could hold through it); P3-0j3 extends it to every
 *   pattern, since a day before a trigger is chosen knowing the trigger follows (inside bars:
 *   +0.38R before vs −1.08R after in the first funnel run).
 * - "window" (descriptive): ±CONTROL_WINDOW around the trigger, every pattern.
 */
export function controlPoolRange(i: number, type: string, n: number, mode: ControlMode = "after"): { lo: number; hi: number } {
  void type;
  return { lo: Math.max(0, mode === "after" ? i + 1 : i - CONTROL_WINDOW), hi: Math.min(n - 2, i + CONTROL_WINDOW) };
}

/**
 * Matched control for a filled trade: a random non-trigger session within ±CONTROL_WINDOW
 * of the trigger (EGOP: only after the gap day, see controlPoolRange), same direction, entry high + fudge (low − fudge short) and the mirror
 * stop from that bar, then the same entry, management (the trade's type decides mX vs
 * pmX), base risk (the trade's size_mult) and cost rules. Up to CONTROL_TRIES sessions are tried until one fills; null if
 * none does.
 */
export function matchedControl(
  setup: Setup,
  bars: readonly DailyBar[],
  closes: readonly number[],
  info: readonly BarInfo[],
  rule: ExitRule,
  seedBase = CONTROL_SEED,
  atr: ReadonlyArray<number | null> = atrSeries(bars),
  baseRisk = BASE_RISK_DOLLARS,
  mode: ControlMode = "after",
): ControlResult | null {
  const pool: number[] = [];
  const range = controlPoolRange(setup.i, setup.type, bars.length, mode);
  for (let c = range.lo; c <= range.hi; c++) {
    if (c === setup.i) continue;
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
    if (e.status !== "filled" || initialShares(baseRisk, e.risk) < 1) continue;
    const x = simulateExit(bars, closes, atr, c + 1, setup.dir, e.fill, e.risk, stop, fudge, setup.type, rule, baseRisk);
    return { i: c, netR: x.netR };
  }
  return null;
}

// ── Entry location vs the normal move (§1d) ─────────────────────────────────────

/** Completed calendar weeks / months averaged for the normal move W / M. */
export const NORMAL_WEEKS = 10;
export const NORMAL_MONTHS = 6;
/** Pre-registered entry-location rule: both under this share of the normal move. */
export const EARLY_ENTRY_MAX = 0.5;

export interface EntryLocation {
  weekUsed: number | null;
  monthUsed: number | null;
  /** W × (1 − week_used) / (3R distance); ≥ 1 means a normal week still has room for 3R. */
  roomW: number | null;
}

/**
 * Entry location of a fill on bar i+1 for a trigger on bar i. W is the mean high−low range
 * of the NORMAL_WEEKS calendar weeks completed before the fill's week; M likewise over
 * NORMAL_MONTHS months. Long: week_used = (fill − lowest low since the week's open) / W,
 * the lowest low taken over bars of the fill's week dated ≤ D plus the fill itself; short
 * mirrored with the highest high. Uses bars ≤ i and the fill price only.
 */
export function entryLocation(bars: readonly DailyBar[], i: number, fill: number, dir: Dir, risk: number, targetR = 3): EntryLocation {
  const dates = (k: number) => barDateOf(bars[k]);
  const fillDate = dates(i + 1);
  if (!fillDate) return { weekUsed: null, monthUsed: null, roomW: null };
  const period = (kind: "week" | "month") => {
    const key = (d: string) => (kind === "week" ? weekStart(d) : d.slice(0, 7));
    const need = kind === "week" ? NORMAL_WEEKS : NORMAL_MONTHS;
    const cur = key(fillDate);
    const ranges = new Map<string, { hi: number; lo: number }>();
    let extreme = fill; // lowest low (long) / highest high (short) since the period's open
    let complete = false; // an older period exists, so the oldest one used isn't cut off by the data start
    for (let k = i; k >= 0; k--) {
      const d = dates(k);
      if (!d) continue;
      const kk = key(d);
      if (kk === cur) {
        extreme = dir === 1 ? Math.min(extreme, bars[k].low) : Math.max(extreme, bars[k].high);
        continue;
      }
      if (!ranges.has(kk)) {
        if (ranges.size === need) {
          complete = true;
          break;
        }
        ranges.set(kk, { hi: -Infinity, lo: Infinity });
      }
      const r = ranges.get(kk)!;
      r.hi = Math.max(r.hi, bars[k].high);
      r.lo = Math.min(r.lo, bars[k].low);
    }
    if (!complete) return null;
    const normal = [...ranges.values()].reduce((sum, r) => sum + (r.hi - r.lo), 0) / need;
    if (!(normal > 0)) return null;
    return { used: (dir === 1 ? fill - extreme : extreme - fill) / normal, normal };
  };
  const w = period("week");
  const m = period("month");
  return {
    weekUsed: w?.used ?? null,
    monthUsed: m?.used ?? null,
    roomW: w ? (w.normal * (1 - w.used)) / (targetR * risk) : null,
  };
}

/**
 * §1j stock factor (Pine `shareSizeFactor` with its abs() fixed): 1 only when the trigger
 * bar's stp_htf_opens is +1 in the trade's direction AND the MAs are stacked that way
 * (stp_ma_state = direction); otherwise 0.5. Shorts mirrored.
 */
export function stockFactor(htf: number | null | undefined, maState: number | null | undefined, dir: Dir): 1 | 0.5 {
  return htf != null && maState != null && htf * dir >= 1 && maState * dir >= 1 ? 1 : 0.5;
}

/** §1j size = stock factor × pyramid factor, floored at 0.25. */
export const combinedSize = (stock: number, pyramid: number) => Math.max(MIN_SIZE, stock * pyramid);

export type Alignment = "aligned" | "partial" | "against";

/** Step 1b: stp_htf_opens × direction: +1 aligned, −1 against, anything else (±0.5, 0) partial; null unknown. */
export function htfAlignment(htf: number | null, dir: Dir): Alignment | null {
  if (htf == null) return null;
  const a = htf * dir;
  return a >= 1 ? "aligned" : a <= -1 ? "against" : "partial";
}

export interface SwingScores {
  rallyUsed: number | null;
  rallyAge: number | null;
  room3R: number | null;
  pullbackRatio: number | null;
}

export interface Trade extends EntryLocation {
  variant: Variant;
  /** §1f: swing-structure entry scores per zigzag threshold k ("1.5", "2", "3"). */
  swing: Record<string, SwingScores>;
  /** §1g Power Pyramid layers and size multipliers. */
  layerMarket: LayerState | null;
  layerSector: LayerState | null;
  layerIndustry: LayerState | null;
  sizeMult: number;
  sizeMultIndustry: number;
  sizeMultOpens: number;
  sizeMultTrend: number;
  /** §1i Finviz screens on the trigger day: the base filter, and the screens that passed. */
  finvizBase: boolean | null;
  finvizScreens: ScreenId[];
  /** §1j sizing: stock factor, stock × pyramid floored at 0.25, whether the floor bit, and whether the old abs() rule would have said full size. */
  stockFactor: number;
  sizeCombined: number;
  floorHit: boolean;
  absFullFixedHalf: boolean;
  /** §1h/§1j dollar sizing: $200 × sizeCombined. */
  baseRisk: number;
  shares: number;
  sharesAtExit: number;
  dollarGross: number;
  dollarNet: number;
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
  /** Exit B: adds filled, add levels skipped because a bar opened through them, 3R touched, size at exit. */
  adds: number;
  addGapSkips: number;
  /** P3-0i4: MAX_ADDS adds filled, so no further add was placed. */
  addCapReached: boolean;
  reached3R: boolean;
  size: number;
  initialUnitR: number;
  controlNetR: number | null;
  /** P3-0j2: the control's day is after the trigger; null without a control. */
  controlPost?: boolean | null;
  /** P3-0j3 descriptive: the ±20-session control (the pre-P3-0j3 definition) and whether its day was after the trigger. */
  controlWindowNetR?: number | null;
  controlWindowPost?: boolean | null;
  /** SPY close vs its SMA20 on the trigger day. */
  regime: "spy_above_sma20" | "spy_below_sma20" | null;
  quarter: string;
}

export interface SymbolCounts {
  setups: number;
  filled: number;
  cancelled: number;
  /** §1e: D+1 opened through the entry, so the stop-limit didn't fill. */
  gapSkip: number;
  skippedGap: number;
  skippedOverlap: number;
  noBar: number;
  noControl: number;
  /** §1h: 0 shares at $100 × size_mult. */
  sizeSkip: number;
  /** §1g: trades with a market or sector layer that had no data (treated as mixed). */
  layerNull: number;
}

export const emptyCounts = (): SymbolCounts => ({
  setups: 0, filled: 0, cancelled: 0, gapSkip: 0, skippedGap: 0, skippedOverlap: 0, noBar: 0, noControl: 0, sizeSkip: 0, layerNull: 0,
});

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
  opts: {
    sessions?: ReadonlySet<string>;
    regime?: ReadonlyMap<string, Trade["regime"]>;
    scanned?: Scanned;
    variant?: Variant;
    /** §1g ETF states for this symbol's market, sector and industry layers; null → every layer mixed. */
    pyramid?: PyramidInputs | null;
    /** §1f zigzag pivots per k, computed once per symbol. */
    pivots?: Record<string, Pivot[]>;
  } = {},
): { trades: Trade[]; counts: SymbolCounts; sizeSkipByType: Record<string, number> } {
  const scanned = opts.scanned ?? scanSymbol(symbol, bars, opts.sessions);
  const variant = opts.variant ?? "calendar";
  const setups = variant === "rolling" ? scanned.rollingSetups : scanned.setups;
  const info = scanned.info;
  const closes = bars.map((b) => b.close);
  const atr = atrSeries(bars);
  const counts = emptyCounts();
  const sizeSkipByType: Record<string, number> = {};
  const pivots = opts.pivots ?? Object.fromEntries(SWING_KS.map((k) => [String(k), zigzag(bars, k)]));
  const noPyramid: PyramidInputs = { market: [null, null, null], sector: null, industry: null };
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
    else if (e.status === "gap_skip") counts.gapSkip++;
    else if (e.status === "skipped_gap") counts.skippedGap++;
    else if (e.status === "no_bar") counts.noBar++;
    if (e.status !== "filled") continue;
    // §1g size from the layers above the stock, §1h shares at $100 × size_mult
    const layers = pyramidLayers(opts.pyramid ?? noPyramid, s.date, s.dir);
    const stock = stockFactor(s.htf, s.maState, s.dir);
    const size = combinedSize(stock, layers.sizeMult);
    const baseRisk = BASE_RISK_DOLLARS * size;
    if (initialShares(baseRisk, e.risk) < 1) {
      counts.sizeSkip++;
      sizeSkipByType[s.type] = (sizeSkipByType[s.type] ?? 0) + 1;
      continue;
    }
    if (layers.market == null || layers.sector == null) counts.layerNull++;
    counts.filled++;
    const x = simulateExit(bars, closes, atr, s.i + 1, s.dir, e.fill, e.risk, s.stop, s.fudge, s.type, rule, baseRisk);
    openUntil = x.exitIndex;
    const control = matchedControl(s, bars, closes, info, rule, CONTROL_SEED, atr, baseRisk);
    const controlW = matchedControl(s, bars, closes, info, rule, CONTROL_SEED, atr, baseRisk, "window");
    if (!control) counts.noControl++;
    const screen = screensOn(bars, s.i, atr);
    trades.push({
      stockFactor: stock,
      sizeCombined: size,
      floorHit: stock * layers.sizeMult < MIN_SIZE,
      absFullFixedHalf: s.sizeFactorAbs === 1 && stock === 0.5,
      finvizBase: screen.base,
      finvizScreens: passingScreens(screen),
      swing: Object.fromEntries(SWING_KS.map((k) => [String(k), swingEntry(bars, s.i, e.fill, e.risk, s.dir, k, pivots[String(k)])])),
      layerMarket: layers.market,
      layerSector: layers.sector,
      layerIndustry: layers.industry,
      sizeMult: layers.sizeMult,
      sizeMultIndustry: layers.sizeMultIndustry,
      sizeMultOpens: layers.sizeMultOpens,
      sizeMultTrend: layers.sizeMultTrend,
      baseRisk,
      shares: x.shares,
      sharesAtExit: x.sharesAtExit,
      dollarGross: x.dollarGross,
      dollarNet: x.dollarNet,
      ...entryLocation(bars, s.i, e.fill, s.dir, e.risk, TRAIL_AFTER_R),
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
      adds: x.adds,
      addGapSkips: x.addGapSkips,
      addCapReached: x.addCapReached,
      reached3R: x.reached3R,
      size: x.size,
      initialUnitR: x.initialUnitR,
      controlNetR: control?.netR ?? null,
      controlPost: control ? control.i > s.i : null,
      controlWindowNetR: controlW?.netR ?? null,
      controlWindowPost: controlW ? controlW.i > s.i : null,
      regime: opts.regime?.get(s.date) ?? null,
      quarter: quarterOf(s.date),
    });
  }
  return { trades, counts, sizeSkipByType };
}

// ── Metrics and verdicts ───────────────────────────────────────────────────────

export interface GroupMetrics {
  trades: number;
  winRate: number | null;
  /** Share of trades that exited at the target (3R). */
  targetRate: number | null;
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
  /** P3-0j3 descriptive: the ±20-session control's expectancy (the pre-P3-0j3 definition). */
  controlWindowExpectancy: number | null;
  /** Exit B management (§1e). */
  addRate: number | null; // share of trades with at least one add
  avgAdds: number | null;
  maxAdds: number | null;
  addGapSkips: number;
  /** P3-0i4: trades that reached MAX_ADDS adds. */
  addCapReached: number;
  reached3RRate: number | null;
  beExitRate: number | null;
  avgRReached3R: number | null;
  avgRNot3R: number | null;
  timeCaps: number;
  avgInitialUnitR: number | null;
  /** §1h: total dollar P&L (net) and its max drawdown, trades in exit-date order. */
  dollarNet: number;
  maxDrawdownDollar: number | null;
  /** §1g: size-weighted R = R × size_mult (the portfolio view under the sizing rule). */
  sizeWeightedR: number;
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

/** Max peak-to-trough of cumulative dollar P&L, trades in exit-date order. */
export function maxDrawdownDollar(trades: readonly Pick<Trade, "exitDate" | "symbol" | "dollarNet">[]): number | null {
  if (!trades.length) return null;
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.symbol.localeCompare(b.symbol));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of sorted) {
    cum += t.dollarNet ?? 0;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

export interface PortfolioStats {
  trades: number;
  dollarNet: number;
  maxDrawdownDollar: number | null;
  tradesPerSession: number | null;
  peakOpenPositions: number;
  peakOpenRisk: number;
  peakDate: string | null;
}

/**
 * §1h account view, no cap applied: open positions and open risk (shares × per-share
 * risk at the entry) on every session, a position counting from its fill date through its
 * exit date.
 */
export function portfolioStats(trades: readonly Trade[], sessions: number): PortfolioStats {
  const events: Array<{ d: string; order: number; pos: number; risk: number }> = [];
  for (const t of trades) {
    const risk = t.shares * t.risk;
    events.push({ d: t.fillDate, order: 0, pos: 1, risk });
    events.push({ d: t.exitDate, order: 1, pos: -1, risk: -risk });
  }
  events.sort((a, b) => a.d.localeCompare(b.d) || a.order - b.order);
  let pos = 0;
  let risk = 0;
  let peakPos = 0;
  let peakRisk = 0;
  let peakDate: string | null = null;
  for (const e of events) {
    pos += e.pos;
    risk += e.risk;
    if (e.order === 0 && pos > peakPos) {
      peakPos = pos;
      peakDate = e.d;
    }
    if (e.order === 0) peakRisk = Math.max(peakRisk, risk);
  }
  return {
    trades: trades.length,
    dollarNet: trades.reduce((s, t) => s + t.dollarNet, 0),
    maxDrawdownDollar: maxDrawdownDollar(trades),
    tradesPerSession: sessions > 0 ? trades.length / sessions : null,
    peakOpenPositions: peakPos,
    peakOpenRisk: peakRisk,
    peakDate,
  };
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
    targetRate: trades.length ? trades.filter((t) => t.reason === "target").length / trades.length : null,
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
    controlWindowExpectancy: mean(trades.map((t) => t.controlWindowNetR).filter((v): v is number => v != null)),
    addRate: trades.length ? trades.filter((t) => t.adds > 0).length / trades.length : null,
    avgAdds: mean(trades.map((t) => t.adds)),
    maxAdds: trades.length ? Math.max(...trades.map((t) => t.adds)) : null,
    addGapSkips: trades.reduce((s, t) => s + t.addGapSkips, 0),
    addCapReached: trades.filter((t) => t.addCapReached).length,
    reached3RRate: trades.length ? trades.filter((t) => t.reached3R).length / trades.length : null,
    beExitRate: trades.length ? trades.filter((t) => t.reason === "be_stop").length / trades.length : null,
    avgRReached3R: mean(trades.filter((t) => t.reached3R).map((t) => t.netR)),
    avgRNot3R: mean(trades.filter((t) => !t.reached3R).map((t) => t.netR)),
    timeCaps: trades.filter((t) => t.reason === "time_cap").length,
    avgInitialUnitR: mean(trades.map((t) => t.initialUnitR)),
    dollarNet: trades.reduce((s, t) => s + (t.dollarNet ?? 0), 0),
    maxDrawdownDollar: maxDrawdownDollar(trades),
    sizeWeightedR: trades.reduce((s, t) => s + t.netR * (t.sizeMult ?? 1), 0),
  };
}

/** Net expectancy > 0 and above the matched control, with at least `min` trades. */
export function passes(m: GroupMetrics, min: number): boolean {
  return m.trades >= min && m.expectancy != null && m.expectancy > 0 && m.controlExpectancy != null && m.expectancy > m.controlExpectancy;
}

/** P3-0j3: the same rule against the descriptive ±20 control (provisional-KEEP check). */
export const passesWindow = (m: GroupMetrics, min: number) => passes({ ...m, controlExpectancy: m.controlWindowExpectancy }, min);

/** P3-0j3: appended to a KEEP that doesn't also pass against the ±20 control. */
export const PROVISIONAL_AFTER_ONLY = "PROVISIONAL: KEEP only under the after-trigger control (changed after the first results, P3-0j3); needs live confirmation";

export type SimVerdict = "KEEP" | "DROP" | "INSUFFICIENT" | "NOT_RUN";

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

/** §1d descriptive buckets for week_used and month_used. */
export const USED_BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "<0.25", lo: -Infinity, hi: 0.25 },
  { label: "0.25-0.5", lo: 0.25, hi: 0.5 },
  { label: "0.5-0.75", lo: 0.5, hi: 0.75 },
  { label: "0.75-1", lo: 0.75, hi: 1 },
  { label: ">=1", lo: 1, hi: Infinity },
];

/** §1f descriptive buckets for rally_age and pullback_ratio. */
export const THIRDS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "<0.5", lo: -Infinity, hi: 0.5 },
  { label: "0.5-1", lo: 0.5, hi: 1 },
  { label: ">=1", lo: 1, hi: Infinity },
];

export const TRIGGER_TYPES = ["inside", "butn", "brutn", "mech1", "mech2", "egop"] as const;

/** The pre-registered primary groups: all, long, short, and each type × direction the rules allow. */
type GroupKey = Pick<Trade, "dir" | "type" | "variant" | "swing" | "layerMarket" | "layerSector" | "finvizBase" | "finvizScreens">;
/** §1f pre-registered selection: rally_used < 0.5 and room_3r ≥ 1 at zigzag threshold k. */
export const SWING_RALLY_MAX = 0.5;
const earlySwing = (t: GroupKey, k: string) => {
  const w = t.swing?.[k];
  return !!w && w.rallyUsed != null && w.room3R != null && w.rallyUsed < SWING_RALLY_MAX && w.room3R >= 1;
};
/** §1g pre-registered selection: market and sector layers both agree. */
const allAgree = (t: GroupKey) => t.layerMarket === "agree" && t.layerSector === "agree";
const cal = (t: GroupKey) => t.variant === "calendar";

/**
 * The pre-registered primary groups, 49: all, long, short and each type × direction on
 * the calendar triggers (13); inside± and the U-turns with rolling opens (4, step 1c);
 * swing-structure early entries for k = 1.5, 2, 3 × long/short (6, §1f, replacing §1d's
 * 2); Power Pyramid "all agree" long/short (2, §1g); the Finviz base filter long/short
 * (2, §1i) and the 22 OHLCV screens in their set directions (§1i). The §1f, §1g and §1i
 * groups must also beat all calendar trades of their direction (`benchmark`); screen
 * groups with fewer than 30 trades in any fold are reported but not judged.
 */
export const PRIMARY_GROUPS: ReadonlyArray<{ group: string; match: (t: GroupKey) => boolean; benchmark?: (t: GroupKey) => boolean; foldMinimum?: boolean }> = [
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
  ...SWING_KS.flatMap((k) =>
    ([1, -1] as const).map((dir) => ({
      group: `swing:k${k}:${dir === 1 ? "long" : "short"}`,
      match: (t: GroupKey) => cal(t) && t.dir === dir && earlySwing(t, String(k)),
      benchmark: (t: GroupKey) => cal(t) && t.dir === dir,
    })),
  ),
  ...([1, -1] as const).map((dir) => ({
    group: `pyramid:allAgree:${dir === 1 ? "long" : "short"}`,
    match: (t: GroupKey) => cal(t) && t.dir === dir && allAgree(t),
    benchmark: (t: GroupKey) => cal(t) && t.dir === dir,
  })),
  ...([1, -1] as const).map((dir) => ({
    group: `finviz:base:${dir === 1 ? "long" : "short"}`,
    match: (t: GroupKey) => cal(t) && t.dir === dir && t.finvizBase === true,
    benchmark: (t: GroupKey) => cal(t) && t.dir === dir,
  })),
  ...BACKFILL_SCREEN_TESTS.map(({ id, dir }) => ({
    group: `finviz:${id}:${dir === 1 ? "long" : "short"}`,
    match: (t: GroupKey) => cal(t) && t.dir === dir && (t.finvizScreens ?? []).includes(id),
    benchmark: (t: GroupKey) => cal(t) && t.dir === dir,
    foldMinimum: true,
  })),
];

/**
 * Split once over every trade (newest 30% of trigger dates held out; 3 expanding folds
 * by trigger date) and apply the same date cut to each group, so groups share one split.
 */
export function evaluateGroups(
  trades: readonly Trade[],
  opts: { verdicts?: boolean; /** Primary groups whose inputs are missing this run: reported as NOT_RUN. */ notRun?: { prefix: string; reason: string }[] } = {},
): GroupResult[] {
  const verdicts = opts.verdicts ?? true;
  const { test } = timeSplit(trades);
  const heldIds = new Set(test.map((t) => t.scanId));
  const foldIds = walkForwardFolds(trades).map((f) => new Set(f.test.map((t) => t.scanId)));
  const judge = (group: string, sel: Trade[], primary: boolean, bench?: Trade[], foldMinimum = false): GroupResult => {
    const heldOut = groupMetrics(sel.filter((t) => heldIds.has(t.scanId)));
    const folds = foldIds.map((ids) => groupMetrics(sel.filter((t) => ids.has(t.scanId))));
    // §1d early-entry groups must also beat all trades of their direction in the same split.
    const beatsBench = (m: GroupMetrics, ids: ReadonlySet<string>) => {
      if (!bench) return true;
      const b = groupMetrics(bench.filter((t) => ids.has(t.scanId)));
      return m.expectancy != null && b.expectancy != null && m.expectancy > b.expectancy;
    };
    const heldOutPasses = passes(heldOut, MIN_HELDOUT_ROWS) && beatsBench(heldOut, heldIds);
    const foldsPassed = folds.filter((f, k) => passes(f, MIN_FOLD_ROWS) && beatsBench(f, foldIds[k])).length;
    let verdict: SimVerdict | null = null;
    let reason = primary && !verdicts ? "reference exit: no verdict" : "descriptive only";
    const notRun = primary && verdicts ? opts.notRun?.find((n) => group.startsWith(n.prefix)) : undefined;
    const thinFold = foldMinimum && folds.some((f) => f.trades < MIN_FOLD_ROWS);
    if (notRun) {
      verdict = "NOT_RUN";
      reason = notRun.reason;
    } else if (primary && verdicts) {
      if (heldOut.trades < MIN_HELDOUT_ROWS || thinFold) {
        verdict = "INSUFFICIENT";
        reason = heldOut.trades < MIN_HELDOUT_ROWS
          ? `${heldOut.trades} held-out trades (need ${MIN_HELDOUT_ROWS})`
          : `a fold has fewer than ${MIN_FOLD_ROWS} trades (screens are reported, not judged)`;
      } else if (!heldOutPasses) {
        verdict = "DROP";
        reason = bench
          ? "held-out net expectancy not > 0, above its matched control and above all trades of its direction"
          : "held-out net expectancy not > 0 and above its matched control";
      } else if (foldsPassed < FOLDS_REQUIRED) {
        verdict = "DROP";
        reason = `passes held out but only ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds (need ${FOLDS_REQUIRED})`;
      } else {
        verdict = "KEEP";
        reason = `passes held out and ${foldsPassed} of ${WALK_FORWARD_FOLDS} folds`;
        const wHeld = passesWindow(heldOut, MIN_HELDOUT_ROWS) && beatsBench(heldOut, heldIds);
        const wFolds = folds.filter((f, k) => passesWindow(f, MIN_FOLD_ROWS) && beatsBench(f, foldIds[k])).length;
        if (!(wHeld && wFolds >= FOLDS_REQUIRED)) reason += `; ${PROVISIONAL_AFTER_ONLY}`;
      }
    }
    return { group, primary, all: groupMetrics(sel), heldOut, folds, foldsPassed, verdict, reason };
  };
  const out: GroupResult[] = PRIMARY_GROUPS.map((g) => judge(g.group, trades.filter(g.match), true, g.benchmark ? trades.filter(g.benchmark) : undefined, g.foldMinimum));
  const calendar = trades.filter((t) => t.variant === "calendar");
  for (const type of TRIGGER_TYPES) out.push(judge(`type:${type}`, calendar.filter((t) => t.type === type), false));
  // Step 1b: do the weekly/monthly opens add anything on top of the MA- and catalyst-based patterns?
  for (const type of ["mech1", "mech2", "egop"] as const)
    for (const a of ["aligned", "partial", "against"] as const)
      out.push(judge(`htf:${type}:${a}`, calendar.filter((t) => t.type === type && t.alignment === a), false));
  // §1d descriptive: expectancy and 3R-hit rate by how much of the normal move the entry had used
  for (const m of ["weekUsed", "monthUsed"] as const)
    for (const b of USED_BUCKETS) out.push(judge(`loc:${m}:${b.label}`, calendar.filter((t) => t[m] != null && t[m]! >= b.lo && t[m]! < b.hi), false));
  out.push(judge("loc:roomW:<1", calendar.filter((t) => t.roomW != null && t.roomW < 1), false));
  out.push(judge("loc:roomW:>=1", calendar.filter((t) => t.roomW != null && t.roomW >= 1), false));
  // §1f descriptive, per k
  const ranges = (name: string, cuts: ReadonlyArray<{ label: string; lo: number; hi: number }>, get: (t: Trade) => number | null) => {
    for (const b of cuts) out.push(judge(`${name}:${b.label}`, calendar.filter((t) => { const v = get(t); return v != null && v >= b.lo && v < b.hi; }), false));
  };
  for (const k of SWING_KS) {
    const kk = String(k);
    ranges(`swing:k${k}:rallyUsed`, USED_BUCKETS, (t) => t.swing?.[kk]?.rallyUsed ?? null);
    ranges(`swing:k${k}:room3R`, [{ label: "<1", lo: -Infinity, hi: 1 }, { label: ">=1", lo: 1, hi: Infinity }], (t) => t.swing?.[kk]?.room3R ?? null);
    ranges(`swing:k${k}:rallyAge`, THIRDS, (t) => t.swing?.[kk]?.rallyAge ?? null);
    ranges(`swing:k${k}:pullbackRatio`, THIRDS, (t) => t.swing?.[kk]?.pullbackRatio ?? null);
  }
  // §1g descriptive: size multiples (layers both / opens-only / trend-only / with industry) and each layer's state
  for (const m of [1, 0.5, 0.25]) out.push(judge(`pyramid:size:${m}`, calendar.filter((t) => t.sizeMult === m), false));
  for (const m of [1, 0.5, 0.25]) out.push(judge(`pyramid:opensOnly:size:${m}`, calendar.filter((t) => t.sizeMultOpens === m), false));
  for (const m of [1, 0.5, 0.25]) out.push(judge(`pyramid:trendOnly:size:${m}`, calendar.filter((t) => t.sizeMultTrend === m), false));
  for (const m of [1, 0.5, 0.25, 0.125]) out.push(judge(`pyramid:withIndustry:size:${m}`, calendar.filter((t) => t.sizeMultIndustry === m), false));
  for (const layer of ["layerMarket", "layerSector", "layerIndustry"] as const)
    for (const st of ["agree", "mixed", "disagree", null] as const)
      out.push(judge(`pyramid:${layer.replace("layer", "").toLowerCase()}:${st ?? "none"}`, calendar.filter((t) => t[layer] === st), false));
  // §1j descriptive: stock factor, combined size, floor hits; market layer agree vs not (the choppy-variant split)
  for (const f of [1, 0.5]) out.push(judge(`size:stock:${f}`, calendar.filter((t) => t.stockFactor === f), false));
  for (const m of [1, 0.5, 0.25]) out.push(judge(`size:combined:${m}`, calendar.filter((t) => t.sizeCombined === m), false));
  out.push(judge("size:floorHit", calendar.filter((t) => t.floorHit), false));
  out.push(judge("size:absFullFixedHalf", calendar.filter((t) => t.absFullFixedHalf), false));
  out.push(judge("market:agree", calendar.filter((t) => t.layerMarket === "agree"), false));
  out.push(judge("market:notAgree", calendar.filter((t) => t.layerMarket !== "agree"), false));
  for (const r of ["spy_above_sma20", "spy_below_sma20"] as const) out.push(judge(`regime:${r}`, calendar.filter((t) => t.regime === r), false));
  for (const q of [...new Set(calendar.map((t) => t.quarter))].sort()) out.push(judge(`quarter:${q}`, calendar.filter((t) => t.quarter === q), false));
  return out;
}
