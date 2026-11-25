import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { confirmedBy, MIN_LEGS, swingEntry, swingProfile, zigzag, SWING_KS } from "@/lib/harvester/universe/swings";
import { etfStates, layerState, marketVote, pyramidLayers, sizeMult, sizeMultWithIndustry, type EtfState } from "@/lib/harvester/universe/pyramid";
import { atrSeries, initialShares, portfolioStats, simulateExitB, simulateSymbol, type BarInfo, type Setup, type Trade } from "@/lib/eval/stp-sim";

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
    // $15 base risk, $10 per share → 1 share; price reaches the 2R add at 120 and 4R at 140, but floor(0.5 × 1) = 0
    const b = fromCloses([100, 100, 121, 141, 141, 60]);
    const one = simulateExitB(b, b.map((x) => x.close), atrSeries(b), 0, 1, 100, 10, 90, 0.5, "inside", 15);
    expect(one.shares).toBe(1);
    expect(one.adds).toBe(0);
    expect(one.sharesAtExit).toBe(1);
    // with 3 shares the first add is floor(1.5) = 1
    const three = simulateExitB(b, b.map((x) => x.close), atrSeries(b), 0, 1, 100, 10, 90, 0.5, "inside", 30);
    expect(three.shares).toBe(3);
    expect(three.adds).toBeGreaterThanOrEqual(1);
    expect(three.sharesAtExit).toBe(3 + 1 + 2); // +1 at 120 (floor 1.5), +2 at 140 (floor 2)
    // short: 10 shares, price falls 10 → +$100 gross before costs, 1R
    const sb = fromCloses([100, 99, 95, 92, 90, 89, 115]);
    const s = simulateExitB(sb, sb.map((x) => x.close), atrSeries(sb), 0, -1, 100, 10, 110, 0.5, "inside", 100);
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
    expect(r.trades[0]).toMatchObject({ baseRisk: 100, shares: 50 }); // $100 / $2 risk
    // market and sector both disagree → size 0.25 → $25 → 12 shares
    const down = new Map(info.map((x) => [x.date, { opens: -1, trend: -1 as const }]));
    const q = simulateSymbol("X", b, "B", { scanned: { setups: [setup(75, 98.5, "inside")], rollingSetups: [], info }, pyramid: { market: [down, down, down], sector: down, industry: null } });
    expect(q.trades[0]).toMatchObject({ sizeMult: 0.25, baseRisk: 25, shares: 12, layerMarket: "disagree", layerSector: "disagree" });
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
