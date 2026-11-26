import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { ROLLING_WINDOWS } from "@/lib/harvester/universe/stp-rolling";
import type { ScreenResult } from "@/lib/harvester/universe/finviz-screens";
import type { Pivot, SwingProfile } from "@/lib/harvester/universe/swings";
import { zigzag } from "@/lib/harvester/universe/swings";
import { buildAddQty, maOrderAt, monthlyAndRolling20Green, opensV2, p3k3Halvings, p3k3Size, passingNamedScreens, roomEarly } from "@/lib/eval/aligned-v2";
import { atrSeries, simulateExitB, type Setup } from "@/lib/eval/stp-sim";
import { optimalEntry } from "@/lib/eval/aligned";
import { p3kCandidates, p3kMember } from "@/lib/eval/aligned-sim";
import { gateCountsByVariant } from "@/lib/eval/aligned-v2-sim";
import { liveStpKeys, LIVE_P3K3_KEYS } from "@/lib/harvester/universe/stp-live";
import { isLiveStpKey } from "@/lib/health/harvest-health";

function weekdayBars(rows: Array<[number, number, number, number]>, volume = 3e6, start = Date.UTC(2025, 0, 6, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return rows.map(([open, high, low, close]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume, time: t };
    t += 86_400;
    return b;
  });
}

describe("MA gate: either order, ties fail", () => {
  const up = Array.from({ length: 260 }, (_, k) => 100 + k);
  it("close > sma20 > sma50 > sma200 passes as 20>50", () => {
    expect(maOrderAt(up, up.length - 1, 1)).toEqual({ pass: true, order: "20>50" });
  });
  it("close > sma50 > sma20 > sma200 passes as 50>20", () => {
    // a 20-session dip pulls sma20 under sma50; a jump puts the close back above both
    const c = [...up.slice(0, 230), ...Array(29).fill(300), 380];
    const r = maOrderAt(c, c.length - 1, 1);
    expect(r).toEqual({ pass: true, order: "50>20" });
  });
  it("sma20 = sma50 fails (strict); a close below either fails; shorts mirrored", () => {
    const flat = Array(260).fill(100);
    expect(maOrderAt(flat, 259, 1)).toEqual({ pass: false, order: null });
    const below = [...up.slice(0, 259), 340]; // close 340 under sma20 (~349)
    expect(maOrderAt(below, 259, 1).pass).toBe(false);
    expect(maOrderAt(up.map((v) => 1000 - v), 259, -1)).toEqual({ pass: true, order: "20>50" });
  });
  it("look-ahead: bars after i don't change the result at i", () => {
    expect(maOrderAt([...up, 1, 1, 1], 259, 1)).toEqual(maOrderAt(up, 259, 1));
  });
});

describe("opens gate: weekly OR rolling-5", () => {
  // two weeks from Monday 2025-01-06; i = 8 (Thursday of week 2): weekly open = bar 5, rolling-5 open = bar 4
  const rows = (weekOpen: number, roll5Open: number): Array<[number, number, number, number]> =>
    Array.from({ length: 10 }, (_, k) => {
      const o = k === 5 ? weekOpen : k === 4 ? roll5Open : 100;
      return [o, Math.max(o, 100) + 1, Math.min(o, 100) - 1, 100];
    });
  it("either alone passes; neither fails", () => {
    expect(opensV2(weekdayBars(rows(99, 101)), 8, 1)).toBe(true); // weekly green only
    expect(opensV2(weekdayBars(rows(101, 99)), 8, 1)).toBe(true); // rolling-5 green only
    expect(opensV2(weekdayBars(rows(101, 101)), 8, 1)).toBe(false);
    expect(opensV2(weekdayBars(rows(100, 100)), 8, 1)).toBe(false); // equal isn't green
    expect(opensV2(weekdayBars(rows(101, 101)), 8, -1)).toBe(true); // short mirrored
  });
  it("crypto uses rolling 7", () => {
    const r = Array.from({ length: 10 }, (_, k): [number, number, number, number] => [k === 2 ? 99 : 101, 102, 98, 100]);
    expect(opensV2(weekdayBars(r), 8, 1, ROLLING_WINDOWS.crypto)).toBe(true); // bar 8 − 6 = 2
    expect(opensV2(weekdayBars(r), 8, 1, ROLLING_WINDOWS.stock)).toBe(false);
  });
});

describe("named screen gate", () => {
  const sc = (on: string[], nulls: string[] = []): ScreenResult =>
    ({ base: true, screens: new Proxy({}, { get: (_, k: string) => (on.includes(k) ? true : nulls.includes(k) ? null : false) }) }) as unknown as ScreenResult;
  it("at least one screen in the trade direction; F18/F19 null on the backfill don't count", () => {
    expect(passingNamedScreens(sc(["F26"]), 1)).toEqual(["F26"]);
    expect(passingNamedScreens(sc(["F10"]), 1)).toEqual([]); // a short screen doesn't count for a long
    expect(passingNamedScreens(sc(["F10", "F28"]), -1)).toEqual(["F28", "F10"]);
    expect(passingNamedScreens(sc([], ["F18", "F19"]), 1)).toEqual([]);
    expect(passingNamedScreens(sc(["F27"]), 1)).toEqual([]); // not one of Chris's named screens
  });
});

describe("size", () => {
  const all = { monthlyR20Green: true, sector: "aligned" as const, market: "aligned" as const, industry: "aligned" as const };
  it("monthly or rolling-20 not green halves once; industry halves only with data", () => {
    expect(p3k3Size(all, false)).toBe(1);
    expect(p3k3Size({ ...all, monthlyR20Green: false }, false)).toBe(0.5);
    expect(p3k3Size({ ...all, industry: null }, false)).toBe(1); // no industry data: neutral
    expect(p3k3Size({ ...all, industry: "mixed" }, false)).toBe(0.5);
    expect(p3k3Size({ ...all, sector: null }, false)).toBe(0.5); // sector / market missing still halves (P3-0k definition)
  });
  it("4 halvings plus the event floor at 0.25", () => {
    const worst = { monthlyR20Green: false, sector: "against" as const, market: "mixed" as const, industry: "against" as const };
    expect(p3k3Halvings(worst)).toBe(4);
    expect(p3k3Size(worst, true)).toBe(0.25);
  });
  it("monthly + rolling-20 green needs both", () => {
    const rows = Array.from({ length: 30 }, (_, k): [number, number, number, number] => [100, 102, 98, k === 29 ? 101 : 100]);
    const b = weekdayBars(rows);
    expect(monthlyAndRolling20Green(b, 29, 1)).toBe(true); // close 101 > monthly open 100 and rolling-20 open 100
    b[10] = { ...b[10], open: 101.5 }; // rolling-20 open (bar 29 − 19 = 10) above the close
    expect(monthlyAndRolling20Green(b, 29, 1)).toBe(false);
  });
});

describe("room to 3R early in the leg", () => {
  const prof = (median: number, p75 = median + 1): SwingProfile => ({
    rally: { n: 5, medianAtr: median, p75Atr: p75, medianPct: 0, p75Pct: 0, medianBars: 5, p75Bars: 6 } as never,
    pullback: { n: 5, medianAtr: median, p75Atr: p75, medianPct: 0, p75Pct: 0, medianBars: 5, p75Bars: 6 } as never,
  });
  const pivot = (kind: "high" | "low", i: number, price: number, confirmedAt: number): Pivot => ({ i, price, kind, confirmedAt, atr: 2 });
  // Bars 1–4 have lows of 96 (bar 1) and 99; a confirmed swing high on bar 0 ends the prior leg
  const bars = weekdayBars(Array.from({ length: 5 }, (_, k): [number, number, number, number] => [100, 101, k === 1 ? 96 : 99, 100]));
  const high0 = pivot("high", 0, 105, 1);
  // ATR 2; lowest low since the swing high 96; entry 100 → leg so far 2 ATR; risk 2 (stop 98) → needed 3 ATR
  it("room left at exactly 3R passes; just under fails", () => {
    expect(roomEarly(bars, 4, 1, 100, 98, 2, [high0], () => prof(5))).toMatchObject({ pass: true, legSoFar: 2, roomLeft: 3, needed: 3, rallyUsed: 0.4 });
    expect(roomEarly(bars, 4, 1, 100, 98, 2, [high0], () => prof(4.99)).pass).toBe(false);
    expect(roomEarly(bars, 4, 1, 100, 98, 2, [high0], () => prof(4.99, 6), "p75").pass).toBe(true);
  });
  it("no swing profile → no candidate; no confirmed opposite swing by D → no candidate; shorts mirrored", () => {
    expect(roomEarly(bars, 4, 1, 100, 98, 2, [high0], () => ({ rally: null, pullback: null }))).toMatchObject({ pass: false, hasProfile: false });
    expect(roomEarly(bars, 4, 1, 100, 98, 2, [{ ...high0, confirmedAt: 9 }], () => prof(5))).toMatchObject({ pass: false, hasProfile: true });
    // Shorts: highest high since the last confirmed swing low (highs 101, bar 2 at 104)
    const sb = weekdayBars(Array.from({ length: 5 }, (_, k): [number, number, number, number] => [100, k === 2 ? 104 : 101, 99, 100]));
    expect(roomEarly(sb, 4, -1, 100, 102, 2, [pivot("low", 0, 95, 1)], () => prof(5))).toMatchObject({ pass: true, legSoFar: 2, roomLeft: 3 });
  });
  it("a fresh leg starting 1 bar after a confirmed swing high is measured from its own low, not the prior confirmed swing low", () => {
    // Prior leg: swing low 80 (bar 1), swing high 110 (bar 5, confirmed bar 7). New leg: low 104 on bar 6, entry 108 on D = bar 9
    const rows = Array.from({ length: 10 }, (_, k): [number, number, number, number] => {
      if (k === 1) return [82, 84, 80, 83];
      if (k === 5) return [108, 110, 107, 109];
      if (k === 6) return [107, 108, 104, 106];
      return [106, 109, 105, 107];
    });
    const b = weekdayBars(rows);
    const piv = [pivot("low", 1, 80, 3), pivot("high", 5, 110, 7)];
    const r = roomEarly(b, 9, 1, 108, 106, 2, piv, () => prof(5));
    expect(r.legSoFar).toBe(2); // (108 − 104) ÷ 2, not (108 − 80) ÷ 2 = 14
    expect(r).toMatchObject({ pass: true, roomLeft: 3, needed: 3 });
    // Causal: the new low isn't a confirmed pivot yet, and a bar after D can't move it
    const later = [...b, { ...b[9], low: 90 }];
    expect(roomEarly(later, 9, 1, 108, 106, 2, piv, () => prof(5)).legSoFar).toBe(2);
  });
});

describe("build to layer size (descriptive)", () => {
  it("adds the larger of the normal 50% add and the top-up to the day's layer size; only the top-up is capped at full", () => {
    expect(buildAddQty(25, 100, 100)).toBe(75); // ¼ start, the day's layers say full: top-up 75 > 50% (12)
    expect(buildAddQty(10, 12, 100)).toBe(5); // 50% is larger than the top-up of 2
    expect(buildAddQty(80, 100, 100)).toBe(40); // 50% (40) beats the top-up (20): the normal add still applies
    expect(buildAddQty(100, 100, 100)).toBe(50); // at full, the 50% add continues as in the primary
    expect(buildAddQty(20, 150, 100)).toBe(80); // a layer size above full is capped: top-up to 100, not 150
    expect(buildAddQty(150, 100, 100)).toBe(75); // beyond full: no top-up, the 50% add only
  });
  it("the stop moves to the size-weighted breakeven after a build add", () => {
    // fill 100, stop 90 (R 10), base risk $50 (¼ of $200): 5 shares; full = 20; the add at 120 brings it to 20
    const b = weekdayBars([[100, 100.5, 99.5, 100], [110, 121, 109, 119], [119, 119.5, 118, 119], [119, 119.5, 50, 51]]);
    const x = simulateExitB(b, b.map((y) => y.close), b.map(() => 2), 0, 1, 100, 10, 90, 0.22, "inside", 50, 20, 30, { addQty: (_j, cur) => buildAddQty(cur, 20, 20) });
    expect(x.sharesAtExit).toBe(20);
    expect(x.exit).toBeCloseTo((5 * 100 + 15 * 120) / 20, 9);
    expect(x.reason).toBe("be_stop");
    // the next level (140) still adds the normal 50% beyond full: 20 → 30 shares, as in the primary
    const b2 = weekdayBars([[100, 100.5, 99.5, 100], [110, 121, 109, 119], [119, 141, 118, 139], [139, 139.5, 50, 51]]);
    const y = simulateExitB(b2, b2.map((z) => z.close), b2.map(() => 2), 0, 1, 100, 10, 90, 0.22, "inside", 50, 20, 30, { addQty: (_j, cur) => buildAddQty(cur, 20, 20) });
    expect(y.addPrices).toEqual([120, 140]);
    expect(y.sharesAtExit).toBe(30);
  });
});

describe("rolling-only trigger check (P3-0k and P3-0k3)", () => {
  // 260 rising bars: aligned long on every P3-0k measure at the last bar
  const n = 260;
  const bars = weekdayBars(Array.from({ length: n }, (_, k): [number, number, number, number] => [100 + k - 1, 100 + k + 1, 100 + k - 1.5, 100 + k]));
  const i = n - 1;
  const atr = atrSeries(bars)[i]!;
  const piv = zigzag(bars, 2);
  const entry = bars[i].high + 0.11 * atr;
  const support = optimalEntry(bars, bars.map((b) => b.close), i, 1, entry, entry - 1, atr, piv).support!;
  const stop = support - 0.4 * atr;
  const setup = (variant: "calendar" | "rolling"): Setup => ({ variant, htf: 1, maState: 1, symbol: "S", date: "2025-12-31", i, dir: 1, type: "inside", firedRules: ["inside+"], entry, stop, fudge: 0.11 * atr });
  const input = (cal: Setup[], rol: Setup[]) => ({ symbol: "S", bars, scanned: { setups: cal, rollingSetups: rol, info: [] }, pivots: piv, pyramid: { market: [null, null, null], sector: null, industry: null } });
  const ctx = { sessions: [], events: [] };
  const layers = { industry: null, sector: null, market: [null, null, null] };
  it("a rolling-only trigger passing every gate becomes a P3-0k candidate (variantSource rolling)", () => {
    const c = p3kCandidates(input([], [setup("rolling")]) as never, layers, ctx);
    expect(c).toHaveLength(1);
    expect(c[0].variantSource).toBe("rolling");
    expect(p3kMember.p3k(c[0])).toBe(true);
    const counts = gateCountsByVariant(c, [["aligned", (x) => x.p3k.aligned]]);
    expect(counts).toEqual([{ step: "STP triggers", calendar: 0, rolling: 1 }, { step: "aligned", calendar: 0, rolling: 1 }]);
  });
  it("when both fire the same day and direction, the calendar one is kept (why P3-0k showed 0 rolling)", () => {
    const c = p3kCandidates(input([setup("calendar")], [setup("rolling")]) as never, layers, ctx);
    expect(c.map((x) => x.variantSource)).toEqual(["calendar"]);
  });
});

describe("P3-0k3 trigger set (#88): rolling inside / U-turn only, calendar mech1 / mech2", () => {
  const n = 260;
  const bars = weekdayBars(Array.from({ length: n }, (_, k): [number, number, number, number] => [100 + k - 1, 100 + k + 1, 100 + k - 1.5, 100 + k]));
  const i = n - 1;
  const atr = atrSeries(bars)[i]!;
  const piv = zigzag(bars, 2);
  const entry = bars[i].high + 0.11 * atr;
  const stop = entry - 1;
  const setup = (variant: "calendar" | "rolling", type: string): Setup => ({ variant, htf: 1, maState: 1, symbol: "S", date: "2025-12-31", i, dir: 1, type, firedRules: [], entry, stop, fudge: 0.11 * atr });
  const input = (cal: Setup[], rol: Setup[]) => ({ symbol: "S", bars, scanned: { setups: cal, rollingSetups: rol, info: [] }, pivots: piv, pyramid: { market: [null, null, null], sector: null, industry: null } });
  const ctx = { sessions: [], events: [] };
  const layers = { industry: null, sector: null, market: [null, null, null] };
  it("a calendar-only inside (or U-turn) trigger is not a p3k3 candidate; the rolling one is", async () => {
    const { p3k3Candidates, calendarInsideUturn } = await import("@/lib/eval/aligned-v2-sim");
    expect(p3k3Candidates(input([setup("calendar", "inside")], []) as never, layers, ctx)).toHaveLength(0);
    expect(p3k3Candidates(input([setup("calendar", "butn")], []) as never, layers, ctx)).toHaveLength(0);
    const rol = p3k3Candidates(input([], [setup("rolling", "inside")]) as never, layers, ctx);
    expect(rol.map((c) => c.variantSource)).toEqual(["rolling"]);
    // both fire the same day: the rolling one is the P3-0k3 candidate (the calendar one isn't eligible)
    expect(p3k3Candidates(input([setup("calendar", "inside")], [setup("rolling", "inside")]) as never, layers, ctx).map((c) => c.variantSource)).toEqual(["rolling"]);
    // the comparison row takes the calendar inside / U-turn triggers only
    expect(p3k3Candidates(input([setup("calendar", "inside")], [setup("rolling", "inside")]) as never, layers, ctx, undefined, calendarInsideUturn).map((c) => c.variantSource)).toEqual(["calendar"]);
  });
  it("calendar mech1 / mech2 stay in", async () => {
    const { p3k3Candidates } = await import("@/lib/eval/aligned-v2-sim");
    expect(p3k3Candidates(input([setup("calendar", "mech1")], []) as never, layers, ctx)).toHaveLength(1);
    expect(p3k3Candidates(input([setup("calendar", "mech2")], []) as never, layers, ctx)).toHaveLength(1);
  });
});

describe("live keys", () => {
  it("are logged on stock rows and excluded from health families", () => {
    const up = weekdayBars(Array.from({ length: 260 }, (_, k): [number, number, number, number] => [100 + k - 1, 100 + k + 1, 100 + k - 1.5, 100 + k]));
    const keys = liveStpKeys(up, undefined, { assetClass: "stock", events: [] });
    for (const k of LIVE_P3K3_KEYS) {
      expect(keys).toHaveProperty(k);
      expect(isLiveStpKey(k)).toBe(true);
    }
    expect(keys.p3k3_ma_order).toBe("20>50");
    expect(keys.p3k3_candidate).toBeNull(); // no trigger
    expect(keys.p3k3_size_long).toBe(0.25); // monthly/rolling-20 green; sector and market unknown (2 halvings); no industry data is neutral
  });
});

describe("P3-0k3 end to end (smoke)", () => {
  it("candidates and every P3-0k3 population simulate; industry never gates", async () => {
    const { simulateFunnelSymbol } = await import("@/lib/eval/funnel-sim");
    const { p3k3Candidates, p3k3SimOptions, P3K3_RUNS, p3k3Member } = await import("@/lib/eval/aligned-v2-sim");
    const n = 300;
    const bars = weekdayBars(Array.from({ length: n }, (_, k): [number, number, number, number] => {
      const c = 100 + k + (k % 7 === 0 ? -3 : 0);
      return [c - 1, c + 1, c - 1.5, c];
    }));
    const { scanSymbol } = await import("@/lib/eval/stp-sim");
    const input = { symbol: "S", bars, scanned: scanSymbol("S", bars), pivots: zigzag(bars, 2), pyramid: { market: [null, null, null], sector: null, industry: null } };
    const ctx = { sessions: [], events: [] };
    const c3 = p3k3Candidates(input, { industry: null, sector: null, market: [null, null, null] }, ctx);
    for (const c of c3) expect(p3k3Member.p3k3({ ...c, industryV2: "against" })).toBe(p3k3Member.p3k3({ ...c, industryV2: null }));
    for (const p of P3K3_RUNS) {
      const r = simulateFunnelSymbol(input, c3, p, "stop", ctx, p3k3SimOptions(p));
      for (const t of r.trades) expect(t.population).toBe(p);
    }
  });
});

describe("rolling triggers: the monthly + rolling-20 size input (#88, Chris chose B)", () => {
  // 58 weekday bars from Mon 2025-01-06: t = 57 (2025-03-26); March starts at bar 40; rolling-20 open = bar 38, rolling-5 = bar 53
  const series = (monthOpen?: number) => {
    const rows = Array.from({ length: 58 }, (_, k): [number, number, number, number] => {
      const c = 100 + k * 0.5;
      const o = k === 40 && monthOpen != null ? monthOpen : c - 0.3;
      return [o, Math.max(o, c) + 0.6, Math.min(o, c) - 0.6, c];
    });
    const p = rows[56];
    rows[57] = [p[3] - 0.1, p[1] - 0.05, p[2] + 0.05, p[3]]; // an inside bar closing near the prior close
    return weekdayBars(rows);
  };
  it("a rolling inside trigger already needs the rolling-20 open green, so its size input reduces to the monthly open", async () => {
    const { computeStpRolling } = await import("@/lib/harvester/universe/stp-rolling");
    const green = series();
    const red = series(200); // only the monthly open moves above the close
    for (const b of [green, red]) expect(computeStpRolling(b)).toMatchObject({ trigger: 1, triggerType: "inside" });
    expect(monthlyAndRolling20Green(green, 57, 1)).toBe(true);
    expect(monthlyAndRolling20Green(red, 57, 1)).toBe(false); // one halving, from the monthly open alone
    const sz = (b: DailyBar[]) => p3k3Size({ monthlyR20Green: monthlyAndRolling20Green(b, 57, 1), sector: "aligned", market: "aligned", industry: null }, false);
    expect([sz(green), sz(red)]).toEqual([1, 0.5]);
    // the rolling-20 open can't be the one that fails: moving it above the close stops the trigger itself
    const b = series();
    b[38] = { ...b[38], open: 200, high: 200.6 };
    expect(computeStpRolling(b).trigger).toBe(0);
  });
});
