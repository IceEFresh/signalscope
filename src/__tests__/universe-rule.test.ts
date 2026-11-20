import { describe, it, expect } from "vitest";
import { evaluateUniverseRule, flippedCriteria, type UniverseRuleInput } from "@/lib/harvester/universe/rule";

const passing: UniverseRuleInput = {
  quoteType: "EQUITY",
  price: 40,
  marketCap: 3_000_000_000,
  metrics: { lastClose: 40, dollarVolume20d: 80_000_000, atrPct: 0.045, hv20: 0.5, barCount: 63 },
  hasOptions: true,
};

describe("evaluateUniverseRule", () => {
  it("passes a liquid, volatile equity with options", () => {
    expect(evaluateUniverseRule(passing)).toEqual({ passes: true, failing: [] });
  });

  it.each([
    ["etf", { quoteType: "ETF" }],
    ["price", { price: 4.99 }],
    ["marketCap", { marketCap: 499_000_000 }],
    ["options", { hasOptions: false }],
  ] as const)("fails on %s", (criterion, patch) => {
    const r = evaluateUniverseRule({ ...passing, ...patch });
    expect(r.passes).toBe(false);
    expect(r.failing).toEqual([criterion]);
  });

  it("fails dollar volume under $25M", () => {
    const r = evaluateUniverseRule({ ...passing, metrics: { ...passing.metrics!, dollarVolume20d: 24_000_000 } });
    expect(r.failing).toEqual(["dollarVolume"]);
  });

  it("passes volatility on either ATR% >= 3% or HV >= 40%", () => {
    const m = passing.metrics!;
    expect(evaluateUniverseRule({ ...passing, metrics: { ...m, atrPct: 0.02, hv20: 0.45 } }).passes).toBe(true);
    expect(evaluateUniverseRule({ ...passing, metrics: { ...m, atrPct: 0.031, hv20: 0.2 } }).passes).toBe(true);
    expect(evaluateUniverseRule({ ...passing, metrics: { ...m, atrPct: 0.02, hv20: 0.2 } }).failing).toEqual(["volatility"]);
  });

  it("treats missing data as failing, never as a pass", () => {
    const r = evaluateUniverseRule({ quoteType: null, price: null, marketCap: null, metrics: null, hasOptions: null });
    expect(r.passes).toBe(false);
    expect(r.failing).toEqual(["etf", "price", "dollarVolume", "marketCap", "volatility", "options"]);
  });

  it("falls back to the last bar close when the quote has no price", () => {
    expect(evaluateUniverseRule({ ...passing, price: null }).passes).toBe(true);
  });
});

describe("flippedCriteria", () => {
  it("returns criteria that failed before and pass now", () => {
    expect(flippedCriteria(["dollarVolume", "volatility"], ["volatility"])).toEqual(["dollarVolume"]);
    expect(flippedCriteria([], [])).toEqual([]);
  });
});
