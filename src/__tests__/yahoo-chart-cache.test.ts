import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearChartCache, dailyChartUrl, fetchDailyChart } from "@/lib/harvester/yahoo-chart";
import { featuresFromCachedCharts } from "@/lib/harvester/universe/harvest-prep";
import { readFileSync } from "fs";
import { join } from "path";

const amd = JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8"));
const spy = JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-SPY-3mo.json"), "utf8"));

const fetchMock = vi.fn();
beforeEach(() => {
  clearChartCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchDailyChart per-run cache (PLAN.md 1a)", () => {
  it("fetches a symbol once, even for concurrent callers", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => amd });
    const [a, b] = await Promise.all([fetchDailyChart("AMD"), fetchDailyChart("AMD")]);
    await fetchDailyChart("AMD");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(dailyChartUrl("AMD"));
    expect(a).toBe(b);
  });

  it("does not cache failures, so a later caller retries", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => amd });
    expect((await fetchDailyChart("AMD")).ok).toBe(false);
    expect((await fetchDailyChart("AMD")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("featuresFromCachedCharts", () => {
  it("reuses cached charts and adds one SPY fetch", async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes("/SPY?") ? spy : amd),
    }));
    await fetchDailyChart("AMD"); // as volume spike / bar metrics would have
    const out = await featuresFromCachedCharts(["AMD"]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // AMD once, SPY once
    expect(out.AMD.features_version).toBe(1);
    expect(out.AMD.bar_date).not.toBeNull();
  });

  it("still computes features with null RS when SPY fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/SPY?") ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => amd },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await featuresFromCachedCharts(["AMD"]);
    expect(out.AMD.rs_vs_spy_20d).toBeNull();
    expect(out.AMD.return_20d).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips symbols whose chart fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/BAD?") ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => amd },
    );
    const out = await featuresFromCachedCharts(["BAD"]);
    expect(out).toEqual({});
  });
});
