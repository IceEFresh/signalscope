import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { warmupDaysArg, WARMUP_DAYS } from "@/lib/harvester/universe/backfill";
import { FUDGE_VARIANTS, fudgeAt, heldOutFrom, setupAtr, sweepRow, sweepSymbol, sweptLevels, type SweepOutcome } from "@/lib/eval/fudge-sweep";
import { stoppedEarly, type Setup } from "@/lib/eval/stp-sim";
import { stoppedEarlyLines } from "@/lib/eval/aligned-report";
import type { FunnelTrade } from "@/lib/eval/funnel-sim";

function bars(ohlc: Array<[number, number, number, number]>): DailyBar[] {
  let t = Date.UTC(2026, 0, 5, 14, 30) / 1000;
  return ohlc.map(([open, high, low, close]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
// Trigger bar high 110, low 100, ATR 10 → 11% fudge 1.1: entry 111.1, stop 98.9
const setup = (dir: 1 | -1 = 1, fudge = 1.1): Setup =>
  dir === 1
    ? { variant: "calendar", htf: 1, maState: 1, symbol: "S", date: "2026-01-05", i: 0, dir, type: "inside", firedRules: [], entry: 110 + fudge, stop: 100 - fudge, fudge }
    : { variant: "calendar", htf: -1, maState: -1, symbol: "S", date: "2026-01-05", i: 0, dir, type: "inside", firedRules: [], entry: 100 - fudge, stop: 110 + fudge, fudge };
const v = (id: string) => FUDGE_VARIANTS.find((x) => x.id === id)!;

describe("--warmup-days", () => {
  it("defaults to 300, takes an override, rejects nonsense", () => {
    expect(WARMUP_DAYS).toBe(300);
    expect(warmupDaysArg(["node", "x"])).toBe(300);
    expect(warmupDaysArg(["node", "x", "--warmup-days", "120"])).toBe(120);
    expect(() => warmupDaysArg(["--warmup-days", "0"])).toThrow();
    expect(() => warmupDaysArg(["--warmup-days", "abc"])).toThrow();
  });
});

describe("fudge variants", () => {
  it("7 variants: both at 11/17/19/23%, stop-only at 17/19/23%", () => {
    expect(FUDGE_VARIANTS.map((x) => x.id)).toEqual(["both 11%", "both 17%", "both 19%", "both 23%", "stop-only 17%", "stop-only 19%", "stop-only 23%"]);
  });
  it("entry and stop move by the swept fudge from the trigger bar's high and low; stop-only keeps the 11% entry; shorts mirrored", () => {
    expect(setupAtr(setup(), null)).toBeCloseTo(10, 12);
    const base = sweptLevels(setup(), 10, v("both 11%"));
    expect(base.entry).toBeCloseTo(111.1, 12);
    expect(base.stop).toBeCloseTo(98.9, 12);
    const both = sweptLevels(setup(), 10, v("both 23%"));
    expect(both.entry).toBeCloseTo(112.3, 12);
    expect(both.stop).toBeCloseTo(97.7, 12);
    const stopOnly = sweptLevels(setup(), 10, v("stop-only 23%"));
    expect(stopOnly.entry).toBeCloseTo(111.1, 12);
    expect(stopOnly.stop).toBeCloseTo(97.7, 12);
    const short = sweptLevels(setup(-1), 10, v("both 19%"));
    expect(short.entry).toBeCloseTo(98.1, 12);
    expect(short.stop).toBeCloseTo(111.9, 12);
  });
  it("the $0.02 floor holds, and a floored trigger fudge falls back to the series ATR", () => {
    expect(fudgeAt(0.05, 0.23)).toBe(0.02);
    expect(fudgeAt(1, 0.23)).toBeCloseTo(0.23, 12);
    expect(setupAtr(setup(1, 0.02), 0.1)).toBe(0.1);
  });
});

describe("sweepSymbol", () => {
  // D: 100–110. D+1 trades to 113 (fills every long entry), then dips to 98.5 on D+2 and recovers.
  const b = bars([
    [102, 110, 100, 108],
    [110, 113, 109, 112],
    [110, 111, 98.5, 110],
    [110, 112, 109, 111],
    [111, 113, 110, 112],
  ]);
  it("a wider stop survives the dip that stops the 11% stop within 3 sessions", () => {
    const run = (id: string) => sweepSymbol(b, [setup()], v(id), { baseRisk: () => 200 })[0];
    expect(run("both 11%")).toMatchObject({ filled: true, stoppedEarly: true }); // stop 98.9 hit on D+2
    expect(run("stop-only 23%")).toMatchObject({ filled: true, stoppedEarly: false }); // stop 97.7 survives
    expect(run("both 23%").filled).toBe(true); // entry 112.3 ≤ 113
  });
  it("an entry the next bar never reaches isn't filled", () => {
    const low = bars([[102, 110, 100, 108], [110, 111.5, 109, 111], [111, 111.5, 110, 111]]);
    expect(sweepSymbol(low, [setup()], v("both 11%"), { baseRisk: () => 200 })[0].filled).toBe(true); // 111.1 ≤ 111.5
    expect(sweepSymbol(low, [setup()], v("both 19%"), { baseRisk: () => 200 })[0]).toEqual({ scanId: "2026-01-05", dir: 1, filled: false }); // 111.9 > 111.5
  });
});

describe("sweep rows and the stopped-early share", () => {
  it("fill rate, win rate, training vs held-out expectancy, stopped within 3 sessions", () => {
    const o = (scanId: string, netR?: number, early = false): SweepOutcome => ({ scanId, dir: 1, filled: netR != null || scanId === "x", netR, stoppedEarly: netR != null ? early : undefined });
    const outs = [o("2026-01-01", 2), o("2026-01-02", -1, true), o("2026-01-03"), o("2026-01-04", 1), o("2026-01-05", -1, true)];
    const held = heldOutFrom(outs.map((x) => x.scanId));
    expect(held).toBe("2026-01-04"); // newest 30% of 5 dates: the last 2
    expect(sweepRow("both 11%", outs, held)).toEqual({
      variant: "both 11%", attempts: 5, fillRate: 0.8, trades: 4, winRate: 0.5, expTrain: 0.5, expHeld: 0, stoppedEarlyShare: 0.5,
    });
  });
  it("stoppedEarly: the initial stop on the fill day or the next 2 sessions only", () => {
    expect(stoppedEarly({ reason: "stop", holding: 2 })).toBe(true);
    expect(stoppedEarly({ reason: "stop_gap", holding: 0 })).toBe(true);
    expect(stoppedEarly({ reason: "stop", holding: 3 })).toBe(false);
    expect(stoppedEarly({ reason: "be_stop", holding: 1 })).toBe(false);
  });
  it("P3-0k report: stopped within 3 sessions for p3k vs p3k_all vs p3k_noopt", () => {
    const t = (population: string, reason: string, holding: number, netR: number) =>
      ({ population, arm: "stop", reason, holding, netR, grossR: netR, symbol: "S", fillDate: "2026-01-05", exitDate: "2026-01-06", adds: 0, addGapSkips: 0, initialUnitR: netR, dollarNet: 0, reached3R: false, controlNetR: null }) as unknown as FunnelTrade;
    const lines = stoppedEarlyLines([t("p3k", "stop", 1, -1), t("p3k", "trail_stop", 9, 3), t("p3k_all", "stop", 0, -1), t("p3k_all", "stop", 2, -1), t("p3k_all", "stop", 5, -1)]);
    expect(lines).toContain("| aligned + optimal entry (p3k) | 2 | 1 | 50.0% | 3.000 |");
    expect(lines).toContain("| all STP trades (p3k_all) | 3 | 2 | 66.7% | -1.000 |");
    expect(lines).toContain("| aligned, no optimal-entry gate (p3k_noopt) | 0 | 0 | n/a | n/a |");
  });
});
