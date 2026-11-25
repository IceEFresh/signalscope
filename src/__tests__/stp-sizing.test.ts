import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { confirmedBy, MIN_LEGS, swingEntry, swingProfile, zigzag, SWING_KS } from "@/lib/harvester/universe/swings";
import { etfStates, layerState, marketVote, pyramidLayers, sizeMult, sizeMultWithIndustry, type EtfState } from "@/lib/harvester/universe/pyramid";
import { atrSeries, BASE_RISK_DOLLARS, combinedSize, EXIT_RULES, initialShares, portfolioStats, simulateExit, simulateExitB, simulateSymbol, stockFactor, type BarInfo, type Setup, type Trade } from "@/lib/eval/stp-sim";

/** Weekday bars at 14:30 UTC from closes: open = previous close, high/low = close ± 1. */
function fromCloses(closes: number[], start = Date.UTC(2024, 0, 1, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return closes.map((c, i) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open: i ? closes[i - 1] : c, high: c + 1, low: c - 1, close: c, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);

/** A clean zigzag: 20 flat bars, then 8 cycles of +25 over 10 bars and −15 over 6 bars. */
function swingBars(cycles = 8): DailyBar[] {
  const closes: number[] = Array(20).fill(100);
  let p = 100;
  for (let c = 0; c < cycles; c++) {
    closes.push(...ramp(p, p + 25, 10));
    p += 25;
    closes.push(...ramp(p, p - 15, 6));
    p -= 15;
  }
  return fromCloses(closes);
}

describe("§1f zigzag swings", () => {
  const bars = swingBars();
  const atr = atrSeries(bars);

  it("finds alternating confirmed pivots at each k, at the leg extremes", () => {
    for (const k of SWING_KS) {
      const piv = zigzag(bars, k);
      expect(piv.length).toBeGreaterThanOrEqual(12);
      for (let n = 1; n < piv.length; n++) expect(piv[n].kind).not.toBe(piv[n - 1].kind);
      for (const p of piv) expect(p.price).toBe(p.kind === "high" ? bars[p.i].high : bars[p.i].low);
    }
  });

  it("no pivot is confirmed before the reversal bar (look-ahead)", () => {
    for (const k of SWING_KS) {
      for (const p of zigzag(bars, k)) {
        const thr = k * atr[p.i]!;
        const move = (j: number) => (p.kind === "high" ? p.price - bars[j].low : bars[j].high - p.price);
        expect(move(p.confirmedAt)).toBeGreaterThanOrEqual(thr);
        for (let j = p.i + 1; j < p.confirmedAt; j++) expect(move(j)).toBeLessThan(thr);
      }
    }
  });

  it("is causal: run on bars ≤ t it gives exactly the pivots confirmed by t", () => {
    const full = zigzag(bars, 2);
    for (const t of [80, 120, 150]) {
      expect(zigzag(bars.slice(0, t + 1), 2)).toEqual(confirmedBy(full, t));
    }
  });

  it("a higher k confirms later (or never) than a lower k", () => {
    const first = (k: number) => zigzag(bars, k)[0].confirmedAt;
    expect(first(3)).toBeGreaterThanOrEqual(first(1.5));
  });

  it("profile: medians and 75th percentiles of rallies and pullbacks, in ATR, % and bars", () => {
    const t = bars.length - 1;
    const piv = confirmedBy(zigzag(bars, 2), t);
    const prof = swingProfile(bars, t, 2);
    const ups: number[] = [];
    for (let n = 1; n < piv.length; n++) if (piv[n - 1].kind === "low") ups.push((piv[n].price - piv[n - 1].price) / piv[n - 1].price);
    ups.sort((a, b) => a - b);
    const q = (xs: number[], qq: number) => { const pos = (xs.length - 1) * qq; const lo = Math.floor(pos); return xs[lo] + (xs[Math.ceil(pos)] - xs[lo]) * (pos - lo); };
    expect(prof.rally).not.toBeNull();
    expect(prof.rally!.n).toBe(ups.length);
    expect(prof.rally!.medianPct).toBeCloseTo(q(ups, 0.5), 12);
    expect(prof.rally!.p75Pct).toBeCloseTo(q(ups, 0.75), 12);
    expect(prof.rally!.medianBars).toBe(10); // each rally runs low → high over 10 bars
    expect(prof.pullback!.medianBars).toBe(6);
  });

  it(`null with fewer than ${MIN_LEGS} legs of a kind`, () => {
    const short = swingBars(2);
    const prof = swingProfile(short, short.length - 1, 2);
    expect(prof.rally).toBeNull();
    expect(swingEntry(short, short.length - 1, 120, 2, 1, 2).rallyUsed).toBeNull();
  });

  it("entry scores on a worked example; shorts mirrored", () => {
    const t = bars.length - 4; // inside the final pullback
    const piv = confirmedBy(zigzag(bars, 2), t);
    const prof = swingProfile(bars, t, 2);
    const low = [...piv].reverse().find((p) => p.kind === "low")!;
    const fill = low.price + 6;
    const risk = 2;
    const e = swingEntry(bars, t, fill, risk, 1, 2);
    expect(e.rallyUsed).toBeCloseTo(6 / low.atr / prof.rally!.medianAtr, 12);
    expect(e.room3R).toBeCloseTo((prof.rally!.medianAtr * low.atr - 6) / (3 * risk), 12);
    expect(e.rallyAge).toBeCloseTo((t + 1 - low.i) / prof.rally!.medianBars, 12);
    const prevHigh = piv[piv.indexOf(low) - 1];
    expect(e.pullbackRatio).toBeCloseTo((prevHigh.price - low.price) / prevHigh.atr / prof.pullback!.medianAtr, 12);

    const high = [...piv].reverse().find((p) => p.kind === "high")!;
    const s = swingEntry(bars, t, high.price - 4, risk, -1, 2);
    expect(s.rallyUsed).toBeCloseTo(4 / high.atr / prof.pullback!.medianAtr, 12); // down-legs are the move
    expect(s.room3R).toBeCloseTo((prof.pullback!.medianAtr * high.atr - 4) / (3 * risk), 12);
  });
});

describe("§1g Power Pyramid layers", () => {
  const st = (opens: number | null, trend: 1 | -1 | 0 | null): EtfState => ({ opens, trend });

  it("a layer agrees only when opens AND trend agree; opens agreeing with trend down is mixed", () => {
    expect(layerState(st(1, 1), 1)).toBe("agree");
    expect(layerState(st(1, -1), 1)).toBe("mixed");
    expect(layerState(st(0.5, 1), 1)).toBe("mixed");
    expect(layerState(st(-1, -1), 1)).toBe("disagree");
    expect(layerState(st(1, -1), 1, "opens")).toBe("agree"); // opens-only variant
    expect(layerState(st(1, -1), 1, "trend")).toBe("disagree"); // trend-only variant
    expect(layerState(null, 1)).toBeNull();
  });

  it("shorts are mirrored", () => {
    expect(layerState(st(-1, -1), -1)).toBe("agree");
    expect(layerState(st(1, 1), -1)).toBe("disagree");
  });

  it("market layer = 2-of-3 majority of SPY, QQQ, DIA", () => {
    expect(marketVote(["agree", "agree", "disagree"])).toBe("agree");
    expect(marketVote(["disagree", "disagree", "agree"])).toBe("disagree");
    expect(marketVote(["agree", "mixed", "disagree"])).toBe("mixed");
    expect(marketVote(["agree", null, "agree"])).toBe("agree");
    expect(marketVote([null, null, null])).toBeNull();
  });

  it("size 1 / 0.5 / 0.25 from market and sector; mixed and missing are not disagreements", () => {
    expect(sizeMult("agree", "agree")).toBe(1);
    expect(sizeMult("mixed", "mixed")).toBe(1);
    expect(sizeMult(null, null)).toBe(1);
    expect(sizeMult("disagree", "agree")).toBe(0.5);
    expect(sizeMult("agree", "disagree")).toBe(0.5);
    expect(sizeMult("disagree", "disagree")).toBe(0.25);
    expect(sizeMultWithIndustry("disagree", "disagree", "disagree")).toBe(0.125);
  });

  it("a null industry (unmapped) leaves the rule unchanged and shows as null", () => {
    const up = new Map([["2026-01-05", st(1, 1)]]);
    const l = pyramidLayers({ market: [up, up, up], sector: up, industry: null }, "2026-01-05", 1);
    expect(l).toMatchObject({ market: "agree", sector: "agree", industry: null, sizeMult: 1, sizeMultIndustry: 1 });
    const down = new Map([["2026-01-05", st(-1, -1)]]);
    expect(pyramidLayers({ market: [down, down, up], sector: down, industry: null }, "2026-01-05", 1).sizeMult).toBe(0.25);
  });

  it("ETF states use bars dated ≤ D only: planted later bars change nothing for D", () => {
    const b = fromCloses(ramp(100, 160, 80));
    const D = barDateOf(b[60])!;
    const planted = b.map((x, i) => (i > 60 ? { ...x, open: 1, high: 2, low: 0.5, close: 1 } : x));
    expect(etfStates(planted).get(D)).toEqual(etfStates(b).get(D));
    expect(etfStates(b).get(D)).toEqual({ opens: 1, trend: 1 });
  });
});

describe("§1h fixed dollar risk", () => {
  it("initial shares = floor($100 × size_mult / per-share risk)", () => {
    expect(initialShares(100, 3)).toBe(33);
    expect(initialShares(100, 0.1)).toBe(1000); // no float under-count
    expect(initialShares(50, 3)).toBe(16);
    expect(initialShares(25, 30)).toBe(0);
  });

  it("an add that rounds to 0 shares is no add; a short's dollar P&L is mirrored", () => {
    // $15 base risk, $10 per share → 1 share; add step 20; price reaches the adds at 120 and 140, but floor(0.5 × 1) = 0
    const b = fromCloses([100, 100, 121, 141, 141, 60]);
    const one = simulateExitB(b, b.map((x) => x.close), atrSeries(b), 0, 1, 100, 10, 90, 0.5, "inside", 15, 20);
    expect(one.shares).toBe(1);
    expect(one.adds).toBe(0);
    expect(one.sharesAtExit).toBe(1);
    // with 3 shares the first add is floor(1.5) = 1
    const three = simulateExitB(b, b.map((x) => x.close), atrSeries(b), 0, 1, 100, 10, 90, 0.5, "inside", 30, 20);
    expect(three.shares).toBe(3);
    expect(three.adds).toBeGreaterThanOrEqual(1);
    expect(three.sharesAtExit).toBe(3 + 1 + 2); // +1 at 120 (floor 1.5), +2 at 140 (floor 2)
    // short: 10 shares, price falls 10 → +$100 gross before costs, 1R
    const sb = fromCloses([100, 99, 95, 92, 90, 89, 115]);
    const s = simulateExitB(sb, sb.map((x) => x.close), atrSeries(sb), 0, -1, 100, 10, 110, 0.5, "inside", 100, 20);
    expect(s.shares).toBe(10);
    expect(s.dollarGross).toBeCloseTo(10 * (100 - s.exit), 9);
    expect(s.netR).toBeCloseTo(s.dollarNet / 100, 12);
  });

  it("a wide stop gives 0 shares: no trade, counted as size_skip by pattern; size_mult scales the risk", () => {
    const b = fromCloses(Array.from({ length: 90 }, () => 100));
    const info: BarInfo[] = b.map((x) => ({ date: barDateOf(x)!, trigger: 0, triggerRolling: 0, fudge: 0.1 }));
    const setup = (i: number, stop: number, type: string): Setup => ({ variant: "calendar", htf: 1, symbol: "X", date: info[i].date, i, dir: 1, type, firedRules: [], entry: 100.5, stop, fudge: 0.1 });
    const r = simulateSymbol("X", b, "B", { scanned: { setups: [setup(70, -100, "mech1"), setup(75, 98.5, "inside")], rollingSetups: [], info } });
    expect(r.counts.sizeSkip).toBe(1);
    expect(r.sizeSkipByType).toEqual({ mech1: 1 });
    expect(r.trades).toHaveLength(1);
    // §1j: stock factor 0.5 (no MA stack on this setup) × pyramid 1 = 0.5 → $200 × 0.5 = $100 → 50 shares at $2 risk
    expect(r.trades[0]).toMatchObject({ stockFactor: 0.5, sizeCombined: 0.5, baseRisk: 100, shares: 50, floorHit: false });
    const down = new Map(info.map((x) => [x.date, { opens: -1, trend: -1 as const }]));
    const q = simulateSymbol("X", b, "B", { scanned: { setups: [setup(75, 98.5, "inside")], rollingSetups: [], info }, pyramid: { market: [down, down, down], sector: down, industry: null } });
    // stock 0.5 × pyramid 0.25 = 0.125, floored to 0.25 → $200 × 0.25 = $50 → 25 shares
    expect(q.trades[0]).toMatchObject({ sizeMult: 0.25, sizeCombined: 0.25, floorHit: true, baseRisk: 50, shares: 25, layerMarket: "disagree", layerSector: "disagree" });
    // no layer data at all → mixed, size 1, counted
    expect(r.counts.layerNull).toBe(1);
  });

  it("account view: total dollar P&L, peak open positions and open risk on any day", () => {
    const t = (fill: string, exit: string, dollarNet: number): Trade =>
      ({ fillDate: fill, exitDate: exit, dollarNet, shares: 10, risk: 2, symbol: "S" }) as unknown as Trade;
    const p = portfolioStats([t("2025-01-02", "2025-01-10", 50), t("2025-01-03", "2025-01-06", -20), t("2025-01-06", "2025-01-08", 10), t("2025-01-09", "2025-01-12", 5)], 10);
    expect(p.dollarNet).toBe(45);
    expect(p.peakOpenPositions).toBe(3); // on 2025-01-06 (the second trade exits that day, the third fills)
    expect(p.peakOpenRisk).toBe(60);
    expect(p.peakDate).toBe("2025-01-06");
    expect(p.tradesPerSession).toBeCloseTo(0.4, 12);
  });
});

describe("§1j sizing and adds as in Chris's Pine script", () => {
  it("stock factor: full size only with opens +1 AND MAs stacked the trade's way; shorts mirrored", () => {
    expect(stockFactor(1, 1, 1)).toBe(1);
    expect(stockFactor(1, -1, 1)).toBe(0.5); // opens +1 but MAs stacked bearish on a long
    expect(stockFactor(1, 0, 1)).toBe(0.5);
    expect(stockFactor(0.5, 1, 1)).toBe(0.5);
    expect(stockFactor(-1, -1, -1)).toBe(1);
    expect(stockFactor(-1, 1, -1)).toBe(0.5);
    expect(stockFactor(null, 1, 1)).toBe(0.5);
  });

  it("size = stock × pyramid, floored at 0.25; risk is $200 × size", () => {
    expect(combinedSize(0.5, 0.25)).toBe(0.25);
    expect(combinedSize(0.5, 0.5)).toBe(0.25);
    expect(combinedSize(1, 0.5)).toBe(0.5);
    expect(combinedSize(1, 1)).toBe(1);
    expect(BASE_RISK_DOLLARS).toBe(200);
    expect(initialShares(BASE_RISK_DOLLARS * combinedSize(1, 1), 10)).toBe(20);
    expect(initialShares(BASE_RISK_DOLLARS * combinedSize(0.5, 0.25), 10)).toBe(5);
  });

  // Steady rise of 2 per bar with a 3-point range: ATR14 settles near 3, far from R = 10.
  const rising = () => fromCloses(Array.from({ length: 80 }, (_, i) => 100 + 2 * i));

  it("exit B adds at 2 × ATR14 of the trigger bar, then 4 × ATR, not 2R", () => {
    const b = rising();
    const closes = b.map((x) => x.close);
    const atr = atrSeries(b);
    const f = 40;
    const fill = b[f - 1].high; // just above the trigger bar
    const x = simulateExit(b, closes, atr, f, 1, fill, 10, fill - 10, 0.5, "inside", "B", 200);
    const a = atr[f - 1]!;
    expect(a).not.toBeCloseTo(5, 0); // 2 × ATR is not 2R (20)
    expect(x.addPrices[0]).toBeCloseTo(fill + 2 * a, 9);
    expect(x.addPrices[1]).toBeCloseTo(fill + 4 * a, 9);
  });

  it("the choppy variant (exit C) adds every 1 × ATR and trails from 2R", () => {
    const b = rising();
    const closes = b.map((x) => x.close);
    const atr = atrSeries(b);
    const f = 40;
    const fill = b[f - 1].high;
    const c = simulateExit(b, closes, atr, f, 1, fill, 10, fill - 10, 0.5, "inside", "C", 200);
    const a = atr[f - 1]!;
    expect(c.addPrices[0]).toBeCloseTo(fill + a, 9);
    expect(c.addPrices[1]).toBeCloseTo(fill + 2 * a, 9);
    expect(EXIT_RULES.C.targetR).toBe(2);
    // a trade that touches 2.5R and pulls back: C (trail from 2R) can trail; B (from 3R) can't, so B never trails here
    // fill 109 (bar 40's high), R 10: 2R = 129, 3R = 139. Peak high 132 is past 2R but short of 3R, then a pullback.
    const pull = fromCloses([...Array.from({ length: 41 }, (_, i) => 100 + 0.2 * i), 108, 112, 116, 121, 128, 131, 125, 118, 112, 100, 90, 80]);
    const pc = pull.map((x) => x.close);
    const pa = atrSeries(pull);
    const ff = 41;
    const e = pull[ff - 1].high;
    const B = simulateExitB(pull, pc, pa, ff, 1, e, 10, e - 10, 0.5, "inside", 200, 1000, 3);
    const C = simulateExitB(pull, pc, pa, ff, 1, e, 10, e - 10, 0.5, "inside", 200, 1000, 2);
    expect(B.reached3R).toBe(false);
    expect(B.reason).not.toBe("trail_stop");
    expect(C.reached3R).toBe(true); // the variant's trail threshold (2R) was touched
    expect(C.reason).toBe("trail_stop");
    expect(C.exit).toBeGreaterThan(B.exit);
  });
});
