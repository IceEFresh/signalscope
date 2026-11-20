import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import {
  BAR_FEATURES_VERSION,
  computeBarFeatures,
  stpHtfOpens,
  wilderAtr,
  wilderRsi,
} from "@/lib/harvester/universe/bar-features";

const load = (s: string) => JSON.parse(readFileSync(join(__dirname, `fixtures/universe/chart-${s}-3mo.json`), "utf8"));
const AFTER_CLOSE = new Date(1795210000 * 1000); // 2026-11-20 16:26 ET; both fixtures end on that session
const amd = parseChartBars(load("AMD"), AFTER_CLOSE);
const spy = parseChartBars(load("SPY"), AFTER_CLOSE);

const DAY = 86_400;
// Weekday 9:30 ET bar times going back from Fri 2026-11-20 (14:30 UTC).
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
function bars(closes: number[], range = 2, volume = 1000): DailyBar[] {
  const times = weekdayTimes(closes.length);
  return closes.map((c, i) => ({ open: c, high: c + range / 2, low: c - range / 2, close: c, volume, time: times[i] }));
}

describe("computeBarFeatures on the real AMD + SPY fixtures", () => {
  const f = computeBarFeatures(amd, spy);

  it("describes the last completed session and fills every feature", () => {
    expect(f.features_version).toBe(BAR_FEATURES_VERSION);
    expect(f.bar_date).toBe("2026-11-20");
    expect(f.close).toBe(amd[amd.length - 1].close);
    for (const [k, v] of Object.entries(f)) expect(v, k).not.toBeNull();
  });

  it("keeps values in sane ranges", () => {
    expect(f.close_location!).toBeGreaterThanOrEqual(0);
    expect(f.close_location!).toBeLessThanOrEqual(1);
    expect(f.rsi14!).toBeGreaterThanOrEqual(0);
    expect(f.rsi14!).toBeLessThanOrEqual(100);
    expect(f.rsi14_min_20d!).toBeLessThanOrEqual(f.rsi14!);
    expect(f.rsi14_max_20d!).toBeGreaterThanOrEqual(f.rsi14!);
    expect(f.atr14_pct!).toBeGreaterThan(0);
    expect([1, -1, 0.5, -0.5, 0]).toContain(f.stp_htf_opens);
  });

  it("computes relative strength against SPY over the same dates", () => {
    const n = amd.length;
    expect(f.return_20d).toBeCloseTo(amd[n - 1].close / amd[n - 21].close - 1, 12);
    const spyByTime = new Map(spy.map((b) => [b.time, b.close]));
    const spyRet = spyByTime.get(amd[n - 1].time)! / spyByTime.get(amd[n - 21].time)! - 1;
    expect(f.spy_return_20d).toBeCloseTo(spyRet, 12);
    expect(f.rs_vs_spy_20d).toBeCloseTo(f.return_20d! - spyRet, 12);
  });

  it("uses the week's and month's first-session opens", () => {
    // 2026-11-20 is a Friday: week opens Mon 11-16, month opens Mon 11-02.
    const byDate = (d: string) => amd.find((b) => new Date(b.time! * 1000).toISOString().slice(0, 10) === d)!;
    expect(f.week_open).toBe(byDate("2026-11-16").open);
    expect(f.month_open).toBe(byDate("2026-11-02").open);
  });

  it("drops today's partial bar mid-session, so features describe the previous session", () => {
    const mid = computeBarFeatures(parseChartBars(load("AMD"), new Date(1795195000 * 1000)), spy);
    expect(mid.bar_date).toBe("2026-11-19");
  });

  it("returns spy fields as null without SPY bars", () => {
    const g = computeBarFeatures(amd, null);
    expect(g.spy_return_20d).toBeNull();
    expect(g.rs_vs_spy_20d).toBeNull();
    expect(g.return_20d).not.toBeNull();
  });
});

describe("computeBarFeatures on synthetic bars", () => {
  it("computes SMA ratios, slope and consecutive up days exactly", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i); // steady uptrend
    const f = computeBarFeatures(bars(closes));
    expect(f.close).toBe(159);
    expect(f.close_vs_sma20).toBeCloseTo(159 / 149.5 - 1, 12);
    expect(f.close_vs_sma50).toBeCloseTo(159 / 134.5 - 1, 12);
    expect(f.sma20_vs_sma50).toBeCloseTo(149.5 / 134.5 - 1, 12);
    expect(f.sma20_slope_5d).toBeCloseTo(149.5 / 144.5 - 1, 12);
    expect(f.consecutive_up_days).toBe(59);
    expect(f.rsi14).toBe(100); // no down closes
  });

  it("flags NR4/NR7 and range contraction", () => {
    const b = bars(Array(30).fill(50), 4);
    b[b.length - 1] = { ...b[b.length - 1], high: 50.5, low: 49.5 }; // range 1 vs 4
    const f = computeBarFeatures(b);
    expect(f.nr4).toBe(true);
    expect(f.nr7).toBe(true);
    expect(f.range_vs_avg10).toBeCloseTo(1 / 4 - 1, 12);
    expect(f.close_location).toBeCloseTo(0.5, 12);
    const wide = bars(Array(30).fill(50), 4);
    wide[wide.length - 1] = { ...wide[wide.length - 1], high: 55, low: 45 };
    expect(computeBarFeatures(wide).nr4).toBe(false);
  });

  it("measures extension above prior highs and the 50-day volume ratio", () => {
    const b = bars(Array(70).fill(100), 2, 1000);
    b[b.length - 1] = { ...b[b.length - 1], close: 110, high: 111, low: 104, volume: 3000 };
    const f = computeBarFeatures(b);
    expect(f.pct_above_high_20d).toBeCloseTo(110 / 101 - 1, 12);
    expect(f.pct_above_high_60d).toBeCloseTo(110 / 101 - 1, 12);
    expect(f.volume_ratio_50d).toBe(3);
  });

  it("returns null, not 0, when history is too short", () => {
    const f = computeBarFeatures(bars([100, 101, 102]));
    expect(f.close_vs_sma20).toBeNull();
    expect(f.sma20_slope_5d).toBeNull();
    expect(f.atr14).toBeNull();
    expect(f.rsi14).toBeNull();
    expect(f.hv20).toBeNull();
    expect(f.pct_above_high_20d).toBeNull();
    expect(f.volume_ratio_50d).toBeNull();
    expect(f.nr7).toBeNull();
    expect(f.consecutive_up_days).toBe(2);
  });

  it("handles empty and undated bars", () => {
    const empty = computeBarFeatures([]);
    expect(empty.features_version).toBe(BAR_FEATURES_VERSION);
    expect(empty.close).toBeNull();
    expect(empty.bar_date).toBeNull();
    const undated = computeBarFeatures(bars(Array(30).fill(10)).map((b) => ({ ...b, time: undefined })));
    expect(undated.bar_date).toBeNull();
    expect(undated.week_open).toBeNull();
    expect(undated.stp_htf_opens).toBeNull();
  });
});

describe("Wilder ATR and RSI", () => {
  it("ATR of a constant true range equals that range", () => {
    const atr = wilderAtr(bars(Array(30).fill(100), 3));
    expect(atr.length).toBe(30 - 1 - 14 + 1);
    expect(atr[atr.length - 1]).toBeCloseTo(3, 12);
  });

  it("RSI stays near 50 for equal alternating gains and losses, 100 for only gains", () => {
    // Wilder smoothing weights the latest change most, so it oscillates around 50, not on it.
    const alt = wilderRsi(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101)));
    expect(alt.at(-1)!).toBeGreaterThan(50);
    expect(alt.at(-1)!).toBeLessThan(55);
    expect(alt.at(-2)!).toBeLessThan(50);
    expect(alt.at(-2)!).toBeGreaterThan(45);
    expect(wilderRsi(Array.from({ length: 20 }, (_, i) => i + 1)).at(-1)).toBe(100);
  });
});

describe("stpHtfOpens (docs/STP-SIGNALS.md)", () => {
  it.each([
    [110, 100, 100, 1],
    [90, 100, 100, -1],
    [95, 100, 90, 0.5],
    [105, 100, 110, -0.5],
    [100, 100, 90, 0],
  ])("close %d, week open %d, month open %d → %d", (c, w, m, expected) => {
    expect(stpHtfOpens(c, w, m)).toBe(expected);
  });

  it("is null when an open is unknown", () => {
    expect(stpHtfOpens(100, null, 90)).toBeNull();
  });
});
