import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { computeRegime, distributionDays, REGIME_VERSION } from "@/lib/harvester/universe/regime";
import { computeRegimeExtras } from "@/lib/harvester/universe/harvest-prep";

const AFTER_CLOSE = new Date(1795210000 * 1000); // 2026-11-20 16:26 ET
const raw = (s: string) => JSON.parse(readFileSync(join(__dirname, `fixtures/universe/chart-${s}-3mo.json`), "utf8"));
const bars = (s: string) => parseChartBars(raw(s), AFTER_CLOSE);

function series(closes: number[], volumes?: number[]): DailyBar[] {
  return closes.map((c, i) => ({ open: c, high: c + 1, low: c - 1, close: c, volume: volumes?.[i] ?? 1000 }));
}

describe("computeRegime on real SPY, ^VIX and TLT fixtures", () => {
  const r = computeRegime(bars("SPY"), bars("VIX"), bars("TLT"));

  it("fills every field for the 2026-11-20 session", () => {
    expect(r.regime_version).toBe(REGIME_VERSION);
    expect(r.spy_bar_date).toBe("2026-11-20");
    for (const [k, v] of Object.entries(r)) expect(v, k).not.toBeNull();
  });

  it("is consistent: above-SMA flags match the ratios, distribution days within 0..25", () => {
    expect(r.spy_above_sma20).toBe(r.spy_close_vs_sma20! > 0);
    expect(r.tlt_above_sma20).toBe(r.tlt_close_vs_sma20! > 0);
    expect(r.spy_distribution_days_25!).toBeGreaterThanOrEqual(0);
    expect(r.spy_distribution_days_25!).toBeLessThanOrEqual(25);
    expect(r.vix_close!).toBeGreaterThan(5);
  });
});

describe("distributionDays (O'Neil, row #14)", () => {
  it("counts sessions down at least 0.2% on higher volume than the prior session", () => {
    const closes = Array(30).fill(100);
    const vols = Array(30).fill(1000);
    closes[27] = 99.7; vols[27] = 2000; // −0.3%, volume up → counts
    closes[28] = 99.6; vols[28] = 3000; // −0.1% → too small
    closes[29] = 99.0; vols[29] = 1000; // −0.6% but volume down → no
    expect(distributionDays(series(closes, vols))).toBe(1);
  });

  it("only looks at the last 25 sessions and needs 26 bars", () => {
    const closes = Array(40).fill(100);
    const vols = Array(40).fill(1000);
    closes[5] = 99; vols[5] = 5000; // outside the window
    expect(distributionDays(series(closes, vols))).toBe(0);
    expect(distributionDays(series(Array(25).fill(100)))).toBeNull();
  });
});

describe("computeRegime with missing inputs", () => {
  it("returns nulls, not 0, for each missing series", () => {
    const r = computeRegime(null, null, null);
    expect(r.spy_close).toBeNull();
    expect(r.spy_above_sma20).toBeNull();
    expect(r.spy_distribution_days_25).toBeNull();
    expect(r.vix_close).toBeNull();
    expect(r.tlt_above_sma20).toBeNull();
    expect(r.spy_bar_date).toBeNull();
  });

  it("computes exact trend values on synthetic bars", () => {
    const up = series(Array.from({ length: 30 }, (_, i) => 100 + i));
    const r = computeRegime(up, up, up);
    expect(r.spy_close_vs_sma20).toBeCloseTo(129 / 119.5 - 1, 12);
    expect(r.spy_sma20_slope_5d).toBeCloseTo(119.5 / 114.5 - 1, 12);
    expect(r.vix_change_5d).toBeCloseTo(129 / 124 - 1, 12);
  });
});

describe("computeRegimeExtras", () => {
  it("loads SPY, ^VIX and TLT and degrades to nulls for a failed chart", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getChart = vi.fn(async (s: string) =>
      s === "TLT" ? { ok: false as const, status: 429, rateLimited: true } : { ok: true as const, json: raw(s === "^VIX" ? "VIX" : "SPY") },
    );
    const r = await computeRegimeExtras(getChart as never);
    expect(getChart.mock.calls.map((c) => c[0]).sort()).toEqual(["SPY", "TLT", "^VIX"]);
    expect(r.spy_close).not.toBeNull();
    expect(r.vix_close).not.toBeNull();
    expect(r.tlt_close_vs_sma20).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
