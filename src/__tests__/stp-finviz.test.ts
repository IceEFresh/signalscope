import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { BACKFILL_SCREEN_TESTS, passingScreens, screensOn, SCREEN_DIRS } from "@/lib/harvester/universe/finviz-screens";
import { atrSeries, evaluateGroups, type Trade } from "@/lib/eval/stp-sim";

/** Weekday bars from [open, high, low, close, volume]. */
function bars(rows: Array<[number, number, number, number, number]>, start = Date.UTC(2025, 0, 6, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return rows.map(([open, high, low, close, volume]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume, time: t };
    t += 86_400;
    return b;
  });
}
/** 80 flat bars at 100: range 3.2 (ATR ≈ 3.2 > $1.50), volume 3M (> 2M): the base filter passes. */
const flat = (n = 80, p = 100, vol = 3_000_000): Array<[number, number, number, number, number]> => Array.from({ length: n }, () => [p, p + 1.6, p - 1.6, p, vol]);
const on = (rows: Array<[number, number, number, number, number]>) => {
  const b = bars(rows);
  return screensOn(b, b.length - 1, atrSeries(b));
};

describe("§1i base filter", () => {
  it("needs 3-month average volume > 2M and ATR14 > $1.50", () => {
    expect(on([...flat(), [100, 101.6, 98.4, 100, 3e6]]).base).toBe(true);
    expect(on([...flat(80, 100, 1_900_000), [100, 101.6, 98.4, 100, 3e6]]).base).toBe(false);
    const tight: Array<[number, number, number, number, number]> = Array.from({ length: 81 }, () => [100, 100.5, 99.5, 100, 3e6]);
    expect(on(tight).base).toBe(false); // ATR ≈ 1
  });
  it("too little history gives null, not false", () => {
    expect(on(flat(30)).base).toBeNull();
  });
});

describe("§1i screen edges", () => {
  it("change from open: ≥ 2% passes F27, 1.99% doesn't", () => {
    expect(on([...flat(), [100, 103, 99, 102, 3e6]]).screens.F27).toBe(true);
    expect(on([...flat(), [100, 103, 99, 101.99, 3e6]]).screens.F27).toBe(false);
    expect(on([...flat(), [100, 101, 97, 98, 3e6]]).screens.F11).toBe(true);
    expect(on([...flat(), [100, 101, 97, 98.01, 3e6]]).screens.F11).toBe(false);
  });
  it("new 20-day high: the bar's high must be the max of D−19..D, including exactly equal", () => {
    const rows = flat();
    expect(on([...rows, [100, 101.6, 99, 102, 3e6]]).screens.F25).toBe(true); // high equals the 20-day max (101.6), close > prior, +2%
    expect(on([...rows, [100, 101.5, 99, 102, 3e6]]).screens.F25).toBe(false);
    // a higher high on the 20th bar back (D−19) still counts against D; on D−20 it doesn't
    const withOld = (back: number) => rows.map((r, i) => (i === rows.length - back ? ([r[0], 110, r[2], r[3], r[4]] as typeof r) : r));
    expect(on([...withOld(19), [100, 101.6, 99, 102, 3e6]]).screens.F25).toBe(false);
    expect(on([...withOld(20), [100, 101.6, 99, 102, 3e6]]).screens.F25).toBe(true);
  });
  it("close crossed below sma20 (F03): down day, crossing from at/above to below, with sma50 > sma20", () => {
    // 60 bars at 110, then 20 bars at 100: sma50 > sma20; the last bar before D closes above sma20, D closes below
    const rows: Array<[number, number, number, number, number]> = [
      ...Array.from({ length: 60 }, (): [number, number, number, number, number] => [110, 111.6, 108.4, 110, 3e6]),
      ...Array.from({ length: 19 }, (): [number, number, number, number, number] => [100, 101.6, 98.4, 100, 3e6]),
      [100, 106, 99, 105, 3e6],
    ];
    const r = on([...rows, [105, 105.5, 99, 100, 3e6]]);
    expect(r.screens.F03).toBe(true);
    expect(on([...rows, [105, 106, 103, 104, 3e6]]).screens.F03).toBe(false); // still above sma20
  });
  it("short float unknown gives null, never false; earnings screens are null without dates", () => {
    const r = on([...flat(), [100, 103, 99, 102, 9e6]]);
    for (const id of ["F07", "F16", "F17", "F18", "F19", "F01", "F02"] as const) expect(r.screens[id]).toBeNull();
    const b = bars([...flat(), [100, 103, 99, 102, 9e6]]);
    const live = screensOn(b, b.length - 1, atrSeries(b), { shortFloat: 0.25, daysSinceEarnings: 1 });
    expect(live.screens.F16).toBe(true);
    expect(live.screens.F07).toBe(true); // relvol 3 > 1.5 and short float 25%
    expect(live.screens.F02).toBe(true);
    expect(live.screens.F01).toBe(true);
  });
  it("relvol uses the 63 sessions before D: F28 needs more than 2×", () => {
    expect(on([...flat(), [100, 101.6, 98.4, 100, 6_000_001]]).screens.F28).toBe(true);
    expect(on([...flat(), [100, 101.6, 98.4, 100, 6_000_000]]).screens.F28).toBe(false);
  });
  it("every screen also requires the base filter", () => {
    const low = flat(80, 100, 1_000_000);
    expect(on([...low, [100, 103, 99, 102, 3e6]]).screens.F27).toBe(false);
  });
  it("no look-ahead: a planted D+1 bar changes nothing on D", () => {
    const b = bars([...flat(), [100, 103, 99, 102, 3e6], [50, 500, 1, 400, 9e9]]);
    const atr = atrSeries(b);
    const d = screensOn(b, b.length - 2, atr);
    const clean = bars([...flat(), [100, 103, 99, 102, 3e6]]);
    expect(d).toEqual(screensOn(clean, clean.length - 1, atrSeries(clean)));
    expect(passingScreens(d)).toContain("F27");
  });
});

describe("§1i pre-registered comparisons", () => {
  it("22 backfill screen tests: 20 one-direction OHLCV screens plus F28 long and short", () => {
    expect(BACKFILL_SCREEN_TESTS).toHaveLength(22);
    expect(BACKFILL_SCREEN_TESTS.filter((t) => t.id === "F28")).toHaveLength(2);
    expect(BACKFILL_SCREEN_TESTS.find((t) => t.id === "F14")!.dir).toBe(-1); // up 2% in a downtrend: short
    expect(BACKFILL_SCREEN_TESTS.find((t) => t.id === "F21")!.dir).toBe(1); // down 2% in an uptrend: long
    expect(SCREEN_DIRS.F01).toBe("both");
    expect(BACKFILL_SCREEN_TESTS.some((t) => ["F01", "F02", "F07", "F16"].includes(t.id))).toBe(false);
  });

  const T0 = Date.UTC(2025, 0, 6);
  const trade = (i: number, extra: Partial<Trade>): Trade => {
    const d = new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
    return {
      finvizBase: true, finvizScreens: [], swing: {}, layerMarket: null, layerSector: null, layerIndustry: null, sizeMult: 1, sizeMultIndustry: 1,
      sizeMultOpens: 1, sizeMultTrend: 1, baseRisk: 100, shares: 10, sharesAtExit: 10, dollarGross: 0, dollarNet: 0, variant: "calendar",
      alignment: null, weekUsed: null, monthUsed: null, roomW: null, adds: 0, addGapSkips: 0, reached3R: false, size: 1, initialUnitR: 0, symbol: "S",
      scanId: d, scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d, dir: 1, type: "inside", firedRules: [], entry: 1, fill: 1, stop: 0.9,
      exit: 1, risk: 0.1, grossR: 0, netR: 0, reason: "time", holding: 1, controlNetR: 0, regime: null, quarter: "2025Q1", ...extra,
    };
  };

  it("a screen with fewer than 30 trades in a fold is reported, not judged", () => {
    // 900 long trades; F27 only on the newest third: well over 100 held out, but the early folds have none
    const ts = Array.from({ length: 900 }, (_, i) => trade(i, { finvizScreens: i >= 600 ? ["F27"] : [], netR: i >= 600 ? 1 : 0 }));
    const r = evaluateGroups(ts).find((g) => g.group === "finviz:F27:long")!;
    expect(r.heldOut.trades).toBeGreaterThanOrEqual(100);
    expect(r.folds.some((f) => f.trades < 30)).toBe(true);
    expect(r.verdict).toBe("INSUFFICIENT");
    expect(r.reason).toMatch(/reported, not judged/);
  });

  it("a screen with enough trades in every fold is judged against all trades of its direction", () => {
    const ts = Array.from({ length: 900 }, (_, i) => trade(i, { finvizScreens: i % 2 === 0 ? ["F27"] : [], netR: i % 2 === 0 ? 1 : 0.2 }));
    expect(evaluateGroups(ts).find((g) => g.group === "finviz:F27:long")!.verdict).toBe("KEEP");
    expect(evaluateGroups(ts).find((g) => g.group === "finviz:base:long")!.verdict).toBe("DROP"); // base = all trades here, so it can't beat itself
  });

  it("§1g groups are NOT_RUN when the run has no sector profiles", () => {
    const ts = Array.from({ length: 900 }, (_, i) => trade(i, { layerMarket: "agree", layerSector: "agree", netR: 1 }));
    const res = evaluateGroups(ts, { notRun: [{ prefix: "pyramid:", reason: "no sector/industry profiles this run (DB unavailable)" }] });
    for (const g of res.filter((r) => r.primary && r.group.startsWith("pyramid:"))) expect(g).toMatchObject({ verdict: "NOT_RUN" });
    expect(res.find((r) => r.group === "all")!.verdict).not.toBe("NOT_RUN");
  });
});
