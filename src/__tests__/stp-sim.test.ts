import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { computeStp } from "@/lib/harvester/universe/stp";
import { barDateOf, sliceForSession } from "@/lib/harvester/universe/backfill";
import {
  CONTROL_SEED,
  EXIT_B_CAP,
  EXIT_RULES,
  PRIMARY_EXIT,
  atrSeries,
  barFudge,
  costInR,
  entryLocation,
  entryOnNextBar,
  evaluateGroups,
  groupMetrics,
  htfAlignment,
  matchedControl,
  maxDrawdownR,
  scanSymbol,
  setupOverlap,
  simulateExitA,
  simulateExitB,
  simulateSymbol,
  trailCandidate,
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

describe("entry: the D+1 stop-limit day order (§1e)", () => {
  const next = (o: number, h: number, l: number, c: number) => bars([[o, h, l, c]])[0];
  it("no fill when D+1 never reaches the entry", () => {
    expect(entryOnNextBar(next(100, 104.9, 99, 104), 1, 105, 95)).toEqual({ status: "cancelled" });
    expect(entryOnNextBar(next(100, 101, 95.1, 96), -1, 95, 105)).toEqual({ status: "cancelled" });
  });
  it("fills at the entry when D+1 opens at or below it and trades through; R = entry − stop", () => {
    expect(entryOnNextBar(next(100, 106, 99, 105), 1, 105, 95)).toEqual({ status: "filled", fill: 105, risk: 10 });
    expect(entryOnNextBar(next(105, 106, 104, 105), 1, 105, 95)).toEqual({ status: "filled", fill: 105, risk: 10 });
    expect(entryOnNextBar(next(100, 101, 94, 95), -1, 95, 105)).toEqual({ status: "filled", fill: 95, risk: 10 });
  });
  it("a gap through the entry is no fill (gap_skip)", () => {
    expect(entryOnNextBar(next(108, 110, 107, 109), 1, 105, 95)).toEqual({ status: "gap_skip" });
    expect(entryOnNextBar(next(92, 93, 90, 91), -1, 95, 105)).toEqual({ status: "gap_skip" });
  });
  it("an open past the stop skips the setup", () => {
    expect(entryOnNextBar(next(94, 106, 90, 100), 1, 105, 95)).toEqual({ status: "skipped_gap" });
    expect(entryOnNextBar(next(106, 110, 94, 100), -1, 95, 105)).toEqual({ status: "skipped_gap" });
    expect(entryOnNextBar(undefined, 1, 105, 95)).toEqual({ status: "no_bar" });
  });
});

describe("exit A (reference): stop, 3R limit target, 10-session time exit", () => {
  // fill bar index 0, fill 100, stop 90, R 10, target 130
  const run = (ohlc: Array<[number, number, number, number]>, dir: 1 | -1 = 1, fill = 100, stop = 90) => simulateExitA(bars(ohlc), 0, dir, fill, Math.abs(fill - stop), stop);
  it("targets 3R", () => {
    expect(EXIT_RULES.A.targetR).toBe(3);
    const x = run([[100, 105, 99, 104], [104, 131, 103, 128]]);
    expect(x).toMatchObject({ reason: "target", exit: 130, exitIndex: 1, holding: 1 });
    expect(x.grossR).toBeCloseTo(3, 12);
    expect(run([[100, 105, 99, 104], [104, 125, 103, 118]]).reason).not.toBe("target");
  });
  it("a bar touching both stop and target exits at the stop, including the fill bar", () => {
    expect(run([[100, 135, 89, 110]])).toMatchObject({ reason: "stop", exit: 90, exitIndex: 0, grossR: -1 });
    expect(run([[100, 105, 99, 104], [104, 135, 85, 110]])).toMatchObject({ reason: "stop", exit: 90, exitIndex: 1 });
  });
  it("gaps exit at the open: through the stop (market order) and through the target (limit)", () => {
    expect(run([[100, 105, 99, 104], [85, 88, 80, 86]])).toMatchObject({ reason: "stop_gap", exit: 85, grossR: -1.5 });
    expect(run([[100, 105, 99, 104], [134, 136, 133, 135]])).toMatchObject({ reason: "target", exit: 134 });
    expect(run([[100, 101, 95, 96], [66, 67, 60, 61]], -1, 100, 110)).toMatchObject({ reason: "target", exit: 66 });
  });
  it("time exit at the close of session 10 after the fill; costs 0.10% in R", () => {
    expect(run([[100, 101, 99, 100], ...flat(12, 101)])).toMatchObject({ reason: "time", exitIndex: 10, holding: 10, exit: 101 });
    expect(costInR(100, 10)).toBeCloseTo(0.01, 12);
    // 10 shares ($100 / $10 risk); costs 0.1% of each leg's value: (1000 + 1300) × 0.001 = $2.30
    expect(run([[100, 105, 99, 104], [104, 131, 103, 128]]).netR).toBeCloseTo(3 - 2.3 / 100, 12);
  });
});

describe("exit B (primary): STP management (§1e)", () => {
  // Long: fill 100, stop 90, R 10. Add levels 120, 140, 160 …; 3R = 130.
  const B = (ohlc: Array<[number, number, number, number]>, type = "inside", dir: 1 | -1 = 1, fill = 100, stop = 90) => {
    const b = bars(ohlc);
    const closes = b.map((x) => x.close);
    return simulateExitB(b, closes, atrSeries(b), 0, dir, fill, Math.abs(fill - stop), stop, 0.5, type);
  };
  const quiet = (n: number, p: number): Array<[number, number, number, number]> => Array.from({ length: n }, () => [p, p + 0.5, p - 0.5, p]);

  it("adds at 2R and 4R, each floor(50%) of the current shares; stop moves to the size-weighted breakeven after each", () => {
    // $100 risk / $10 per share = 10 shares. Bar 1 reaches 120 (add 5 → 15), bar 2 reaches 140 (add floor(7.5) = 7 → 22)
    const x = B([[100, 101, 99, 100], [110, 121, 109, 119], [119, 141, 118, 139], ...quiet(3, 139), [139, 139.5, 100, 101]]);
    expect(x.adds).toBe(2);
    expect(x.shares).toBe(10);
    expect(x.sharesAtExit).toBe(22);
    const be = (10 * 100 + 5 * 120 + 7 * 140) / 22;
    expect(x.exit).toBeCloseTo(be, 9);
    // total P&L over all shares at the BE price is 0 before costs; costs are 0.1% of every leg's value
    expect(x.grossR).toBeCloseTo(0, 9);
    const costs = 0.001 * (10 * 100 + 5 * 120 + 7 * 140 + 22 * be);
    expect(x.dollarNet).toBeCloseTo(-costs, 9);
    expect(x.netR).toBeCloseTo(-costs / 100, 9);
    // the initial 10 shares alone, net of their two legs, over the $100 base risk
    expect(x.initialUnitR).toBeCloseTo((10 * (be - 100) - 0.001 * 10 * (100 + be)) / 100, 9);
  });

  it("never adds on the entry day: a fill bar trading through +2R adds nothing; from the next bar the gap rule applies", () => {
    // fill bar runs to 125 (past the 120 add level); next bar opens at 123, above 120: that add is a gap skip
    const x = B([[100, 125, 99.5, 124], [123, 124, 122, 123], [123, 124, 60, 61]]);
    expect(x.adds).toBe(0);
    expect(x.addGapSkips).toBe(1);
    // next bar opens below 120 and trades through it: the add fills at 120 on bar f+1
    const y = B([[100, 125, 99.5, 118], [118, 121, 117, 120], [120, 120.5, 60, 61]]);
    expect(y.adds).toBe(1);
    expect(y.sharesAtExit).toBe(15);
  });

  it("the stop-limit add isn't filled on a gap through it; the next level stays live", () => {
    // bar 1 opens at 125 (above 120): add 1 skipped; bar 2 reaches 140: add 2 fills
    const x = B([[100, 101, 99, 100], [125, 126, 124, 125], [125, 141, 124, 140], [140, 140.5, 60, 61]]);
    expect(x.addGapSkips).toBe(1);
    expect(x.adds).toBe(1);
    expect(x.sharesAtExit).toBe(15);
  });

  it("when a bar touches the stop and an add level, the stop wins and the add doesn't happen", () => {
    const x = B([[100, 101, 99, 100], [100, 125, 85, 110]]);
    expect(x).toMatchObject({ reason: "stop", exit: 90, adds: 0, sharesAtExit: 10 });
    expect(x.grossR).toBeCloseTo(-1, 12);
  });

  it("no trailing and no target before 3R: a strong close below sma10 at 2.5R doesn't move the stop", () => {
    // rise to 125 (2.5R, add at 120 → BE stop 106.67), then a sharp pullback that would trigger pmX if trailing were on
    const up = Array.from({ length: 25 }, (_, i): [number, number, number, number] => [100 + i, 101 + i, 99.5 + i, 100.8 + i]);
    const x = B([...up, [124, 124.5, 108, 108.5], [108.5, 109, 107.5, 108], [108, 108.5, 100, 101]]);
    expect(x.reached3R).toBe(false);
    expect(x.reason).toBe("be_stop");
  });

  it("bar stop once 3R is touched and price is extended (close − sma10 > 1 ATR)", () => {
    // steady 1-point bars, then a jump to 135 (3.5R): extended, so the stop trails to that bar's low − fudge
    const base = Array.from({ length: 30 }, (_, i): [number, number, number, number] => [100 + i * 0.1, 100.6 + i * 0.1, 99.6 + i * 0.1, 100 + i * 0.1]);
    const b = bars([...base, [104, 136, 103.9, 135], [135, 135.2, 120, 121]]);
    const closes = b.map((x) => x.close);
    const atr = atrSeries(b);
    const t = 30;
    expect(closes[t] - (closes.slice(t - 9, t + 1).reduce((s, v) => s + v, 0) / 10)).toBeGreaterThan(atr[t]!);
    // per-bar fudge (Pine): max(0.11 × ATR14[t], 0.02), not the trigger bar's 0.5
    expect(trailCandidate(b, closes, atr, t, 1, 0.5, false)).toBeCloseTo(b[t].low - barFudge(atr[t])!, 12);
    expect(barFudge(atr[t])).toBeCloseTo(Math.max(0.11 * atr[t]!, 0.02), 15);
    expect(barFudge(0.1)).toBe(0.02);
    // a mechanical trade ignores the bar stop: no mX cross here, so no candidate
    expect(trailCandidate(b, closes, atr, t, 1, 0.5, true)).toBeNull();
  });

  it("mX for a mech trade and pmX for an inside trade", () => {
    const up = Array.from({ length: 30 }, (_, i): [number, number, number, number] => [100 + i, 101.5 + i, 99.5 + i, 101 + i]);
    // close drops below sma10 but stays above sma20: pmX fires (inside), mX doesn't (mech)
    const pm = bars([...up, [129, 129.5, 124, 124.5]]);
    const c1 = pm.map((x) => x.close);
    expect(trailCandidate(pm, c1, atrSeries(pm), 30, 1, 0.5, false)).toBeCloseTo(pm[30].low - barFudge(atrSeries(pm)[30])!, 12);
    expect(trailCandidate(pm, c1, atrSeries(pm), 30, 1, 0.5, true)).toBeNull();
    // close collapses through sma20: mX fires for the mech trade
    const mx = bars([...up, [128, 128.5, 100, 100.2]]);
    const c2 = mx.map((x) => x.close);
    expect(trailCandidate(mx, c2, atrSeries(mx), 30, 1, 0.5, true)).toBeCloseTo(mx[30].low - barFudge(atrSeries(mx)[30])!, 12);
  });

  it("the stop never drops below breakeven: a trailing level under BE is ignored", () => {
    // add at 120 → BE 106.67; touch 3R at 131; a pmX level lower than BE must not loosen the stop
    const up = Array.from({ length: 25 }, (_, i): [number, number, number, number] => [100 + i * 0.4, 100.5 + i * 0.4, 99.5 + i * 0.4, 100 + i * 0.4]);
    const x = B([...up, [110, 131, 109.5, 130], [130, 130.5, 101, 102], [102, 103, 50, 51]]);
    expect(x.adds).toBe(1);
    expect(x.reached3R).toBe(true);
    expect(x.exit).toBeGreaterThanOrEqual((10 * 100 + 5 * 120) / 15 - 1e-9);
  });

  it("60-session cap exits at that close; no target exit ever", () => {
    expect(EXIT_B_CAP).toBe(60);
    const x = B([[100, 101, 99, 100], ...quiet(70, 101)]);
    expect(x).toMatchObject({ reason: "time_cap", holding: 60, exit: 101 });
    const far = B([[100, 101, 99, 100], [101, 500, 100, 499], ...quiet(5, 499)]);
    expect(far.reason).not.toBe("target");
  });

  it("shorts mirror: adds below, BE above", () => {
    const x = B([[100, 101, 99, 100], [90, 91, 79, 81], [81, 120, 80, 119]], "inside", -1, 100, 110);
    expect(x.adds).toBe(1); // 80 reached
    expect(x.exit).toBeCloseTo((10 * 100 + 5 * 80) / 15, 9); // BE stop
    expect(x.reason).toBe("be_stop");
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
        swing: {}, finvizBase: null, finvizScreens: [], layerMarket: null, layerSector: null, layerIndustry: null, sizeMult: 1, sizeMultIndustry: 1, sizeMultOpens: 1, sizeMultTrend: 1,
        baseRisk: 100, shares: 10, sharesAtExit: 10, dollarGross: 0, dollarNet: 0, variant, alignment: "aligned" as const, weekUsed: 0.2, monthUsed: 0.2, roomW: 2, adds: 0, addGapSkips: 0, reached3R: false, size: 1, initialUnitR: net(i),
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
  it("49 pre-registered primary groups (13 calendar + 4 rolling + 6 swing + 2 pyramid + 2 base + 22 screens); descriptive groups carry no verdict", () => {
    const res = evaluateGroups(mk(50, () => 0, () => 0));
    expect(res.filter((r) => r.primary)).toHaveLength(49);
    expect(res.filter((r) => r.primary && r.group.startsWith("finviz:F"))).toHaveLength(22);
    expect(res.some((r) => r.group.startsWith("early:"))).toBe(false); // §1f replaced §1d's test
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
    const md = simMarkdownReport(res, { setups: 500, filled: 400, cancelled: 90, gapSkip: 0, sizeSkip: 0, layerNull: 0, skippedGap: 5, skippedOverlap: 5, noBar: 0, noControl: 0 }, { date: "d", commit: "c", exit: "A", symbols: 7 });
    expect(md).toMatch(/Survivorship bias/);
    expect(md).toMatch(/\| inside\+ \| KEEP \|/);
    expect(tradesCsv(trades.slice(0, 1)).split("\n")[0]).toMatch(/^variant,symbol,trigger_date,fill_date,exit_date,direction,type/);
    expect(simExperimentRow(res, { number: 29, date: "d", commit: "c", exit: "A", reportPath: "p", trades: 400 })).toMatch(/^\| 29 \| d \| c \|.*\| 49 \| STP trade sim exit A/);
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
swing: {}, finvizBase: null, finvizScreens: [], layerMarket: null, layerSector: null, layerIndustry: null, sizeMult: 1, sizeMultIndustry: 1, sizeMultOpens: 1, sizeMultTrend: 1,
        baseRisk: 100, shares: 10, sharesAtExit: 10, dollarGross: 0, dollarNet: 0, variant: "rolling", alignment: null, weekUsed: null, monthUsed: null, roomW: null, adds: 0, addGapSkips: 0, reached3R: false, size: 1, initialUnitR: 0, symbol: "S", scanId: d, scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d, dir: 1, type: "inside",
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

describe("§1d entry location vs the normal move", () => {
  // 80 weekdays (16 weeks); each week's bars span a 10-point range (high 110, low 100), so W = 10.
  const weekly = bars(Array.from({ length: 80 }, (): [number, number, number, number] => [105, 110, 100, 105]));
  const days = weekly.map((b) => barDateOf(b)!);

  it("week_used = (fill − lowest low since the week's open) / W, long; mirrored short", () => {
    // trigger on a Wednesday: the fill (Thursday) is in the same week; that week's low so far is 100
    const i = days.findIndex((d, k) => k > 60 && new Date(`${d}T12:00:00Z`).getUTCDay() === 3);
    const long = entryLocation(weekly, i, 104, 1, 2);
    expect(long.weekUsed).toBeCloseTo((104 - 100) / 10, 12);
    const short = entryLocation(weekly, i, 104, -1, 2);
    expect(short.weekUsed).toBeCloseTo((110 - 104) / 10, 12);
    // room to 3R: W × (1 − week_used) / (3 × R)
    expect(long.roomW).toBeCloseTo((10 * (1 - 0.4)) / 6, 12);
  });

  it("uses only completed bars up to the trigger day plus the fill price: a later bar changes nothing", () => {
    const i = 70;
    const a = entryLocation(weekly, i, 104, 1, 2);
    const planted = weekly.map((b, k) => (k > i ? { ...b, high: 1e6, low: 1 } : b));
    expect(entryLocation(planted, i, 104, 1, 2)).toEqual(a);
  });

  it("a fill that opens a new week uses the fill alone for that week (week_used 0)", () => {
    const i = days.findIndex((d, k) => k > 60 && new Date(`${d}T12:00:00Z`).getUTCDay() === 5); // Friday trigger, Monday fill
    expect(entryLocation(weekly, i, 104, 1, 2).weekUsed).toBe(0);
  });

  it("null until 10 completed weeks and 6 completed months exist before the fill", () => {
    expect(entryLocation(weekly, 20, 104, 1, 2).weekUsed).toBeNull();
    expect(entryLocation(weekly, 70, 104, 1, 2).monthUsed).toBeNull(); // 80 weekdays ≈ 4 months
  });

  it("§1f swing groups need rally_used < 0.5 and room_3r ≥ 1, and must beat all trades of their direction", () => {
    const T0 = Date.UTC(2025, 0, 6);
    const mk = (i: number, early: boolean, netR: number): Trade => {
      const d = new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
      const sw = { rallyUsed: early ? 0.3 : 0.8, rallyAge: 0.5, room3R: early ? 1.5 : 0.5, pullbackRatio: 1 };
      return {
        finvizBase: null, finvizScreens: [], layerMarket: null, layerSector: null, layerIndustry: null, sizeMult: 1, sizeMultIndustry: 1, sizeMultOpens: 1, sizeMultTrend: 1,
        baseRisk: 100, shares: 10, sharesAtExit: 10, dollarGross: 0, dollarNet: 0, swing: { "1.5": sw, "2": sw, "3": sw },
        variant: "calendar", alignment: null, weekUsed: null, monthUsed: null, roomW: null, adds: 0, addGapSkips: 0, reached3R: false, size: 1, initialUnitR: netR, symbol: "S", scanId: d,
        scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d, dir: 1, type: "inside", firedRules: [], entry: 1, fill: 1, stop: 0.9, exit: 1,
        risk: 0.1, grossR: netR, netR, reason: "time", holding: 1, controlNetR: 0, regime: null, quarter: "2025Q1",
      };
    };
    const lose = evaluateGroups(Array.from({ length: 800 }, (_, i) => mk(i, i % 2 === 0, i % 2 === 0 ? 0.5 : 1))).find((g) => g.group === "swing:k2:long")!;
    expect(lose.heldOut.trades).toBeGreaterThanOrEqual(MIN_HELDOUT_ROWS);
    expect(lose.verdict).toBe("DROP");
    expect(lose.reason).toMatch(/all trades of its direction/);
    const win = evaluateGroups(Array.from({ length: 800 }, (_, i) => mk(i, i % 2 === 0, i % 2 === 0 ? 1 : 0.5)));
    for (const k of ["1.5", "2", "3"]) expect(win.find((g) => g.group === `swing:k${k}:long`)!.verdict).toBe("KEEP");
  });

  it("descriptive buckets for week_used, month_used and room_w carry no verdict and report the 3R-hit rate", () => {
    const res = evaluateGroups([]);
    const loc = res.filter((g) => g.group.startsWith("loc:"));
    expect(loc).toHaveLength(12);
    // §1f descriptive per k: rally_used 5 + room_3r 2 + rally_age 3 + pullback_ratio 3 = 13 buckets
    expect(res.filter((g) => g.group.startsWith("swing:k2:") && !g.primary)).toHaveLength(13);
    expect(loc.every((g) => !g.primary && g.verdict === null)).toBe(true);
    expect(groupMetrics([]).targetRate).toBeNull();
  });

  it("exit B is primary; exit A is a reference with no verdicts", () => {
    expect(PRIMARY_EXIT).toBe("B");
    const T0 = Date.UTC(2025, 0, 6);
    const t = (i: number): Trade => {
      const d = new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
      return {
swing: {}, finvizBase: null, finvizScreens: [], layerMarket: null, layerSector: null, layerIndustry: null, sizeMult: 1, sizeMultIndustry: 1, sizeMultOpens: 1, sizeMultTrend: 1,
        baseRisk: 100, shares: 10, sharesAtExit: 10, dollarGross: 0, dollarNet: 0, variant: "calendar", alignment: null, weekUsed: null, monthUsed: null, roomW: null, adds: 0, addGapSkips: 0, reached3R: false, size: 1, initialUnitR: 1,
        symbol: "S", scanId: d, scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d, dir: 1, type: "inside", firedRules: [], entry: 1, fill: 1,
        stop: 0.9, exit: 1, risk: 0.1, grossR: 1, netR: 1, reason: "time", holding: 1, controlNetR: 0, regime: null, quarter: "2025Q1",
      };
    };
    const ref = evaluateGroups(Array.from({ length: 800 }, (_, i) => t(i)), { verdicts: false });
    expect(ref.filter((r) => r.primary).every((r) => r.verdict === null && r.reason === "reference exit: no verdict")).toBe(true);
  });
});
