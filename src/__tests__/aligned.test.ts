import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { weekStart } from "@/lib/harvester/universe/bar-features";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { ROLLING_WINDOWS } from "@/lib/harvester/universe/stp-rolling";
import type { Pivot } from "@/lib/harvester/universe/swings";
import { alignmentAt, forDir, marketAlignment, masSign, opensSign, optimalEntry, p3kSize } from "@/lib/eval/aligned";
import { gateCounts, layerStates, p3kMember, type P3kCandidate } from "@/lib/eval/aligned-sim";
import { liveStpKeys, LIVE_P3K_KEYS } from "@/lib/harvester/universe/stp-live";
import { isLiveStpKey } from "@/lib/health/harvest-health";

/** Weekday bars from closes (open = close − 1 unless given), starting Monday 2025-01-06. */
function series(closes: number[], opens?: (k: number) => number): DailyBar[] {
  let t = Date.UTC(2025, 0, 6, 14, 30) / 1000;
  return closes.map((c, k) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const o = opens ? opens(k) : c - 1;
    const b = { open: o, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5, close: c, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
/** 210 integer closes 100..309: aligned long on every measure at the last bar. */
const up = Array.from({ length: 210 }, (_, k) => 100 + k);
const I = up.length - 1;

describe("opens green: each of the 4 opens at its edge", () => {
  const b0 = series(up);
  const dates = b0.map((b) => barDateOf(b)!);
  const firstOf = (key: (d: string) => string) => dates.findIndex((d) => key(d) === key(dates[I]));
  const idx = {
    month: firstOf((d) => d.slice(0, 7)),
    week: firstOf(weekStart),
    rolling20: I - 19,
    rolling5: I - 4,
  };
  it("all four below the close → +1", () => {
    expect(opensSign(b0, I)).toBe(1);
  });
  for (const [name, j] of Object.entries(idx)) {
    it(`${name} open equal to the close → not green (0)`, () => {
      const b = series(up, (k) => (k === j ? up[I] : up[k] - 1));
      expect(opensSign(b, I)).toBe(0);
      const below = series(up, (k) => (k === j ? up[I] - 0.01 : up[k] - 1));
      expect(opensSign(below, I)).toBe(1);
    });
  }
  it("crypto uses rolling 7 / 30", () => {
    const b = series(up, (k) => (k === I - 6 ? up[I] : up[k] - 1));
    expect(opensSign(b, I, ROLLING_WINDOWS.stock)).toBe(1); // bar I−6 isn't a stock rolling open
    expect(opensSign(b, I, ROLLING_WINDOWS.crypto)).toBe(0);
    const b30 = series(up, (k) => (k === I - 29 ? up[I] : up[k] - 1));
    expect(opensSign(b30, I, ROLLING_WINDOWS.crypto)).toBe(0);
  });
});

describe("MAs stacked and sloped", () => {
  it("a rising series is +1 and its mirror −1", () => {
    expect(masSign(up, I)).toBe(1);
    expect(masSign(up.map((c) => 1000 - c), I)).toBe(-1);
  });
  it("each MA at its stacking edge: close = sma10, and sma10 = sma20 etc. break the stack", () => {
    // close equal to sma10: the last close is the mean of the 9 before it
    const c = [...up];
    c[I] = c.slice(I - 9, I).reduce((s, v) => s + v, 0) / 9;
    expect(masSign(c, I)).toBe(0);
    // flat closes over the last 60 bars collapse sma10 = sma20 = sma50 (and the close)
    const flat = up.map((v, k) => (k > I - 60 ? 400 : v));
    expect(masSign(flat, I)).toBe(0);
  });
  it("an MA flat over exactly 5 sessions isn't rising (sma200), a hair higher is", () => {
    // sma200 now (bars 10..209) equals 5 sessions ago (5..204) when closes 5..9 match closes 205..209
    const flat200 = up.map((v, k) => (k >= 5 && k <= 9 ? up[k + 200] : v));
    expect(masSign(flat200, I)).toBe(0);
    const rising200 = up.map((v, k) => (k >= 5 && k <= 9 ? up[k + 200] - 1 : v));
    expect(masSign(rising200, I)).toBe(1);
  });
  it("too few bars for sma200 + slope → null, and the layer is mixed and incomplete", () => {
    expect(masSign(up.slice(0, 204), 203)).toBeNull();
    const b = series(up.slice(0, 204));
    expect(alignmentAt(b, b.map((x) => x.close), 203, 1)).toMatchObject({ state: "mixed", complete: false });
  });
});

describe("layers", () => {
  it("aligned / against / mixed per direction", () => {
    const b = series(up);
    const closes = b.map((x) => x.close);
    expect(alignmentAt(b, closes, I, 1)).toMatchObject({ state: "aligned", opens: "aligned", mas: "aligned", complete: true });
    expect(alignmentAt(b, closes, I, -1).state).toBe("against");
    expect(forDir("aligned", -1)).toBe("against");
    expect(forDir("mixed", -1)).toBe("mixed");
  });
  it("the market is a 2-of-3 vote of SPY, QQQ, DIA", () => {
    expect(marketAlignment(["aligned", "aligned", "against"])).toBe("aligned");
    expect(marketAlignment(["aligned", "mixed", "against"])).toBe("mixed");
    expect(marketAlignment(["against", null, "against"])).toBe("against");
    expect(marketAlignment([null, null, null])).toBeNull();
    const m = (s: "aligned" | "against") => new Map([["2025-01-06", { state: s, opens: s, mas: s, complete: true }]]);
    expect(layerStates({ industry: null, sector: m("aligned"), market: [m("aligned"), m("aligned"), m("against")] }, "2025-01-06", -1)).toEqual({ industry: null, sector: "against", market: "against" });
  });
  it("look-ahead: bars after i don't change the alignment at i", () => {
    const b = series([...up, 50, 40, 30]);
    const closes = b.map((x) => x.close);
    const cut = b.slice(0, I + 1);
    expect(alignmentAt(b, closes, I, 1)).toEqual(alignmentAt(cut, cut.map((x) => x.close), I, 1));
  });
});

describe("optimal entry", () => {
  // 5 bars inside one week starting at bar 0: no SMAs, no period opens (their period may start before the data)
  const b = series([100, 100, 100, 100, 100]);
  const closes = b.map((x) => x.close);
  const low = (price: number): Pivot => ({ i: 1, price, kind: "low", confirmedAt: 3, atr: 2 });
  it("the stop exactly 0.5 ATR beyond the nearest support is optimal; further isn't", () => {
    expect(optimalEntry(b, closes, 4, 1, 100, 94, 2, [low(95)])).toMatchObject({ optimal: true, support: 95, stopBeyondAtr: 0.5 });
    expect(optimalEntry(b, closes, 4, 1, 100, 93.99, 2, [low(95)]).optimal).toBe(false);
    // the nearest support below the entry is the highest one
    expect(optimalEntry(b, closes, 4, 1, 100, 96, 2, [low(90), low(96.5)])).toMatchObject({ optimal: true, support: 96.5 });
  });
  it("no support, a pivot not yet confirmed, or no ATR → not optimal; shorts mirrored", () => {
    expect(optimalEntry(b, closes, 4, 1, 100, 94, 2, []).optimal).toBe(false);
    expect(optimalEntry(b, closes, 4, 1, 100, 94, 2, [{ ...low(95), confirmedAt: 5 }]).optimal).toBe(false);
    expect(optimalEntry(b, closes, 4, 1, 100, 94, null, [low(95)]).optimal).toBe(false);
    const high = (price: number): Pivot => ({ i: 1, price, kind: "high", confirmedAt: 3, atr: 2 });
    expect(optimalEntry(b, closes, 4, -1, 100, 106, 2, [high(105)]).optimal).toBe(true);
    expect(optimalEntry(b, closes, 4, -1, 100, 106.01, 2, [high(105)]).optimal).toBe(false);
  });
});

describe("size", () => {
  it("halves per mixed, against or missing layer, × 0.5 for an event, floor 0.25", () => {
    expect(p3kSize(["aligned", "aligned", "aligned"], false)).toBe(1);
    expect(p3kSize(["aligned", "mixed", "aligned"], false)).toBe(0.5);
    expect(p3kSize(["against", "mixed", "aligned"], false)).toBe(0.25);
    expect(p3kSize(["against", "mixed", null], false)).toBe(0.25);
    expect(p3kSize(["aligned", "aligned", "aligned"], true)).toBe(0.5);
    expect(p3kSize(["aligned", "mixed", "aligned"], true)).toBe(0.25);
  });
});

describe("candidates and gates", () => {
  const cand = (g: Partial<P3kCandidate["p3k"]>, dir: 1 | -1 = 1): P3kCandidate =>
    ({ dir, p3k: { finviz: true, aligned: true, opensAligned: true, masAligned: true, earnings: true, rr: true, optimal: true, ...g } }) as unknown as P3kCandidate;
  it("memberships and the gate counts, in order", () => {
    const c = [cand({}), cand({ optimal: false }), cand({ aligned: false, masAligned: false }), cand({ finviz: false }), cand({ rr: false })];
    expect(c.map((x) => p3kMember.p3k(x))).toEqual([true, false, false, false, false]);
    expect(c.map((x) => p3kMember.p3k_noopt(x))).toEqual([true, true, false, false, false]);
    expect(c.map((x) => p3kMember.p3k_opens(x))).toEqual([true, false, true, false, false]);
    expect(c.map((x) => p3kMember.p3k_mas(x))).toEqual([true, false, false, false, false]);
    expect(gateCounts(c)).toEqual({ triggers: 5, finviz: 4, aligned: 3, earnings: 3, rr: 2, optimal: 1 });
  });
  it("live keys are logged for stock rows and excluded from candidates and health families", () => {
    const keys = liveStpKeys(series(up), undefined, { assetClass: "stock", events: [] });
    for (const k of LIVE_P3K_KEYS) {
      expect(keys).toHaveProperty(k);
      expect(isLiveStpKey(k)).toBe(true);
    }
    expect(keys.align_stock).toBe("long");
    expect(keys.align_market).toBeNull(); // no layer data
    expect(keys.p3k_size_long).toBe(0.25); // three unknown layers: 0.125 floored
    expect(keys.p3k_candidate).toBeNull(); // no trigger
  });
});

describe("P3-0k end to end on a saved chart (smoke)", () => {
  it("candidates and every population simulate through the P3-0j simulator with P3-0k options", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { parseChartBars } = await import("@/lib/harvester/universe/bar-metrics");
    const { scanSymbol } = await import("@/lib/eval/stp-sim");
    const { zigzag } = await import("@/lib/harvester/universe/swings");
    const { simulateFunnelSymbol } = await import("@/lib/eval/funnel-sim");
    const { P3K_RUNS, p3kCandidates, p3kSimOptions } = await import("@/lib/eval/aligned-sim");
    const amd = parseChartBars(JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8")), new Date("2030-01-01T00:00:00Z"));
    const input = { symbol: "AMD", bars: amd, scanned: scanSymbol("AMD", amd), pivots: zigzag(amd, 2), pyramid: { market: [null, null, null], sector: null, industry: null } };
    const ctx = { sessions: [], events: [] };
    const cands = p3kCandidates(input, { industry: null, sector: null, market: [null, null, null] }, ctx);
    expect(cands.every((c) => c.p3k.aligned === false)).toBe(true); // 63 bars: no sma200, never aligned
    for (const [p, a] of P3K_RUNS) {
      const r = simulateFunnelSymbol(input, cands, p, a, ctx, p3kSimOptions(p));
      if (p !== "p3k_all") expect(r.trades).toHaveLength(0);
      for (const t of r.trades) expect(t.p3kLayerSize).toBe(0.25); // three unknown layers: 0.125 floored
    }
  });
});
