import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { wilderAtr } from "@/lib/harvester/universe/bar-features";
import { computeStp, isFirstBarAfterEarnings, maState, wellBidAt } from "@/lib/harvester/universe/stp";
import { toUnixSeconds } from "@/lib/harvester/universe/build";

const DAY = 86_400;
// Weekday 9:30 ET bar times ending Fri 2026-11-20.
function weekdayTimes(count: number): number[] {
  const out: number[] = [];
  let t = Date.UTC(2026, 10, 20, 14, 30) / 1000;
  while (out.length < count) {
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(t);
    t -= DAY;
  }
  return out;
}
type Ohlc = { o: number; h: number; l: number; c: number };
function series(closes: number[], overrides: Record<number, Ohlc> = {}): DailyBar[] {
  const times = weekdayTimes(closes.length);
  return closes.map((c, i) => {
    const o = overrides[i];
    return o
      ? { open: o.o, high: o.h, low: o.l, close: o.c, volume: 1000, time: times[i] }
      : { open: c, high: c + 1, low: c - 1, close: c, volume: 1000, time: times[i] };
  });
}

describe("STP states", () => {
  it("maState follows docs/STP-SIGNALS.md", () => {
    expect(maState(110, 105, 100)).toBe(1);
    expect(maState(90, 95, 100)).toBe(-1);
    expect(maState(102, 105, 100)).toBe(0);
    expect(maState(100, null, 100)).toBeNull();
  });

  it("wellBid is +1 for an outside-up close above the prior high, -1 for the mirror", () => {
    const up = series([100, 100], { 1: { o: 100, h: 104, l: 100, c: 103.5 } });
    expect(wellBidAt(up, 1)).toBe(1);
    const down = series([100, 100], { 1: { o: 100, h: 100.5, l: 96, c: 96.5 } });
    expect(wellBidAt(down, 1)).toBe(-1);
    expect(wellBidAt(series([100, 100]), 1)).toBe(0);
  });

  it("returns nulls, not 0, with fewer than 51 bars", () => {
    const r = computeStp(series(Array.from({ length: 40 }, (_, i) => 100 + i)));
    expect(r.trigger).toBeNull();
    expect(r.htfOpens).toBeNull();
    expect(r.entry).toBeNull();
    expect(r.barDate).toBe("2026-11-20");
  });
});

describe("STP triggers", () => {
  const up = (n: number) => Array.from({ length: n }, (_, i) => 100 + i);

  it("inside candle with trendDirection +1 → bullish, full size, with trade parameters", () => {
    const closes = up(60);
    const b = series(closes, { 59: { o: 157.5, h: 159, l: 157, c: 158.5 } }); // inside bar 58 (157..159)
    const r = computeStp(b);
    expect(r.htfOpens).toBe(1);
    expect(r.maState).toBe(1);
    expect(r.sizeFactor).toBe(1);
    expect(r.trigger).toBe(1);
    expect(r.triggerType).toBe("inside");
    const atr = wilderAtr(b).at(-1)!;
    const fudge = Math.max(0.11 * atr, 0.02);
    expect(r.atr14).toBeCloseTo(atr, 12);
    expect(r.fudge).toBeCloseTo(fudge, 12);
    expect(r.entry).toBeCloseTo(159 + fudge, 12);
    expect(r.stop).toBeCloseTo(157 - fudge, 12);
    const risk = 2 + 2 * fudge;
    expect(r.risk).toBeCloseTo(risk, 12);
    expect(r.target2R).toBeCloseTo(159 + fudge + 2 * risk, 12);
    expect(r.target3R).toBeCloseTo(159 + fudge + 3 * risk, 12);
    expect(r.addLevel2R).toBeCloseTo(159 + fudge + atr, 12);
    expect(r.addLevel3R).toBeCloseTo(159 + fudge + 2 * atr, 12);
  });

  it("inside candle with trendDirection -1 → bearish, parameters mirrored around the low", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 200 - i);
    const b = series(closes, { 59: { o: 142.5, h: 143, l: 141, c: 141.5 } });
    b[58] = { ...b[58], high: 143.5, low: 140.5 }; // bar 59 (141..143) sits inside bar 58 (140.5..143.5)
    const r = computeStp(b);
    expect(r.htfOpens).toBe(-1);
    expect(r.trigger).toBe(-1);
    expect(r.triggerType).toBe("inside");
    expect(r.entry).toBeCloseTo(141 - r.fudge!, 12);
    expect(r.stop).toBeCloseTo(143 + r.fudge!, 12);
    expect(r.target2R!).toBeLessThan(r.entry!);
  });

  it("Mechanical I: close crosses above SMA20 with SMA20 >= SMA50 and SMA10 <= SMA20", () => {
    const closes = [...Array.from({ length: 50 }, (_, i) => 100 + i), ...Array(8).fill(140), 160];
    const r = computeStp(series(closes));
    expect(r.firedRules).toContain("mech1+");
    expect(r.firedRules).not.toContain("mech2+");
    expect(r.trigger).toBe(1);
    expect(r.triggerType).toBe("mech1");
  });

  it("BUTN after a well-bid -1 bar, with trendDirection +1 three bars back", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 140 + i * 0.2);
    const b = series(closes, {
      57: { o: 150, h: 152, l: 148, c: 151 },
      58: { o: 149, h: 150, l: 144, c: 145 }, // well bid -1
      59: { o: 143.5, h: 147, l: 143, c: 146.5 }, // BUTN
    });
    expect(wellBidAt(b, 58)).toBe(-1);
    const r = computeStp(b);
    expect(r.firedRules).toContain("butn+");
    expect(r.trigger).toBe(1);
  });

  it("EGOP fires only on the first bar after the earnings release", () => {
    const closes = up(60);
    const b = series(closes, { 59: { o: 162, h: 165, l: 161, c: 164 } }); // low 161 > prior high 159
    const before = b[59].time! - 2 * 3600; // 7:30 ET release, before the open
    expect(computeStp(b, before).firedRules).toContain("egop+");
    expect(computeStp(b, null).firedRules).not.toContain("egop+");
    expect(computeStp(b, b[57].time!).firedRules).not.toContain("egop+"); // released two sessions ago
  });

  it("no rule → trigger 0 and no trade parameters", () => {
    const r = computeStp(series(up(60)));
    expect(r.trigger).toBe(0);
    expect(r.triggerType).toBeNull();
    expect(r.entry).toBeNull();
    expect(r.atr14).not.toBeNull();
  });
});

describe("isFirstBarAfterEarnings", () => {
  const b = series([1, 2, 3]);
  it("is true for a release after the prior bar's start and up to this bar's start", () => {
    expect(isFirstBarAfterEarnings(b, 2, b[1].time! + 7 * 3600)).toBe(true); // prior day after close
    expect(isFirstBarAfterEarnings(b, 2, b[2].time!)).toBe(true);
    expect(isFirstBarAfterEarnings(b, 2, b[1].time!)).toBe(false);
    expect(isFirstBarAfterEarnings(b, 2, b[2].time! + 60)).toBe(false); // during today's session
  });
});

describe("toUnixSeconds", () => {
  it("accepts a Date, unix seconds or milliseconds", () => {
    expect(toUnixSeconds(new Date("2026-11-20T21:00:00Z"))).toBe(1795208400);
    expect(toUnixSeconds(1795208400)).toBe(1795208400);
    expect(toUnixSeconds(1795208400000)).toBe(1795208400);
    expect(toUnixSeconds("soon")).toBeNull();
    expect(toUnixSeconds(undefined)).toBeNull();
  });
});

describe("computeStp on the real AMD fixture", () => {
  it("fills every state on the last completed session", () => {
    const amd = JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8"));
    const r = computeStp(parseChartBars(amd, new Date(1795210000 * 1000)));
    expect(r.barDate).toBe("2026-11-20");
    expect(r.htfOpens).not.toBeNull();
    expect(r.maState).not.toBeNull();
    expect(r.wellBid).not.toBeNull();
    expect([0.5, 1]).toContain(r.sizeFactor);
    expect([-1, 0, 1]).toContain(r.trigger);
    expect(r.atr14).toBeGreaterThan(0);
  });
});
