import { describe, it, expect, vi } from "vitest";
import { buildUniverse, evaluateSymbols, passesPrefilter, type QuoteInfo, type UniverseBuildDeps } from "@/lib/harvester/universe/build";
import type { BarMetrics } from "@/lib/harvester/universe/bar-metrics";

const goodQuote: QuoteInfo = { quoteType: "EQUITY", price: 30, marketCap: 2e9, avgVolume3m: 2_000_000 };
const goodBars: BarMetrics = { lastClose: 30, dollarVolume20d: 60e6, atrPct: 0.05, hv20: 0.6, barCount: 63 };

function deps(over: Partial<UniverseBuildDeps> = {}): UniverseBuildDeps {
  const quotes = new Map<string, QuoteInfo>([
    ["GOOD", goodQuote],
    ["NOOPT", goodQuote],
    ["CALM", goodQuote],
    ["ETFX", { ...goodQuote, quoteType: "ETF" }],
    ["PENNY", { ...goodQuote, price: 2 }],
    ["THIN", { ...goodQuote, avgVolume3m: 100_000 }],
  ]);
  const bars = new Map<string, BarMetrics>([
    ["GOOD", goodBars],
    ["NOOPT", goodBars],
    ["CALM", { ...goodBars, atrPct: 0.01, hv20: 0.15 }],
  ]);
  return {
    fetchDirectory: vi.fn(async () => [...quotes.keys(), "NOQUOTE"]),
    fetchQuotes: vi.fn(async (s: string[]) => new Map(s.filter((x) => quotes.has(x)).map((x) => [x, quotes.get(x)!]))),
    fetchMetrics: vi.fn(async (s: string[]) => new Map(s.filter((x) => bars.has(x)).map((x) => [x, bars.get(x)!]))),
    hasListedOptions: vi.fn(async (s: string) => s !== "NOOPT"),
    ...over,
  };
}

describe("passesPrefilter", () => {
  it("rejects ETFs, sub-$5, small caps, thin volume and missing quotes", () => {
    expect(passesPrefilter(goodQuote)).toBe(true);
    expect(passesPrefilter(undefined)).toBe(false);
    expect(passesPrefilter({ ...goodQuote, quoteType: "ETF" })).toBe(false);
    expect(passesPrefilter({ ...goodQuote, price: 4 })).toBe(false);
    expect(passesPrefilter({ ...goodQuote, marketCap: 4e8 })).toBe(false);
    expect(passesPrefilter({ ...goodQuote, avgVolume3m: null })).toBe(false);
  });
});

describe("buildUniverse", () => {
  it("keeps only names passing every criterion, including listed options", async () => {
    const d = deps();
    const result = await buildUniverse(d);
    expect(result.members.map((m) => m.symbol)).toEqual(["GOOD"]);
    expect(result.directoryCount).toBe(7);
    expect(result.prefilterCount).toBe(3); // GOOD, NOOPT, CALM
    expect(result.members[0]).toMatchObject({ dollarVolume20d: 60e6, atrPct: 0.05, hasOptions: true });
    // Bars only for pre-filter survivors; options only for bar survivors
    expect(d.fetchMetrics).toHaveBeenCalledWith(["GOOD", "NOOPT", "CALM"]);
    expect(d.hasListedOptions).toHaveBeenCalledTimes(2);
  });

  it("treats an unknown options answer (null) as no options", async () => {
    const result = await buildUniverse(deps({ hasListedOptions: async () => null }));
    expect(result.members).toEqual([]);
  });
});

describe("evaluateSymbols", () => {
  it("returns pass/fail with failing criteria per symbol", async () => {
    const out = await evaluateSymbols(["GOOD", "CALM", "NOQUOTE"], deps());
    expect(out.get("GOOD")?.passes).toBe(true);
    expect(out.get("CALM")?.failing).toEqual(["volatility"]);
    expect(out.get("NOQUOTE")?.passes).toBe(false);
  });

  it("returns an empty map for no symbols without calling Yahoo", async () => {
    const d = deps();
    expect((await evaluateSymbols([], d)).size).toBe(0);
    expect(d.fetchQuotes).not.toHaveBeenCalled();
  });
});
