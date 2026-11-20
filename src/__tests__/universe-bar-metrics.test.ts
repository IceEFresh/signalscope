import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  computeBarMetrics,
  fetchBarMetricsMany,
  isOpenSessionBar,
  parseChartBars,
  type DailyBar,
} from "@/lib/harvester/universe/bar-metrics";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8"),
);
// The fixture was fetched after the 2026-11-20 close. Its last bar is that day's session:
// timestamp 1795185000 = meta.currentTradingPeriod.regular.start (9:30 ET), regular.end = 1795208400 (16:00 ET).
const FIXTURE_LAST_BAR = 1795185000;
const AFTER_CLOSE = new Date(1795210000 * 1000); // 16:26 ET
const MID_SESSION = new Date(1795195000 * 1000); // 12:16 ET

function flatBars(n: number, close = 100, range = 4, volume = 1_000_000): DailyBar[] {
  return Array.from({ length: n }, () => ({ high: close + range / 2, low: close - range / 2, close, volume }));
}

describe("parseChartBars", () => {
  it("parses a real Yahoo 3-month chart (AMD fixture)", () => {
    const bars = parseChartBars(fixture, AFTER_CLOSE);
    expect(bars.length).toBeGreaterThanOrEqual(60);
    for (const b of bars) {
      expect(b.close).toBeGreaterThan(0);
      expect(b.high).toBeGreaterThanOrEqual(b.low);
    }
  });

  it("drops bars with a null field", () => {
    const json = {
      chart: { result: [{ indicators: { quote: [{ high: [2, null, 4], low: [1, 1, 3], close: [1.5, 1.5, 3.5], volume: [10, 10, null] }] } }] },
    };
    expect(parseChartBars(json)).toEqual([{ high: 2, low: 1, close: 1.5, volume: 10 }]);
  });

  it("returns [] for empty or malformed responses", () => {
    expect(parseChartBars(null)).toEqual([]);
    expect(parseChartBars({})).toEqual([]);
    expect(parseChartBars({ chart: { result: [] } })).toEqual([]);
    expect(parseChartBars({ chart: { error: { code: "Not Found" } } })).toEqual([]);
    expect(parseChartBars("<html>rate limited</html>")).toEqual([]);
  });
});

describe("computeBarMetrics", () => {
  it("computes sane metrics from the AMD fixture", () => {
    const m = computeBarMetrics(parseChartBars(fixture, AFTER_CLOSE));
    expect(m.lastClose).toBeGreaterThan(0);
    expect(m.dollarVolume20d).toBeGreaterThan(1_000_000_000); // AMD trades billions a day
    expect(m.atrPct).toBeGreaterThan(0.01);
    expect(m.atrPct).toBeLessThan(0.3);
    expect(m.hv20).toBeGreaterThan(0.1);
    expect(m.hv20).toBeLessThan(3);
  });

  it("computes exact values for flat bars", () => {
    const m = computeBarMetrics(flatBars(30));
    expect(m.lastClose).toBe(100);
    expect(m.dollarVolume20d).toBe(100_000_000);
    expect(m.atrPct).toBeCloseTo(0.04, 10); // range 4 on a $100 close
    expect(m.hv20).toBe(0); // no price change
  });

  it("uses only the last 20 bars for dollar volume", () => {
    const bars = [...flatBars(10, 100, 4, 1), ...flatBars(20, 100, 4, 2_000_000)];
    expect(computeBarMetrics(bars).dollarVolume20d).toBe(200_000_000);
  });

  it("returns null metrics, not 0, when history is too short", () => {
    const m = computeBarMetrics(flatBars(10));
    expect(m.dollarVolume20d).toBeNull();
    expect(m.atrPct).toBeNull();
    expect(m.hv20).toBeNull();
    expect(m.barCount).toBe(10);
    expect(computeBarMetrics([])).toEqual({ lastClose: null, dollarVolume20d: null, atrPct: null, hv20: null, barCount: 0 });
  });
});

describe("completed bars only (PR 1-0 review)", () => {
  it("keeps the session's bar after the close", () => {
    const bars = parseChartBars(fixture, AFTER_CLOSE);
    expect(bars[bars.length - 1].time).toBe(FIXTURE_LAST_BAR);
  });

  it("drops the open session's partial bar during market hours (fixture, currentTradingPeriod)", () => {
    const full = parseChartBars(fixture, AFTER_CLOSE);
    const mid = parseChartBars(fixture, MID_SESSION);
    expect(mid).toHaveLength(full.length - 1);
    expect(mid[mid.length - 1].time).toBeLessThan(FIXTURE_LAST_BAR);
    expect(computeBarMetrics(mid).lastClose).toBe(full[full.length - 2].close);
  });

  it("falls back to 9:30-16:00 ET when currentTradingPeriod is missing", () => {
    // 2026-11-19 14:30 UTC = 9:30 ET bar
    const bar = Date.UTC(2026, 10, 19, 14, 30) / 1000;
    expect(isOpenSessionBar(bar, new Date(Date.UTC(2026, 10, 19, 16, 0)))).toBe(true); // 11:00 ET same day
    expect(isOpenSessionBar(bar, new Date(Date.UTC(2026, 10, 19, 21, 30)))).toBe(false); // 16:30 ET
    expect(isOpenSessionBar(bar, new Date(Date.UTC(2026, 10, 20, 13, 30)))).toBe(false); // next day 8:30 ET
  });

  it("keeps every bar at the 8:30 AM ET harvest time", () => {
    const harvest = new Date(1795185000 * 1000 - 3600 * 1000); // 8:30 ET on the fixture's last day
    const bars = parseChartBars(fixture, harvest);
    expect(bars[bars.length - 1].time).toBe(FIXTURE_LAST_BAR);
  });
});

describe("fetchBarMetricsMany counts (PR 1-0 review)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries 429 once, logs ok / failed / 429 counts, and omits failed symbols", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/RL?")) return { ok: false, status: 429, json: async () => ({}) };
      if (url.includes("/BAD?")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => fixture };
    }));

    const out = await fetchBarMetricsMany(["AMD", "RL", "BAD"], { delayMs: 0, retryDelayMs: 0, label: "bars" });

    expect([...out.keys()]).toEqual(["AMD"]);
    expect(calls.filter((u) => u.includes("/RL?"))).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("[bars] charts ok=1 failed=1 rate-limited(429)=1 of 3");
  });
});
