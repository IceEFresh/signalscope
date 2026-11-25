/**
 * P3-0j: the stock selection funnel (docs/PHASE3-PREP.md §P3-0j). Pure.
 *
 *   universe → 1. gates → 2. STP trigger → 3. R/R ranking → top 5 per day → 4. entry → 5. size → 6. exits
 *
 * Everything here reads bars ≤ D (the trigger bar) only; the entry reads bar D+1.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sma, weekStart } from "@/lib/harvester/universe/bar-features";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import type { Pivot } from "@/lib/harvester/universe/swings";
import { sessionsAfter } from "@/lib/harvester/macro-calendar";
import { MIN_SIZE, type Dir, type EntryOutcome } from "./stp-sim";

export const FUNNEL_TOP = 5;
export const FUNNEL_TOP3 = 3;
export const RR_MIN = 3;
/** A counter-trend short (market layer agrees with long) needs this R/R. */
export const RR_MIN_COUNTERTREND = 4;
/** Levels closer than this many ATR14 to the entry are ignored (the breakout is already through them). */
export const LEVEL_IGNORE_ATR = 0.25;
/** No level within this many ATR14: room is capped here and flagged open_air. */
export const OPEN_AIR_ATR = 10;
/** Swing pivots (zigzag k = 2) from the last this many sessions. */
export const LEVEL_LOOKBACK = 250;
export const LEVEL_SWING_K = 2;
/** No own earnings on any of this many sessions after D. */
export const EARNINGS_GATE_SESSIONS = 5;
/** An out-of-hours macro event within 5 sessions halves the size. */
export const EVENT_SIZE_MULT = 0.5;

export type RrLevel = "swing" | "sma20" | "sma50" | "sma200" | "week_open" | "month_open" | "extreme20" | "extreme60" | "open_air";

export interface RiskReward {
  rr: number | null;
  /** Distance to the level (or OPEN_AIR_ATR × ATR), in price. */
  room: number | null;
  level: RrLevel | null;
  levelPrice: number | null;
  openAir: boolean;
}

/** Open of the first bar dated in D's week (month) at or before i. */
function periodOpen(bars: readonly DailyBar[], i: number, kind: "week" | "month"): number | null {
  const d = barDateOf(bars[i]);
  if (!d) return null;
  const key = (x: string) => (kind === "week" ? weekStart(x) : x.slice(0, 7));
  const cur = key(d);
  let k = i;
  while (k > 0) {
    const p = barDateOf(bars[k - 1]);
    if (!p || key(p) !== cur) break;
    k--;
  }
  return bars[k].open ?? null;
}

/**
 * §3: room to the nearest support/resistance level beyond the entry, over the trade's risk.
 * Long levels above the entry: zigzag k = 2 swing highs confirmed by D within 250 sessions,
 * sma20/50/200, the weekly and monthly opens, the 20- and 60-session highs. Levels within
 * 0.25 ATR of the entry are ignored; with none within 10 ATR the room is 10 ATR (open_air).
 * Short mirrored (swing lows, lows). Uses bars ≤ i.
 */
export function riskReward(
  bars: readonly DailyBar[],
  closes: readonly number[],
  i: number,
  dir: Dir,
  entry: number,
  stop: number,
  atr: number | null,
  pivots: readonly Pivot[],
): RiskReward {
  const risk = dir * (entry - stop);
  if (atr == null || !(atr > 0) || !(risk > 0)) return { rr: null, room: null, level: null, levelPrice: null, openAir: false };
  const levels: Array<{ level: RrLevel; price: number | null }> = [];
  for (const p of pivots) {
    if (p.confirmedAt <= i && i - p.i <= LEVEL_LOOKBACK && p.kind === (dir === 1 ? "high" : "low")) levels.push({ level: "swing", price: p.price });
  }
  levels.push({ level: "sma20", price: sma(closes, 20, i) }, { level: "sma50", price: sma(closes, 50, i) }, { level: "sma200", price: sma(closes, 200, i) });
  levels.push({ level: "week_open", price: periodOpen(bars, i, "week") }, { level: "month_open", price: periodOpen(bars, i, "month") });
  for (const [n, level] of [[20, "extreme20"], [60, "extreme60"]] as const) {
    if (i + 1 < n) continue;
    const win = bars.slice(i + 1 - n, i + 1);
    levels.push({ level, price: dir === 1 ? Math.max(...win.map((b) => b.high)) : Math.min(...win.map((b) => b.low)) });
  }
  let best: { level: RrLevel; price: number; dist: number } | null = null;
  for (const l of levels) {
    if (l.price == null || !Number.isFinite(l.price)) continue;
    const dist = dir * (l.price - entry);
    if (dist < LEVEL_IGNORE_ATR * atr) continue;
    if (!best || dist < best.dist) best = { level: l.level, price: l.price, dist };
  }
  if (!best || best.dist > OPEN_AIR_ATR * atr) {
    const room = OPEN_AIR_ATR * atr;
    return { rr: room / risk, room, level: "open_air", levelPrice: null, openAir: true };
  }
  return { rr: best.dist / risk, room: best.dist, level: best.level, levelPrice: best.price, openAir: false };
}

/** Own earnings on one of the EARNINGS_GATE_SESSIONS sessions after D; null when the symbol has no earnings dates. */
export function earningsWithin(d: string, earnings: ReadonlySet<string> | undefined, sessions: readonly string[] = [], n = EARNINGS_GATE_SESSIONS): boolean | null {
  if (!earnings) return null;
  return sessionsAfter(d, n, sessions).some((s) => earnings.has(s));
}

/** The next earnings session after D, or null. */
export function nextEarnings(d: string, earnings: ReadonlySet<string> | undefined): string | null {
  if (!earnings) return null;
  let best: string | null = null;
  for (const e of earnings) if (e > d && (best == null || e < best)) best = e;
  return best;
}

export interface Gates {
  pass: boolean;
  gateFinviz: boolean;
  /** True = no earnings within 5 sessions (or no dates for the symbol: not blocked, counted). */
  gateEarnings5: boolean;
  gateRr: boolean;
  rrMin: number;
  countertrend: boolean;
}

/**
 * §1/§3 gates. A short is counter-trend when the market layer agrees with a long; it needs
 * R/R ≥ 4 instead of 3. Earnings unknown (no EDGAR dates) doesn't block.
 */
export function funnelGates(g: { dir: Dir; finvizBase: boolean | null; earnings5: boolean | null; rr: number | null; marketLong: string | null }): Gates {
  const countertrend = g.dir === -1 && g.marketLong === "agree";
  const rrMin = countertrend ? RR_MIN_COUNTERTREND : RR_MIN;
  const gateFinviz = g.finvizBase === true;
  const gateEarnings5 = g.earnings5 !== true;
  const gateRr = g.rr != null && g.rr >= rrMin;
  return { pass: gateFinviz && gateEarnings5 && gateRr, gateFinviz, gateEarnings5, gateRr, rrMin, countertrend };
}

/**
 * §3 ranking within one day: R/R descending, ties by §1f rally_used ascending (null last),
 * then symbol. Returns each candidate's 1-based rank.
 */
export function rankDay<T extends { rr: number; rallyUsed: number | null; symbol: string }>(cands: readonly T[]): Map<T, number> {
  const sorted = [...cands].sort(
    (a, b) => b.rr - a.rr || (a.rallyUsed ?? Infinity) - (b.rallyUsed ?? Infinity) || a.symbol.localeCompare(b.symbol),
  );
  return new Map(sorted.map((c, k) => [c, k + 1]));
}

export type EntryArm = "stop" | "pullback" | "pullback_low";

/** §4b limit price: the trigger bar's midpoint; the descriptive variant: low + fudge (short: high − fudge). */
export function pullbackLimit(bar: DailyBar, dir: Dir, fudge: number, arm: "pullback" | "pullback_low"): number {
  if (arm === "pullback") return (bar.high + bar.low) / 2;
  return dir === 1 ? bar.low + fudge : bar.high - fudge;
}

/**
 * §4b: a limit order good for D+1 only, with the STP stop. Long: an open at or below the
 * stop isn't filled (skipped_gap); a bar that never trades down to the limit isn't filled
 * (cancelled); an open below the limit fills at the open, otherwise at the limit. A bar that
 * reaches the limit and the stop is filled and stopped the same day (exit B checks the stop
 * on the fill bar). Short mirrored.
 *
 * P3-0j3: `risk` is the PLANNED risk, limit − stop, fixed when the order is placed: it sets
 * the share count and the R unit (adds, the 3R trail trigger, the event tiers). A better
 * fill at the open keeps those shares, so the real risk (fill − stop) × shares is never more
 * than planned. Before P3-0j3 the risk was fill − stop, and an open a cent above the stop
 * sized ≈ $200 / $0.01 shares.
 */
export function limitEntryOnNextBar(next: DailyBar | undefined, dir: Dir, limit: number, stop: number): EntryOutcome {
  if (!next) return { status: "no_bar" };
  const open = next.open ?? null;
  if (dir === 1) {
    if (open != null && open <= stop) return { status: "skipped_gap" };
    if (next.low > limit) return { status: "cancelled" };
    const fill = open != null && open < limit ? open : limit;
    return fill - stop > 0 && limit - stop > 0 ? { status: "filled", fill, risk: limit - stop } : { status: "skipped_gap" };
  }
  if (open != null && open >= stop) return { status: "skipped_gap" };
  if (next.high < limit) return { status: "cancelled" };
  const fill = open != null && open > limit ? open : limit;
  return stop - fill > 0 && stop - limit > 0 ? { status: "filled", fill, risk: stop - limit } : { status: "skipped_gap" };
}

/** §5: stock factor × pyramid × 0.5 with an out-of-hours event within 5 sessions, floored at 0.25. */
export const funnelSize = (stock: number, pyramid: number, eventHalf: boolean) => Math.max(MIN_SIZE, stock * pyramid * (eventHalf ? EVENT_SIZE_MULT : 1));
