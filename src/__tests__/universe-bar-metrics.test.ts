import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { computeBarMetrics, parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8"),
);

function flatBars(n: number, close = 100, range = 4, volume = 1_000_000): DailyBar[] {
  return Array.from({ length: n }, () => ({ high: close + range / 2, low: close - range / 2, close, volume }));
}

describe("parseChartBars", () => {
  it("parses a real Yahoo 3-month chart (AMD fixture)", () => {
    const bars = parseChartBars(fixture);
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
    const m = computeBarMetrics(parseChartBars(fixture));
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
