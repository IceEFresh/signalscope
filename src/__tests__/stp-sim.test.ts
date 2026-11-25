import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { computeStp } from "@/lib/harvester/universe/stp";
import { barDateOf, sliceForSession } from "@/lib/harvester/universe/backfill";
import {
  CONTROL_SEED,
  costInR,
  entryOnNextBar,
  evaluateGroups,
  groupMetrics,
  htfAlignment,
  matchedControl,
  maxDrawdownR,
  scanSymbol,
  setupOverlap,
  simulateExit,
  simulateSymbol,
  trailStop,
  type BarInfo,
  type Setup,
  type Trade,
} from "@/lib/eval/stp-sim";
import { computeStpRolling, rollingHtfOpensAt, rollingWindowsFor, ROLLING_WINDOWS } from "@/lib/harvester/universe/stp-rolling";
import { simExperimentRow, simMarkdownReport, tradesCsv } from "@/lib/eval/stp-sim-report";
import { MIN_HELDOUT_ROWS } from "@/lib/eval/rules";

const NOW = new Date("2030-01-01T00:00:00Z");
const amd = parseChartBars(JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8")), NOW);

/** Synthetic weekday bars at 14:30 UTC from OHLC tuples. */
function bars(ohlc: Array<[number, number, number, number]>, start = Date.UTC(2026, 0, 5, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return ohlc.map(([open, high, low, close]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
const flat = (n: number, p = 100): Array<[number, number, number, number]> => Array.from({ length: n }, () => [p, p + 1, p - 1, p]);

describe("entry: the D+1 stop order", () => {
  const next = (o: number, h: number, l: number, c: number) => bars([[o, h, l, c]])[0];
  it("no fill when D+1 never reaches the entry", () => {
    expect(entryOnNextBar(next(100, 104.9, 99, 104), 1, 105, 95)).toEqual({ status: "cancelled" });
    expect(entryOnNextBar(next(100, 101, 95.1, 96), -1, 95, 105)).toEqual({ status: "cancelled" });
  });
  it("normal fill at the entry, R = entry − stop", () => {
    expect(entryOnNextBar(next(100, 106, 99, 105), 1, 105, 95)).toEqual({ status: "filled", fill: 105, risk: 10 });
    expect(entryOnNextBar(next(100, 101, 94, 95), -1, 95, 105)).toEqual({ status: "filled", fill: 95, risk: 10 });
  });
  it("a gap through the entry fills at the open (the worse price)", () => {
    expect(entryOnNextBar(next(108, 110, 107, 109), 1, 105, 95)).toEqual({ status: "filled", fill: 108, risk: 13 });
    expect(entryOnNextBar(next(92, 93, 90, 91), -1, 95, 105)).toEqual({ status: "filled", fill: 92, risk: 13 });
  });
  it("an open past the stop skips the setup", () => {
    expect(entryOnNextBar(next(94, 106, 90, 100), 1, 105, 95)).toEqual({ status: "skipped_gap" });
    expect(entryOnNextBar(next(106, 110, 94, 100), -1, 95, 105)).toEqual({ status: "skipped_gap" });
    expect(entryOnNextBar(undefined, 1, 105, 95)).toEqual({ status: "no_bar" });
  });
});

describe("exit A: stop, 2R target, 10-session time exit", () => {
  // fill bar index 0, fill 100, stop 90, R 10, target 120
  const run = (ohlc: Array<[number, number, number, number]>, dir: 1 | -1 = 1, fill = 100, stop = 90) => {
    const b = bars(ohlc);
    return simulateExit(b, b.map((x) => x.close), 0, dir, fill, Math.abs(fill - stop), stop, 0.5, "A");
  };
  it("target hit", () => {
    const x = run([[100, 105, 99, 104], [104, 121, 103, 118]]);
    expect(x).toMatchObject({ reason: "target", exit: 120, exitIndex: 1, holding: 1 });
    expect(x.grossR).toBeCloseTo(2, 12);
  });
  it("a bar touching both stop and target exits at the stop, including the fill bar", () => {
    expect(run([[100, 125, 89, 110]])).toMatchObject({ reason: "stop", exit: 90, exitIndex: 0, grossR: -1 });
    expect(run([[100, 105, 99, 104], [104, 125, 85, 110]])).toMatchObject({ reason: "stop", exit: 90, exitIndex: 1 });
  });
  it("a gap through the stop exits at the open", () => {
    expect(run([[100, 105, 99, 104], [85, 88, 80, 86]])).toMatchObject({ reason: "stop_gap", exit: 85, grossR: -1.5 });
  });
  it("time exit at the close of session 10 after the fill", () => {
    const x = run([[100, 101, 99, 100], ...flat(12, 101)]);
    expect(x).toMatchObject({ reason: "time", exitIndex: 10, holding: 10, exit: 101 });
  });
  it("short mirrored", () => {
    expect(run([[100, 101, 95, 96], [96, 97, 79, 81]], -1, 100, 110)).toMatchObject({ reason: "target", exit: 80 });
  });
  it("costs are 0.10% of price, converted into R", () => {
    expect(costInR(100, 10)).toBeCloseTo(0.01, 12);
    const x = run([[100, 105, 99, 104], [104, 121, 103, 118]]);
    expect(x.netR).toBeCloseTo(2 - 0.01, 12);
  });
});

describe("exit B: STP trailing exits on synthetic bars", () => {
  // 30 rising bars so SMAs exist and trendDirection is +1, then the rule bar at t = 30.
  const rising = Array.from({ length: 30 }, (_, i): [number, number, number, number] => [100 + i, 101.5 + i, 99.5 + i, 101 + i]);
  const closes = (b: DailyBar[]) => b.map((x) => x.close);

  it("bar stop: trendDirection ≥ 1 and close > prior low trails the stop to low[t−1] − fudge", () => {
    const b = bars(rising);
    const t = 29;
    expect(trailStop(b, closes(b), t, 1, 50, 0.5)).toBeCloseTo(b[t - 1].low - 0.5, 12);
  });
  it("mX: close crossing below sma20 moves the stop to low[t] − fudge", () => {
    const b = bars([...rising, [128, 128.5, 100, 100.2]]); // collapse through sma20
    const t = 30;
    const s = trailStop(b, closes(b), t, 1, 50, 0.5);
    expect(s).toBeCloseTo(Math.max(b[t].low - 0.5, 50), 12);
    expect(s).toBeGreaterThan(50);
  });
  it("pmX: close crossing below sma10 after an up trend moves the stop to low[t] − fudge", () => {
    const b = bars([...rising, [129, 129.5, 124, 124.5]]); // below sma10, above sma20
    const t = 30;
    // close 124.5 < low[t−1] 128.5, so the bar stop doesn't apply; close stays above sma20, so mX doesn't either
    expect(trailStop(b, closes(b), t, 1, 50, 0.5)).toBeCloseTo(b[t].low - 0.5, 12);
  });
  it("the stop never loosens, and a short mirrors it", () => {
    const b = bars(rising);
    expect(trailStop(b, closes(b), 29, 1, 1e6, 0.5)).toBe(1e6);
    const falling = bars(Array.from({ length: 30 }, (_, i): [number, number, number, number] => [200 - i, 201.5 - i, 199.5 - i, 199 - i]));
    expect(trailStop(falling, closes(falling), 29, -1, 1e6, 0.5)).toBeCloseTo(falling[28].high + 0.5, 12);
  });
  it("exit B uses a 3R target, a 20-session time exit, and reports a trailed stop as trail_stop", () => {
    const b = bars([...rising, [130, 131, 129.5, 130.5], [130.5, 131, 100, 101]]);
    const x = simulateExit(b, closes(b), 29, 1, 129, 5, 124, 0.5, "B");
    expect(x.reason).toBe("trail_stop");
    const t = bars([[100, 101, 99, 100], ...flat(25, 101)]);
    expect(simulateExit(t, closes(t), 0, 1, 100, 10, 90, 0.5, "B")).toMatchObject({ reason: "time", holding: 20 });
  });
});

describe("one position per ticker", () => {
  it("a trigger while a trade is open is skipped and counted; a trigger on the exit day is allowed", () => {
    const b = bars([...flat(70), ...flat(30, 100)]);
    const info: BarInfo[] = b.map((x) => ({ date: barDateOf(x)!, trigger: 0, triggerRolling: 0, fudge: 0.1 }));
    const mk = (i: number): Setup => ({ variant: "calendar", htf: 1, symbol: "X", date: info[i].date, i, dir: 1, type: "inside", firedRules: ["inside+"], entry: 100.5, stop: 98.9, fudge: 0.1 });
    // all fill (high 101 ≥ 100.5); exit A on flat bars = time exit 10 sessions after the fill
    const r = simulateSymbol("X", b, "A", { scanned: { setups: [mk(70), mk(72), mk(81), mk(82)], rollingSetups: [], info } });
    expect(r.counts).toMatchObject({ setups: 4, filled: 2, skippedOverlap: 2 });
    // 70 fills on 71 and exits at the close of 81: 72 is skipped, 81 (the exit day) is allowed, 82 is skipped
    expect(r.trades.map((t) => t.scanId)).toEqual([info[70].date, info[81].date]);
  });
});

describe("matched control", () => {
  const b = bars(Array.from({ length: 80 }, (_, i): [number, number, number, number] => [100 + (i % 3), 103 + (i % 3), 98 + (i % 3), 101 + (i % 3)]));
  const info: BarInfo[] = b.map((x) => ({ date: barDateOf(x)!, trigger: 0, triggerRolling: 0, fudge: 0.2 }));
  const setup: Setup = { variant: "calendar", htf: 1, symbol: "X", date: info[40].date, i: 40, dir: 1, type: "inside", firedRules: [], entry: 103.2, stop: 97.8, fudge: 0.2 };
  const closes = b.map((x) => x.close);
  it("is deterministic with the seed, stays within ±20 non-trigger sessions, and changes with another seed", () => {
    const a = matchedControl(setup, b, closes, info, "A");
    expect(matchedControl(setup, b, closes, info, "A")).toEqual(a);
    expect(a).not.toBeNull();
    expect(Math.abs(a!.i - 40)).toBeLessThanOrEqual(20);
    expect(a!.i).not.toBe(40);
    const picks = new Set(Array.from({ length: 6 }, (_, k) => matchedControl(setup, b, closes, info, "A", CONTROL_SEED + k + 1)?.i));
    expect(picks.size).toBeGreaterThan(1);
  });
  it("never uses a trigger session", () => {
    const onlyTriggers = info.map((x, i) => (i === 45 ? x : { ...x, trigger: 1 }));
    expect(matchedControl(setup, b, closes, onlyTriggers, "A")?.i).toBe(45);
  });
});

describe("no look-ahead", () => {
  const dates = amd.map((x) => barDateOf(x)!);
  const k = dates.length - 8;
  const D = dates[k];
  it("scanSymbol's slice equals the P3-0g slice, so the trigger on D is computeStp on bars ≤ D", () => {
    const { info } = scanSymbol("AMD", amd);
    expect(info[k].trigger).toBe(computeStp(sliceForSession(amd, D)).trigger);
  });
  it("a planted future bar can't change whether a trigger fires on D", () => {
    const planted = amd.map((x, i) => (i > k ? { ...x, open: 1e4, high: 2e4, low: 1, close: 1e4 } : x));
    const a = scanSymbol("AMD", amd).info.slice(0, k + 1);
    const b = scanSymbol("AMD", planted).info.slice(0, k + 1);
    expect(b).toEqual(a);
  });
  it("the entry decision reads only D+1's own bar", () => {
    const d1 = amd[k + 1];
    expect(entryOnNextBar(d1, 1, d1.high - 0.01, d1.low - 1).status).toBe("filled");
    expect(entryOnNextBar(d1, 1, d1.high + 0.01, d1.low - 1).status).toBe("cancelled");
  });
});

describe("verdicts", () => {
  const T0 = Date.UTC(2025, 0, 6);
  /** 400 trigger dates × 1 trade; netR and controlNetR fixed per trade. */
  const mk = (n: number, net: (i: number) => number, ctrl: (i: number) => number, type = "inside", dir: 1 | -1 = 1, variant: "calendar" | "rolling" = "calendar"): Trade[] =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
      return {
        variant, alignment: "aligned" as const,
        symbol: `S${i % 7}`, scanId: d, scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d, dir, type, firedRules: [],
        entry: 1, fill: 1, stop: 0.9, exit: 1, risk: 0.1, grossR: net(i), netR: net(i), reason: "time" as const, holding: 1,
        controlNetR: ctrl(i), regime: null, quarter: "2025Q1",
      };
    });
  const verdict = (trades: Trade[], g: string) => evaluateGroups(trades).find((r) => r.group === g)!;

  it("KEEP: positive net expectancy above the control in the held-out split and in 2+ folds, with 100+ held-out trades", () => {
    const r = verdict(mk(400, (i) => (i % 3 === 0 ? -1 : 0.8), () => 0), "inside+");
    expect(r.heldOut.trades).toBeGreaterThanOrEqual(MIN_HELDOUT_ROWS);
    expect(r).toMatchObject({ verdict: "KEEP" });
    expect(r.foldsPassed).toBeGreaterThanOrEqual(2);
  });
  it("DROP when the trigger doesn't beat its control, even with positive expectancy", () => {
    expect(verdict(mk(400, () => 0.2, () => 0.3), "all").verdict).toBe("DROP");
  });
  it("INSUFFICIENT under 100 held-out trades", () => {
    const r = verdict(mk(200, () => 0.5, () => 0), "all");
    expect(r.heldOut.trades).toBeLessThan(MIN_HELDOUT_ROWS);
    expect(r.verdict).toBe("INSUFFICIENT");
  });
  it("17 pre-registered primary groups (13 calendar + 4 rolling); descriptive groups carry no verdict", () => {
    const res = evaluateGroups(mk(50, () => 0, () => 0));
    expect(res.filter((r) => r.primary)).toHaveLength(17);
    expect(res.filter((r) => !r.primary).every((r) => r.verdict === null)).toBe(true);
  });
  it("metrics: profit factor, median, max drawdown in R", () => {
    const t = mk(4, (i) => [1, -1, 2, -3][i], () => 0);
    const m = groupMetrics(t);
    expect(m.profitFactor).toBeCloseTo(3 / 4, 12);
    expect(m.medianR).toBeCloseTo(0, 12);
    expect(maxDrawdownR(t)).toBeCloseTo(3, 12); // peak 2 after +1 −1 +2, then −3 → −1
  });
  it("report, CSV and log row", () => {
    const trades = mk(400, (i) => (i % 3 === 0 ? -1 : 0.8), () => 0);
    const res = evaluateGroups(trades);
    const md = simMarkdownReport(res, { setups: 500, filled: 400, cancelled: 90, skippedGap: 5, skippedOverlap: 5, noBar: 0, noControl: 0 }, { date: "d", commit: "c", exit: "A", symbols: 7 });
    expect(md).toMatch(/Survivorship bias/);
    expect(md).toMatch(/\| inside\+ \| KEEP \|/);
    expect(tradesCsv(trades.slice(0, 1)).split("\n")[0]).toMatch(/^variant,symbol,trigger_date,fill_date,exit_date,direction,type/);
    expect(simExperimentRow(res, { number: 29, date: "d", commit: "c", exit: "A", reportPath: "p", trades: 400 })).toMatch(/^\| 29 \| d \| c \|.*\| 17 \| STP trade sim exit A/);
  });
});

describe("step 1c: rolling opens (5/20 stocks, 7/30 crypto)", () => {
  // 60 bars with known opens: open = 100 + i, close = 200 (far above every open) except where set.
  const mkBars = (n = 60) => bars(Array.from({ length: n }, (_, i): [number, number, number, number] => [100 + i, 205, 99 + i, 200]));

  it("the window comes from the asset class: stocks 5/20, crypto 7/30", () => {
    expect(rollingWindowsFor("stock")).toEqual({ week: 5, month: 20 });
    expect(rollingWindowsFor(null)).toEqual({ week: 5, month: 20 });
    expect(rollingWindowsFor("crypto")).toEqual({ week: 7, month: 30 });
  });

  it("uses exactly the open of bar t−4 and t−19 (stocks) or t−6 and t−29 (crypto), today counted as session 1", () => {
    const b = mkBars();
    const t = 40;
    // close between the two opens: below the t−4 ("week") open, above the t−19 ("month") open → +0.5 (stpHtfOpens)
    b[t] = { ...b[t], close: (b[t - 4].open! + b[t - 19].open!) / 2 };
    expect(b[t].close).toBeLessThan(b[t - 4].open!);
    expect(b[t].close).toBeGreaterThan(b[t - 19].open!);
    expect(rollingHtfOpensAt(b, t, ROLLING_WINDOWS.stock)).toBe(0.5);
    // move the close just above bar t−4's open: now above both → +1; the bar t−5 open is not used
    b[t] = { ...b[t], close: b[t - 4].open! + 0.01 };
    expect(rollingHtfOpensAt(b, t, ROLLING_WINDOWS.stock)).toBe(1);
    b[t - 5] = { ...b[t - 5], open: 1e6 };
    expect(rollingHtfOpensAt(b, t, ROLLING_WINDOWS.stock)).toBe(1);
    // crypto reads t−6 and t−29
    b[t] = { ...b[t], close: b[t - 6].open! - 0.01 };
    expect(rollingHtfOpensAt(b, t, ROLLING_WINDOWS.crypto)).toBe(0.5);
  });

  it("window edge: null when the month window reaches before bar 0, defined exactly at the edge", () => {
    const b = mkBars(25);
    expect(rollingHtfOpensAt(b, 18, ROLLING_WINDOWS.stock)).toBeNull(); // t−19 = −1
    expect(rollingHtfOpensAt(b, 19, ROLLING_WINDOWS.stock)).toBe(1); // t−19 = 0
    expect(rollingHtfOpensAt(b, 24, ROLLING_WINDOWS.crypto)).toBeNull(); // t−29 < 0
  });

  it("inside fires on the rolling trend; a U-turn reads the rolling trend at t−3", () => {
    const b = mkBars(60);
    const t = 59;
    // inside candle on t, close above both rolling opens
    b[t] = { open: 200, high: 204, low: 160, close: 201, volume: 1, time: b[t].time }; // inside bar t−1 (high 205, low 157)
    expect(computeStpRolling(b).triggerType).toBe("inside");
    expect(computeStpRolling(b).trigger).toBe(1);
    expect(computeStpRolling(b.slice(0, 50)).trigger).toBeNull(); // < 51 bars, as computeStp
    // BUTN on t: previous bar down (well offered), t closes up inside; trend read at t−3
    const u = mkBars(60);
    u[57] = { open: 250, high: 260, low: 150, close: 255, volume: 1, time: u[57].time };
    u[58] = { open: 240, high: 250, low: 140, close: 141, volume: 1, time: u[58].time }; // lower high, lower low, closes below prior low → well offered (−1)
    u[59] = { open: 142, high: 249, low: 139, close: 150, volume: 1, time: u[59].time }; // BUTN shape
    const r = computeStpRolling(u);
    expect(r.firedRules).toContain("butn+");
    // flip the rolling trend at t−3 (bar 56) to below both opens: the U-turn no longer fires
    u[56] = { ...u[56], close: 50 };
    expect(computeStpRolling(u).firedRules).not.toContain("butn+");
  });

  it("scanSymbol keeps calendar and rolling setups apart, and the overlap counts both / only one", () => {
    const { setups, rollingSetups } = scanSymbol("AMD", amd);
    expect(setups.every((s) => s.variant === "calendar")).toBe(true);
    expect(rollingSetups.every((s) => s.variant === "rolling" && ["inside", "butn", "brutn"].includes(s.type))).toBe(true);
    const mk = (date: string, type: string, variant: "calendar" | "rolling"): Setup =>
      ({ variant, htf: 1, symbol: "X", date, i: 0, dir: 1, type, firedRules: [], entry: 1, stop: 0, fudge: 0 });
    expect(
      setupOverlap(
        [mk("d1", "inside", "calendar"), mk("d2", "butn", "calendar"), mk("d3", "mech1", "calendar")],
        [mk("d1", "inside", "rolling"), mk("d4", "inside", "rolling")],
      ),
    ).toEqual({ both: 1, calendarOnly: 1, rollingOnly: 1 }); // mech1 isn't part of the comparison
  });

  it("rolling trades are judged only in the 4 rolling groups, never in the calendar ones", () => {
    const T0 = Date.UTC(2025, 0, 6);
    const trades = Array.from({ length: 50 }, (_, i): Trade => {
      const d = new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
      return {
        variant: "rolling", alignment: null, symbol: "S", scanId: d, scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d, dir: 1, type: "inside",
        firedRules: [], entry: 1, fill: 1, stop: 0.9, exit: 1, risk: 0.1, grossR: 0, netR: 0, reason: "time", holding: 1, controlNetR: 0, regime: null, quarter: "2025Q1",
      };
    });
    const res = evaluateGroups(trades);
    expect(res.find((r) => r.group === "rolling:inside+")!.all.trades).toBe(50);
    expect(res.find((r) => r.group === "inside+")!.all.trades).toBe(0);
    expect(res.find((r) => r.group === "all")!.all.trades).toBe(0);
  });
});

describe("step 1b: HTF alignment, descriptive only", () => {
  it("aligned = htf × direction of +1, against = −1, anything else partial", () => {
    expect(htfAlignment(1, 1)).toBe("aligned");
    expect(htfAlignment(-1, -1)).toBe("aligned");
    expect(htfAlignment(1, -1)).toBe("against");
    expect(htfAlignment(0.5, 1)).toBe("partial");
    expect(htfAlignment(0, -1)).toBe("partial");
    expect(htfAlignment(null, 1)).toBeNull();
  });
  it("mech1, mech2 and egop are split by alignment with no verdicts", () => {
    const res = evaluateGroups([]);
    const g = res.filter((r) => r.group.startsWith("htf:"));
    expect(g.map((r) => r.group)).toEqual([
      "htf:mech1:aligned", "htf:mech1:partial", "htf:mech1:against",
      "htf:mech2:aligned", "htf:mech2:partial", "htf:mech2:against",
      "htf:egop:aligned", "htf:egop:partial", "htf:egop:against",
    ]);
    expect(g.every((r) => !r.primary && r.verdict === null)).toBe(true);
  });
});
