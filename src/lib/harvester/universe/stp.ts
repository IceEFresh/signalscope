/**
 * STP daily signals, PLAN.md item 1g, spec in docs/STP-SIGNALS.md (Chris's
 * "STP Indicators and Trade Triggers", daily-timeframe logic only).
 *
 * LOG ONLY: the trigger is stored per universe ticker per scan and is not a
 * signal source; no score, stage or label reads it until Phase 3.
 *
 * Every value is computed on the last COMPLETED daily bar (t). parseChartBars
 * already drops an open session's partial bar, and the 8:30 AM harvest runs
 * before the open, so t is the previous session and nothing looks ahead.
 */
import { etParts, type DailyBar } from "./bar-metrics";
import { sma, stpHtfOpens, weekStart, wilderAtr } from "./bar-features";

export type StpTriggerType = "inside" | "butn" | "brutn" | "mech1" | "mech2" | "egop";

export interface StpResult {
  barDate: string | null;
  /** States */
  htfOpens: number | null; // stp_htf_opens (= trendDirection on daily bars)
  maState: number | null; // stp_ma_state
  wellBid: number | null; // stp_well_bid
  sizeFactor: number | null; // stp_size_factor
  /** Trigger: +1, −1 or 0 */
  trigger: number | null;
  triggerType: StpTriggerType | null;
  /** Every rule that fired, e.g. ["inside+", "mech1+"], for analysis */
  firedRules: string[];
  /** Trade parameters, null unless trigger is ±1 */
  atr14: number | null;
  fudge: number | null;
  entry: number | null;
  stop: number | null;
  risk: number | null;
  target2R: number | null;
  target3R: number | null;
  addLevel2R: number | null; // entry ± 1 × ATR (choppy, R = 2)
  addLevel3R: number | null; // entry ± 2 × ATR (trending, R = 3)
}

const dateOf = (b: DailyBar | undefined): string | null => (b?.time != null ? etParts(new Date(b.time * 1000)).date : null);

/** Open of the first bar of bar i's week (or month); null if that period may start before the window. */
export function periodOpenAt(bars: readonly DailyBar[], i: number, kind: "week" | "month"): number | null {
  const d = dateOf(bars[i]);
  if (!d) return null;
  const key = (x: string) => (kind === "week" ? weekStart(x) : x.slice(0, 7));
  const target = key(d);
  let j = i;
  while (j > 0) {
    const prev = dateOf(bars[j - 1]);
    if (!prev || key(prev) !== target) break;
    j--;
  }
  if (j === 0) return null;
  return bars[j].open ?? null;
}

/** stp_htf_opens at bar i (trendDirection on daily bars). */
export function htfOpensAt(bars: readonly DailyBar[], i: number): number | null {
  if (i < 0 || i >= bars.length) return null;
  return stpHtfOpens(bars[i].close, periodOpenAt(bars, i, "week"), periodOpenAt(bars, i, "month"));
}

/** stp_well_bid at bar i (needs bar i − 1 and bar i's open). */
export function wellBidAt(bars: readonly DailyBar[], i: number): number | null {
  if (i < 1 || i >= bars.length) return null;
  const b = bars[i];
  const p = bars[i - 1];
  if (b.open == null) return null;
  if (b.high > p.high && b.low > p.low && b.close > b.open && b.close > p.close && b.close > p.high) return 1;
  if (b.high < p.high && b.low < p.low && b.close < b.open && b.close < p.close && b.close < p.low) return -1;
  return 0;
}

export function maState(close: number, sma20: number | null, sma50: number | null): number | null {
  if (sma20 == null || sma50 == null) return null;
  if (close > sma20 && close > sma50 && sma20 > sma50) return 1;
  if (close < sma20 && close < sma50 && sma20 < sma50) return -1;
  return 0;
}

const crossesAbove = (prev: number, prevLevel: number, cur: number, curLevel: number) => prev <= prevLevel && cur > curLevel;
const crossesBelow = (prev: number, prevLevel: number, cur: number, curLevel: number) => prev >= prevLevel && cur < curLevel;

/**
 * True when bar i is the first session after the earnings release at
 * `earningsTs` (unix s): the release falls after bar i−1's start and at or
 * before bar i's start (after-close on the prior day, or before today's open).
 */
export function isFirstBarAfterEarnings(bars: readonly DailyBar[], i: number, earningsTs: number | null): boolean {
  if (earningsTs == null || i < 1) return false;
  const t = bars[i].time;
  const tp = bars[i - 1].time;
  return t != null && tp != null && earningsTs > tp && earningsTs <= t;
}

const EMPTY: Omit<StpResult, "barDate"> = {
  htfOpens: null,
  maState: null,
  wellBid: null,
  sizeFactor: null,
  trigger: null,
  triggerType: null,
  firedRules: [],
  atr14: null,
  fudge: null,
  entry: null,
  stop: null,
  risk: null,
  target2R: null,
  target3R: null,
  addLevel2R: null,
  addLevel3R: null,
};

/** Compute STP states, trigger and trade parameters on the last bar. */
export function computeStp(bars: readonly DailyBar[], earningsTs: number | null = null): StpResult {
  const n = bars.length;
  const t = n - 1;
  const barDate = dateOf(bars[t]);
  // sma50 at t and t−1 needs 51 bars; trendDirection 3 bars ago needs t − 3.
  if (n < 51) return { barDate, ...EMPTY };

  const closes = bars.map((b) => b.close);
  const b = bars[t];
  const p = bars[t - 1];
  const s10 = sma(closes, 10, t);
  const s20 = sma(closes, 20, t);
  const s50 = sma(closes, 50, t);
  const s10p = sma(closes, 10, t - 1);
  const s20p = sma(closes, 20, t - 1);

  const htf = htfOpensAt(bars, t);
  const ma = maState(b.close, s20, s50);
  const wellBid = wellBidAt(bars, t);
  const sizeFactor = htf == null || ma == null ? null : Math.abs(htf) === 1 && ma !== 0 ? 1 : 0.5;

  const bull: StpTriggerType[] = [];
  const bear: StpTriggerType[] = [];

  // Inside candle: flagged against trendDirection only (not its own body), as the Pine code does.
  const inside = b.high <= p.high && b.low >= p.low;
  if (inside && htf != null && htf >= 1) bull.push("inside");
  if (inside && htf != null && htf <= -1) bear.push("inside");

  // U-turns need opens on t and t−1.
  if (b.open != null && p.open != null) {
    const trend3 = htfOpensAt(bars, t - 3);
    const wellBidPrev = wellBidAt(bars, t - 1);
    const butn = b.high < p.high && p.close < p.open && b.close > p.close && b.low < p.low && b.close > p.low && b.close > b.open;
    const brutn = b.low > p.low && p.close > p.open && b.close < p.close && b.high > p.high && b.close < p.high && b.close < b.open;
    if (butn && trend3 != null && trend3 >= 1 && wellBidPrev != null && wellBidPrev <= -1) bull.push("butn");
    if (brutn && trend3 != null && trend3 <= -1 && wellBidPrev != null && wellBidPrev >= 1) bear.push("brutn");
  }

  if (s10 != null && s20 != null && s50 != null && s10p != null && s20p != null) {
    // Mechanical I
    if (s20 >= s50 && s10 <= s20 && crossesAbove(p.close, s20p, b.close, s20)) bull.push("mech1");
    if (s20 <= s50 && s10 >= s20 && crossesBelow(p.close, s20p, b.close, s20)) bear.push("mech1");
    // Mechanical II (docs/STP-SIGNALS.md): sma10 crossing sma20 can't coexist with sma10 ≤ sma20 on the
    // same bar, so only the sma20-vs-sma50 trend condition applies. The original Pine block was unreachable.
    if (s20 >= s50 && b.close > s20 && crossesAbove(s10p, s20p, s10, s20)) bull.push("mech2");
    if (s20 <= s50 && b.close < s20 && crossesBelow(s10p, s20p, s10, s20)) bear.push("mech2");
  }

  if (b.open != null && isFirstBarAfterEarnings(bars, t, earningsTs)) {
    if (b.low > p.high && b.close > b.open) bull.push("egop");
    if (b.high < p.low && b.close < b.open) bear.push("egop");
  }

  const firedRules = [...bull.map((r) => `${r}+`), ...bear.map((r) => `${r}-`)];
  // Bullish wins when both sides fire, as Pine's isATrade checks bullish first. firedRules keeps both.
  let trigger = 0;
  let triggerType: StpResult["triggerType"] = null;
  if (bull.length > 0) {
    trigger = 1;
    triggerType = bull[0];
  } else if (bear.length > 0) {
    trigger = -1;
    triggerType = bear[0];
  }

  const atrSeries = wilderAtr(bars);
  const atr14 = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : null;
  const fudge = atr14 != null ? Math.max(0.11 * atr14, 0.02) : null;

  let params: Pick<StpResult, "entry" | "stop" | "risk" | "target2R" | "target3R" | "addLevel2R" | "addLevel3R"> = {
    entry: null, stop: null, risk: null, target2R: null, target3R: null, addLevel2R: null, addLevel3R: null,
  };
  if (trigger !== 0 && atr14 != null && fudge != null) {
    const dir = trigger; // +1 long, −1 short
    const entry = dir > 0 ? b.high + fudge : b.low - fudge;
    const stop = dir > 0 ? b.low - fudge : b.high + fudge;
    const risk = Math.abs(entry - stop);
    params = {
      entry,
      stop,
      risk,
      target2R: entry + dir * 2 * risk,
      target3R: entry + dir * 3 * risk,
      addLevel2R: entry + dir * 1 * atr14,
      addLevel3R: entry + dir * 2 * atr14,
    };
  }

  return { barDate, htfOpens: htf, maState: ma, wellBid, sizeFactor, trigger, triggerType, firedRules, atr14, fudge, ...params };
}
