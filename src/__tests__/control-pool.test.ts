import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { CONTROL_WINDOW, controlPoolRange, matchedControl, type BarInfo, type Setup, type Trade } from "@/lib/eval/stp-sim";
import { controlSplitLines } from "@/lib/eval/stp-sim-report";
import { funnelControl, type Candidate } from "@/lib/eval/funnel-sim";
import { funnelMarkdownReport } from "@/lib/eval/funnel-report";
import type { FunnelTrade } from "@/lib/eval/funnel-sim";

/** 90 rising weekday bars: each bar trades through the prior high, so any control entry fills. */
function rising(n = 90): DailyBar[] {
  let t = Date.UTC(2025, 0, 6, 14, 30) / 1000;
  return Array.from({ length: n }, (_, k) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const c = 100 + k;
    const b = { open: c - 1, high: c + 0.5, low: c - 1.5, close: c, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
const bars = rising();
const closes = bars.map((b) => b.close);
const info: BarInfo[] = bars.map(() => ({ date: "", trigger: 0, triggerRolling: 0, fudge: 0.2 }));
const I = 45;
const setup = (type: string, symbol: string): Setup => ({ variant: "calendar", htf: 1, maState: 1, symbol, date: `2025-03-${symbol}`, i: I, dir: 1, type, firedRules: [], entry: 1, stop: 0, fudge: 0.2 });
const SYMS = Array.from({ length: 40 }, (_, k) => String(k).padStart(2, "0"));

describe("P3-0j2 control pool", () => {
  it("verdict controls: every pattern only after the trigger (P3-0j3); the ±20 window is the descriptive mode", () => {
    expect(controlPoolRange(I, "egop", 90)).toEqual({ lo: I + 1, hi: I + CONTROL_WINDOW });
    expect(controlPoolRange(I, "inside", 90)).toEqual({ lo: I + 1, hi: I + CONTROL_WINDOW });
    expect(controlPoolRange(I, "inside", 90, "window")).toEqual({ lo: I - CONTROL_WINDOW, hi: I + CONTROL_WINDOW });
    expect(controlPoolRange(5, "inside", 90, "window").lo).toBe(0);
    expect(controlPoolRange(85, "egop", 90).hi).toBe(88); // c + 1 must exist
  });

  it("an EGOP control (P3-0i matchedControl) is never drawn on or before the gap day", () => {
    const egop = SYMS.map((s) => matchedControl(setup("egop", s), bars, closes, info, "B")!);
    expect(egop.every((c) => c != null && c.i > I)).toBe(true);
    // P3-0j3: every pattern's verdict control is after the trigger; the descriptive ±20 control draws both sides
    const inside = SYMS.map((s) => matchedControl(setup("inside", s), bars, closes, info, "B")!);
    expect(inside.every((c) => c.i > I)).toBe(true);
    const window = SYMS.map((s) => matchedControl(setup("inside", s), bars, closes, info, "B", undefined, undefined, undefined, "window")!);
    expect(window.some((c) => c.i < I)).toBe(true);
    expect(window.some((c) => c.i > I)).toBe(true);
  });

  it("an EGOP control (P3-0j funnelControl) is never drawn on or before the gap day", () => {
    const atr = bars.map(() => 2);
    const dates = bars.map((_, k) => `d${String(k).padStart(3, "0")}`);
    for (const arm of ["stop", "pullback"] as const) {
      const cs = SYMS.map((s) => funnelControl({ symbol: s, date: `2025-03-${s}`, dir: 1, setup: setup("egop", s) } as unknown as Candidate, bars, closes, atr, dates, info, arm, 200, new Set(), undefined));
      expect(cs.every((c) => c == null || c.i > I)).toBe(true);
      expect(cs.filter((c) => c != null).length).toBeGreaterThan(0);
    }
  });

  it("reports the ±20 control split before vs after the trigger, next to the verdict control", () => {
    const t = (type: string, post: boolean, w: number, r: number) => ({ type, controlWindowPost: post, controlWindowNetR: w, controlNetR: r }) as unknown as Trade;
    const lines = controlSplitLines([t("egop", true, 0.5, 0.2), t("inside", false, -1, 0), t("inside", true, 1, 1), t("inside", true, 0, -1)]);
    expect(lines).toContain("| egop | 0 | n/a | 1 | 0.500 | 1 | 0.200 |");
    expect(lines).toContain("| inside | 1 | -1.000 | 2 | 0.500 | 3 | 0.000 |");
  });
});

describe("P3-0j2 funnel report: top 5 by earnings-date coverage", () => {
  it("splits top5/stop and top5/pullback by earnings_unknown with trades, net expectancy and reached 3R", () => {
    const mk = (arm: "stop" | "pullback", unknown: boolean, netR: number, reached3R: boolean, k: number) =>
      ({
        population: "top5", arm, earningsUnknown: unknown, netR, grossR: netR, reached3R, controlNetR: null, controlPost: null, eventTiers: [], eventHalf: false, countertrend: false, openAir: false,
        reason: "stop", type: "inside", dir: 1, symbol: `S${k}`, scanId: `2025-01-${String(k + 1).padStart(2, "0")}`, scanStart: new Date(), fillDate: "2025-01-02", exitDate: "2025-01-03",
        holding: 1, adds: 0, addGapSkips: 0, addCapReached: false, initialUnitR: netR, dollarNet: netR * 200, shares: 1, risk: 1, sizeMult: 1, sizeCombined: 1,
      }) as unknown as FunnelTrade;
    const trades = [mk("stop", false, 2, true, 0), mk("stop", false, 0, false, 1), mk("stop", true, -1, false, 2), mk("pullback", true, 1, true, 3)];
    const md = funnelMarkdownReport([], trades, { date: "d", commit: "c", symbols: 4, sessions: 10, candidates: 4, passing: 4, counts: {}, earningsSymbols: 2, calendarEvents: 1, calendarLine: "" });
    expect(md).toContain("| stop | EDGAR | 2 | 1.000 | 50.0% |");
    expect(md).toContain("| stop | none (earnings_unknown) | 1 | -1.000 | 0.0% |");
    expect(md).toContain("| pullback | EDGAR | 0 | n/a | n/a |");
    expect(md).toContain("| pullback | none (earnings_unknown) | 1 | 1.000 | 100.0% |");
  });
});
