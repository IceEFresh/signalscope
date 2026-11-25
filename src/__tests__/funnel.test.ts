import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sizeMult } from "@/lib/harvester/universe/pyramid";
import type { Pivot } from "@/lib/harvester/universe/swings";
import {
  calendarExpiry,
  eventBeforeIndices,
  inHoursOn,
  isOutOfHours,
  nextEvent,
  outOfHoursWithin,
  parseMacroCalendar,
  sessionsAfter,
  type MacroEvent,
} from "@/lib/harvester/macro-calendar";
import {
  earningsWithin,
  funnelGates,
  funnelSize,
  limitEntryOnNextBar,
  pullbackLimit,
  rankDay,
  riskReward,
  FUNNEL_TOP,
} from "@/lib/eval/funnel";
import { evaluateFunnel, FUNNEL_COMPARISONS, inPopulation, rankCandidates, type Candidate } from "@/lib/eval/funnel-sim";
import { simulateExitB, stockFactor } from "@/lib/eval/stp-sim";
import { applyFunnelRanks } from "@/lib/harvester/universe/stp-live";

/** Weekday bars at 14:30 UTC from OHLC tuples, starting Monday 2026-01-05. */
function bars(ohlc: Array<[number, number, number, number]>, start = Date.UTC(2026, 0, 5, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return ohlc.map(([open, high, low, close]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
const SRC = { FOMC: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", CPI: "https://www.bls.gov/schedule/news_release/cpi.htm" };
const ev = (event: "FOMC" | "CPI", date: string, time: string): MacroEvent => ({ event, date, time, source: SRC[event], outOfHours: isOutOfHours(time) });
// Mon 2026-01-05 … ; 2026-01-19 is a holiday (MLK)
const SESSIONS = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16", "2026-01-20", "2026-01-21"];

describe("macro calendar", () => {
  it("keeps only valid rows from official sources and tags out-of-hours by time", () => {
    const cal = parseMacroCalendar({
      events: [
        { event: "CPI", date: "2026-01-13", time: "08:30", source: SRC.CPI },
        { event: "FOMC", date: "2026-01-28", time: "14:00", source: SRC.FOMC },
        { event: "CPI", date: "2026-02-11", time: "08:30", source: "https://example.com/cpi" },
        { event: "CLAIMS", date: "2026-01-08", time: "08:30", source: "https://www.dol.gov/x" },
        { event: "PPI", date: "2026-1-14", time: "08:30", source: "https://www.bls.gov/x" },
      ],
    });
    expect(cal.map((e) => [e.event, e.outOfHours])).toEqual([["CPI", true], ["FOMC", false]]);
    expect(isOutOfHours("09:29")).toBe(true);
    expect(isOutOfHours("09:30")).toBe(false);
    expect(isOutOfHours("16:00")).toBe(true);
  });

  it("an out-of-hours event 5 sessions after D halves; 6 sessions after doesn't (look-ahead: a later event never halves D)", () => {
    const D = "2026-01-12"; // sessions after: 13, 14, 15, 16, 20 (holiday skipped), 21
    expect(sessionsAfter(D, 5, SESSIONS)).toEqual(["2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16", "2026-01-20"]);
    expect(outOfHoursWithin(D, [ev("CPI", "2026-01-20", "08:30")], SESSIONS)).not.toBeNull();
    expect(outOfHoursWithin(D, [ev("CPI", "2026-01-21", "08:30")], SESSIONS)).toBeNull();
    expect(outOfHoursWithin(D, [ev("CPI", "2026-01-12", "08:30")], SESSIONS)).toBeNull(); // on D itself: already known at the close
    expect(outOfHoursWithin(D, [ev("FOMC", "2026-01-14", "14:00")], SESSIONS)).toBeNull(); // in-hours: stops, not size
    expect(inHoursOn("2026-01-14", [ev("FOMC", "2026-01-14", "14:00")])?.event).toBe("FOMC");
    // past the stored sessions, weekdays stand in
    expect(sessionsAfter("2026-01-21", 3, SESSIONS)).toEqual(["2026-01-22", "2026-01-23", "2026-01-26"]);
    expect(nextEvent(D, [ev("CPI", "2026-01-20", "08:30")], SESSIONS)).toMatchObject({ sessions: 5 });
  });

  it("size: 0.5 for the event, and 0.5 × 0.25 still floors at 0.25", () => {
    expect(funnelSize(1, 1, true)).toBe(0.5);
    expect(funnelSize(1, 1, false)).toBe(1);
    expect(funnelSize(0.5, 0.5, true)).toBe(0.25);
    expect(funnelSize(1, 0.25, true)).toBe(0.25);
  });

  it("the stop rule is set at the close of the session before the event, in-hours and out-of-hours alike", () => {
    const dates = ["2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16", "2026-01-20"];
    expect([...eventBeforeIndices(dates, [ev("CPI", "2026-01-14", "08:30")])]).toEqual([1]);
    expect([...eventBeforeIndices(dates, [ev("FOMC", "2026-01-14", "14:00")])]).toEqual([1]);
    expect([...eventBeforeIndices(dates, [ev("CPI", "2026-01-19", "08:30")])]).toEqual([4]); // a holiday release → the last close before it
    expect([...eventBeforeIndices(dates, [ev("CPI", "2026-01-12", "08:30")])]).toEqual([]); // before the first bar
  });

  it("warns when the calendar has fewer than 60 days left", () => {
    expect(calendarExpiry([ev("CPI", "2026-03-01", "08:30")], "2026-01-01")).toMatchObject({ daysLeft: 59, warn: true });
    expect(calendarExpiry([ev("CPI", "2026-03-02", "08:30")], "2026-01-01")).toMatchObject({ daysLeft: 60, warn: false });
    expect(calendarExpiry([], "2026-01-01").warn).toBe(true);
  });
});

describe("gates", () => {
  it("earnings exactly 5 sessions out blocks; 6 sessions out doesn't; no dates doesn't block", () => {
    expect(earningsWithin("2026-01-12", new Set(["2026-01-20"]), SESSIONS)).toBe(true);
    expect(earningsWithin("2026-01-12", new Set(["2026-01-21"]), SESSIONS)).toBe(false);
    expect(earningsWithin("2026-01-12", undefined, SESSIONS)).toBeNull();
    expect(funnelGates({ dir: 1, finvizBase: true, earnings5: true, rr: 5, marketLong: "agree" }).pass).toBe(false);
    expect(funnelGates({ dir: 1, finvizBase: true, earnings5: null, rr: 5, marketLong: "agree" }).pass).toBe(true);
    expect(funnelGates({ dir: 1, finvizBase: false, earnings5: false, rr: 5, marketLong: "agree" }).pass).toBe(false);
    expect(funnelGates({ dir: 1, finvizBase: null, earnings5: false, rr: 5, marketLong: "agree" }).pass).toBe(false);
  });

  it("R/R gate at 3; a counter-trend short (market agrees with long) needs 4", () => {
    expect(funnelGates({ dir: 1, finvizBase: true, earnings5: false, rr: 2.99, marketLong: "agree" }).gateRr).toBe(false);
    expect(funnelGates({ dir: 1, finvizBase: true, earnings5: false, rr: 3, marketLong: "agree" }).gateRr).toBe(true);
    const ct = (rr: number) => funnelGates({ dir: -1, finvizBase: true, earnings5: false, rr, marketLong: "agree" });
    expect(ct(3.99)).toMatchObject({ countertrend: true, rrMin: 4, pass: false });
    expect(ct(4)).toMatchObject({ countertrend: true, pass: true });
    expect(funnelGates({ dir: -1, finvizBase: true, earnings5: false, rr: 3, marketLong: "mixed" })).toMatchObject({ countertrend: false, pass: true });
  });

  it("counter-trend short size: strong uptrend with market and sector disagreeing → 0.25; sector agreeing → 0.5", () => {
    const stock = stockFactor(1, 1, -1); // uptrend opens and MAs, short
    expect(stock).toBe(0.5);
    expect(funnelSize(stock, sizeMult("disagree", "disagree"), false)).toBe(0.25);
    expect(funnelSize(stock, sizeMult("disagree", "agree"), false)).toBe(0.25);
    expect(funnelSize(stockFactor(1, -1, -1), sizeMult("disagree", "agree"), false)).toBe(0.25);
    // the MAs agreeing with the short (stock factor still 0.5 unless opens agree too) with an agreeing sector
    expect(funnelSize(0.5, sizeMult("agree", "agree"), false)).toBe(0.5);
  });
});

describe("R/R from nearby levels", () => {
  // five quiet bars in one week (opens rising, so the week and month opens sit below the entry)
  const b = bars([[95, 97, 94, 96], [96, 98, 95, 97], [97, 99, 96, 98], [98, 99, 97, 98.5], [98.5, 99.5, 98, 99]]);
  const closes = b.map((x) => x.close);
  const piv = (price: number, kind: "high" | "low", confirmedAt = 3): Pivot => ({ i: 0, price, kind, confirmedAt, atr: 4 });
  // entry 100, stop 95 (risk 5), ATR 4: 0.25 ATR = 1, 10 ATR = 40
  it("takes the nearest level beyond the entry", () => {
    expect(riskReward(b, closes, 4, 1, 100, 95, 4, [piv(115, "high"), piv(110, "high")])).toMatchObject({ rr: 2, room: 10, level: "swing", openAir: false });
  });
  it("ignores a level within 0.25 ATR of the entry, and a pivot not yet confirmed by D", () => {
    expect(riskReward(b, closes, 4, 1, 100, 95, 4, [piv(100.9, "high"), piv(110, "high")]).rr).toBe(2);
    expect(riskReward(b, closes, 4, 1, 100, 95, 4, [piv(101, "high"), piv(110, "high")]).rr).toBeCloseTo(0.2, 12); // exactly 0.25 ATR counts
    expect(riskReward(b, closes, 4, 1, 100, 95, 4, [piv(104, "high", 5), piv(110, "high")]).rr).toBe(2);
  });
  it("no level within 10 ATR → open_air at 10 ATR", () => {
    expect(riskReward(b, closes, 4, 1, 100, 95, 4, [])).toMatchObject({ rr: 8, room: 40, level: "open_air", openAir: true });
    expect(riskReward(b, closes, 4, 1, 100, 95, 4, [piv(141, "high")])).toMatchObject({ rr: 8, openAir: true });
  });
  it("a short is mirrored: swing lows below the entry", () => {
    expect(riskReward(b, closes, 4, -1, 90, 95, 4, [piv(80, "low"), piv(110, "high")])).toMatchObject({ rr: 2, level: "swing" });
    // the week open (95) is above a short entry at 90: not a target; the 5-bar extremes need 20 bars
    expect(riskReward(b, closes, 4, -1, 90, 95, 4, [])).toMatchObject({ openAir: true });
  });
});

describe("ranking", () => {
  it("R/R descending, ties by rally_used ascending (null last), then symbol; top 5 kept", () => {
    const c = [
      { symbol: "A", rr: 4, rallyUsed: 0.6 },
      { symbol: "B", rr: 4, rallyUsed: 0.2 },
      { symbol: "C", rr: 6, rallyUsed: null },
      { symbol: "D", rr: 4, rallyUsed: null },
      { symbol: "E", rr: 3.5, rallyUsed: 0.1 },
      { symbol: "F", rr: 3.2, rallyUsed: 0.1 },
      { symbol: "G", rr: 3.1, rallyUsed: 0.1 },
    ];
    const r = rankDay(c);
    expect([...r.entries()].sort((a, b) => a[1] - b[1]).map(([x]) => x.symbol)).toEqual(["C", "B", "A", "D", "E", "F", "G"]);
    // across symbols on one day, only passing candidates are ranked; the top 5 population is ranks 1–5
    const cand = (symbol: string, rr: number, pass = true): Candidate =>
      ({ symbol, date: "2026-01-12", dir: 1, rr: { rr, room: 1, level: "swing", levelPrice: 1, openAir: false }, gates: { pass }, rallyUsed: null, rank: null }) as unknown as Candidate;
    const day = ["A", "B", "C", "D", "E", "F", "G"].map((s, k) => cand(s, 10 - k));
    const failing = cand("Z", 99, false);
    rankCandidates([...day, failing]);
    expect(failing.rank).toBeNull();
    expect(day.filter((x) => inPopulation(x, "top5")).map((x) => x.symbol)).toEqual(["A", "B", "C", "D", "E"]);
    expect(day.filter((x) => inPopulation(x, "top5"))).toHaveLength(FUNNEL_TOP);
    expect(day.filter((x) => inPopulation(x, "top3"))).toHaveLength(3);
    expect(inPopulation(failing, "all")).toBe(true);
  });

  it("live: applyFunnelRanks ranks today's passing rows only", () => {
    const rows = [
      { symbol: "X", features: { funnel_pass: true, rr: 3.5, swing_k2_rally_used: 0.4 } as Record<string, unknown> },
      { symbol: "Y", features: { funnel_pass: true, rr: 3.5, swing_k2_rally_used: 0.1 } as Record<string, unknown> },
      { symbol: "Z", features: { funnel_pass: false, rr: 9 } as Record<string, unknown> },
    ];
    expect(applyFunnelRanks(rows)).toBe(2);
    expect(rows.map((r) => r.features.funnel_rank ?? null)).toEqual([2, 1, null]);
  });
});

describe("pullback entry", () => {
  const trigger = bars([[100, 110, 100, 108]])[0]; // midpoint 105; stop 100 − fudge
  const stop = 99;
  it("fills at the trigger bar's midpoint; an open below the limit fills at the open", () => {
    expect(pullbackLimit(trigger, 1, 1, "pullback")).toBe(105);
    expect(pullbackLimit(trigger, 1, 1, "pullback_low")).toBe(101);
    expect(pullbackLimit(trigger, -1, 1, "pullback_low")).toBe(109);
    expect(limitEntryOnNextBar(bars([[108, 109, 104, 107]])[0], 1, 105, stop)).toEqual({ status: "filled", fill: 105, risk: 6 });
    // P3-0j3: a better open keeps the planned risk (limit − stop) as the sizing and R unit
    expect(limitEntryOnNextBar(bars([[103, 106, 102, 105]])[0], 1, 105, stop)).toEqual({ status: "filled", fill: 103, risk: 6 });
  });
  it("no fill when D+1 never trades down to the limit; no fill on a gap at or below the stop", () => {
    expect(limitEntryOnNextBar(bars([[108, 112, 105.5, 111]])[0], 1, 105, stop)).toEqual({ status: "cancelled" });
    expect(limitEntryOnNextBar(bars([[98, 104, 97, 103]])[0], 1, 105, stop)).toEqual({ status: "skipped_gap" });
    expect(limitEntryOnNextBar(undefined, 1, 105, stop)).toEqual({ status: "no_bar" });
    // short mirrored
    expect(limitEntryOnNextBar(bars([[100, 106, 99, 101]])[0], -1, 105, 111)).toEqual({ status: "filled", fill: 105, risk: 6 });
  });
  it("a bar trading through the limit and the stop is filled and stopped: −1R plus costs", () => {
    const b = bars([[100, 110, 100, 108], [107, 107.5, 95, 96], [96, 97, 95, 96]]);
    const e = limitEntryOnNextBar(b[1], 1, 105, stop);
    expect(e).toMatchObject({ status: "filled", fill: 105 });
    if (e.status !== "filled") throw new Error("not filled");
    const atr = b.map(() => 2);
    const x = simulateExitB(b, b.map((y) => y.close), atr, 1, 1, e.fill, e.risk, stop, 1, "inside", 200, 1000, 3, {});
    expect(x).toMatchObject({ reason: "stop", exit: stop, exitIndex: 1, shares: 33 });
    expect(x.grossR).toBeCloseTo((33 * -6) / 200, 12);
    expect(x.netR).toBeLessThan(x.grossR);
  });
});

describe("exit rules: event stop and earnings", () => {
  // long: fill 100, stop 90 (R = 10), ATR 2 everywhere (fudge 0.22), adds out of reach
  const run = (ohlc: Array<[number, number, number, number]>, extra: Parameters<typeof simulateExitB>[13], stop0 = 90) => {
    const b = bars(ohlc);
    return simulateExitB(b, b.map((x) => x.close), b.map(() => 2), 0, 1, 100, 10, stop0, 0.22, "inside", 100, 1000, 3, extra);
  };
  const crash: [number, number, number, number] = [80, 80, 40, 41]; // gaps through any stop
  const dip = (c: number): [number, number, number, number] => [c, c, 50, 51]; // trades down through any stop above 50
  const day1 = (c: number): [number, number, number, number] => [c - 1, c + 0.5, c - 1.5, c];

  it("profit at 2R → bar stop; just under 2R → breakeven", () => {
    const at2R = run([[100, 100.5, 99.5, 100], day1(120), dip(120)], { eventBefore: new Set([1]) });
    expect(at2R).toMatchObject({ reason: "event_stop", eventTiers: ["event_bar"] });
    expect(at2R.exit).toBeCloseTo(118.5 - 0.22, 9);
    const under = run([[100, 100.5, 99.5, 100], day1(119.99), dip(119.99)], { eventBefore: new Set([1]) });
    expect(under).toMatchObject({ reason: "event_stop", exit: 100, eventTiers: ["event_be"] });
  });

  it("profit at 1 ATR → breakeven; just under 1 ATR → stop left as is", () => {
    expect(run([[100, 100.5, 99.5, 100], day1(102), dip(102)], { eventBefore: new Set([1]) })).toMatchObject({ exit: 100, eventTiers: ["event_be"] });
    expect(run([[100, 100.5, 99.5, 100], day1(101.99), dip(101.99)], { eventBefore: new Set([1]) })).toMatchObject({ reason: "stop", exit: 90, eventTiers: ["event_hold"] });
  });

  it("never loosens: a later breakeven-tier event keeps the tighter bar stop", () => {
    const x = run([[100, 100.5, 99.5, 100], day1(121), [121, 121.5, 119.7, 119.8], dip(119.8)], { eventBefore: new Set([1, 2]) });
    expect(x.eventTiers).toEqual(["event_bar", "event_be"]);
    expect(x.exit).toBeCloseTo(119.5 - 0.22, 9);
  });

  it("without extras the rules are off (P3-0i unchanged)", () => {
    const x = run([[100, 100.5, 99.5, 100], day1(120), dip(120)], undefined);
    expect(x.reason).toBe("stop");
    expect(x.eventTiers).toBeUndefined();
    void crash;
  });

  it("earnings: bar stop on E−2 and E−1, sold at the close of E−1", () => {
    // E = bar 6: E−3 = 3 sets the bar stop for E−2 (bar 4); E−1 = 5 sells at its close
    const q = (c: number): [number, number, number, number] => [c, c + 0.5, c - 0.5, c];
    const held = run([q(100), q(101), q(102), q(103), q(104), q(105), q(106), q(107)], { earningsAt: 6 });
    expect(held).toMatchObject({ reason: "earnings", exitIndex: 5, exit: 105 });
    // a dip on E−2 below bar E−3's low − fudge is stopped there (earnings_stop)
    const stopped = run([q(100), q(101), q(102), q(103), [103, 103.2, 100, 101], q(105), q(106)], { earningsAt: 6 });
    expect(stopped).toMatchObject({ reason: "earnings_stop", exitIndex: 4 });
    expect(stopped.exit).toBeCloseTo(102.5 - 0.22, 9);
    // the stop before E−3 is untouched: the same dip on bar 3 (E−3) isn't an earnings stop
    const early = run([q(100), q(101), q(102), [102, 102.2, 99, 100], q(101), q(102), q(103)], { earningsAt: 6 });
    expect(early.reason).toBe("earnings");
  });
});

describe("pre-registered comparisons", () => {
  it("10 comparisons: 4 per entry arm plus 2 arm comparisons; pullback ones provisional", () => {
    expect(FUNNEL_COMPARISONS).toHaveLength(10);
    expect(FUNNEL_COMPARISONS.filter((c) => c.provisional)).toHaveLength(6);
    expect(evaluateFunnel([]).every((r) => r.verdict === "INSUFFICIENT")).toBe(true);
  });
});

describe("end to end on a saved chart (smoke)", () => {
  it("candidates, ranks, every population and arm simulate without look-ahead errors; live keys are logged", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { parseChartBars } = await import("@/lib/harvester/universe/bar-metrics");
    const { scanSymbol } = await import("@/lib/eval/stp-sim");
    const { zigzag } = await import("@/lib/harvester/universe/swings");
    const { simulateFunnelSymbol, symbolCandidates } = await import("@/lib/eval/funnel-sim");
    const { liveStpKeys, LIVE_FUNNEL_KEYS } = await import("@/lib/harvester/universe/stp-live");
    const { isLiveStpKey } = await import("@/lib/health/harvest-health");
    const amd = parseChartBars(JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8")), new Date("2030-01-01T00:00:00Z"));
    const input = { symbol: "AMD", bars: amd, scanned: scanSymbol("AMD", amd), pivots: zigzag(amd, 2), pyramid: { market: [null, null, null], sector: null, industry: null } };
    const ctx = { sessions: [], events: [ev("CPI", "2099-01-01", "08:30")] };
    const cands = symbolCandidates(input, ctx);
    rankCandidates(cands);
    for (const p of ["all", "funnel", "top5", "top3"] as const)
      for (const a of ["stop", "pullback", "pullback_low"] as const) {
        const r = simulateFunnelSymbol(input, cands, p, a, ctx);
        expect(r.counts.candidates).toBe(cands.filter((c) => inPopulation(c, p)).length);
        for (const t of r.trades) expect(t.exitDate >= t.fillDate).toBe(true);
      }
    const keys = liveStpKeys(amd, undefined, { assetClass: "stock", events: ctx.events });
    for (const k of LIVE_FUNNEL_KEYS) {
      expect(keys).toHaveProperty(k);
      expect(isLiveStpKey(k)).toBe(true);
    }
    expect(keys.next_event).toBe("CPI 2099-01-01");
    expect(keys.funnel_pass).toBeNull(); // no STP result passed: no trigger
    expect(keys.event_half).toBe(false);
    const empty = liveStpKeys(amd, undefined, { assetClass: "stock", events: [] });
    expect(empty.event_half).toBeNull(); // no calendar: unknown, not "no event"
    expect(empty.event_today_inhours).toBeNull();
  });
});
