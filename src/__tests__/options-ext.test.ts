import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const mockOptions = vi.fn();
vi.mock("@/lib/yahoo-finance", () => ({
  yahooFinance: { options: (...a: unknown[]) => mockOptions(...a) },
  withYahooTimeout: <T,>(p: Promise<T>) => p,
}));

import { clearOptionsCache, fetchOptionsRaw, peekOptionsRaw } from "@/lib/harvester/options-chain";
import { optFeaturesFromChain, optionsExtLine, scanOptionsExt, withOptFeatures, OPT_EXT_KEYS, type OptFeatures } from "@/lib/harvester/options-ext";
import { optionsFeatureHits, updateWatchStore } from "@/lib/harvester/watchlist";
import { isLiveStpKey } from "@/lib/health/harvest-health";
import { resetYahooHealth, yahoo429s } from "@/lib/yahoo-retry";

const EXP = new Date("2026-12-18T00:00:00Z");
type C = [strike: number, volume: number, oi: number, bid?: number, ask?: number];
const contract = ([strike, volume, openInterest, bid = 1, ask = 1]: C) => ({ contractSymbol: `X${strike}`, strike, volume, openInterest, expiration: EXP, impliedVolatility: 0.5, inTheMoney: false, bid, ask });
const chain = (calls: C[], puts: C[] = [], price: number | null = 100) => ({ quote: { regularMarketPrice: price ?? undefined }, options: [{ calls: calls.map(contract), puts: puts.map(contract) }] });

// Three unusual OTM calls on one expiry (a sweep), one ordinary call, one unusual put
const SWEEP = chain(
  [
    [115, 5_000, 1_000],
    [120, 4_000, 1_000],
    [125, 3_000, 900],
    [100, 500, 10_000],
  ],
  [[85, 2_000, 500]],
);

describe("optFeaturesFromChain", () => {
  it("counts the options-flow unusual contracts (calls and puts), flags a call sweep and reads the premium", () => {
    const f = optFeaturesFromChain("X", SWEEP)!;
    expect(f.opt_scanned).toBe(true);
    expect(f.opt_unusual_n).toBe(4);
    expect(f.opt_sweep).toBe(true);
    // calls (5000+4000+3000+500) × $1 × 100 = 1.25M; puts 2000 × 100 = 0.2M
    expect(f.opt_net_premium).toBe(1_050_000);
    expect(f.opt_call_premium_ratio).toBeCloseTo(1_250_000 / 1_450_000, 4);
    expect(f.opt_top_type).toBe("Call");
    expect(Object.keys(f).sort()).toEqual([...OPT_EXT_KEYS].sort());
  });

  it("uses the same thresholds: vol/OI under 3, volume under 1,000 or OI under 100 aren't unusual", () => {
    const f = optFeaturesFromChain("X", chain([[110, 2_999, 1_000], [111, 999, 100], [112, 5_000, 99]]))!;
    expect(f.opt_unusual_n).toBe(0);
    expect(f.opt_sweep).toBe(false);
  });

  it("puts on top, and two unusual call strikes aren't a sweep", () => {
    const f = optFeaturesFromChain("X", chain([[115, 5_000, 1_000], [120, 4_000, 1_000]], [[80, 20_000, 1_000]]))!;
    expect(f.opt_sweep).toBe(false);
    expect(f.opt_top_type).toBe("Put");
    expect(f.opt_net_premium!).toBeLessThan(0);
  });

  it("no traded contract: scanned, zero unusual, premium keys null (not 0)", () => {
    const f = optFeaturesFromChain("X", chain([[110, 0, 500]]))!;
    expect(f).toMatchObject({ opt_scanned: true, opt_unusual_n: 0, opt_net_premium: null, opt_call_premium_ratio: null, opt_top_type: null });
  });

  it("null when the chain can't be read (no price, no expiry block)", () => {
    expect(optFeaturesFromChain("X", chain([[110, 5_000, 100]], [], null))).toBeNull();
    expect(optFeaturesFromChain("X", { quote: { regularMarketPrice: 10 }, options: [] })).toBeNull();
    expect(optFeaturesFromChain("X", null)).toBeNull();
  });

  it("reads a real Yahoo chain (saved AMD fixture)", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "fixtures/options/yahoo-AMD-near.json"), "utf8")).optionChain.result[0];
    const f = optFeaturesFromChain("AMD", raw)!;
    expect(f.opt_scanned).toBe(true);
    expect(f.opt_net_premium).not.toBeNull();
    expect(f.opt_unusual_n).toBeGreaterThanOrEqual(0);
  });
});

describe("scanOptionsExt", () => {
  it("universe symbols read the run cache only (no fetch); watch_only names are fetched in batches of 5 with a 2 s delay", async () => {
    const universe = ["U1", "U2"];
    const watchOnly = Array.from({ length: 12 }, (_, i) => `W${i}`);
    const peek = vi.fn((s: string) => (s === "U1" ? Promise.resolve(SWEEP) : undefined));
    const fetch = vi.fn(async (s: string) => (s === "W3" ? Promise.reject(new Error("HTTP 404")) : chain([[110, 10, 10]])));
    const sleep = vi.fn(async () => {});
    const { features, stats } = await scanOptionsExt(universe, watchOnly, { peek, fetch, sleep });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(watchOnly);
    expect(peek.mock.calls.map((c) => c[0])).toEqual(universe);
    expect(sleep.mock.calls).toEqual([[2_000], [2_000]]); // 3 batches: 5, 5, 2
    expect(stats).toEqual({ targets: 14, scanned: 12, unusual: 1, failed: 2 });
    // Null on failure: U2 (not cached) and W3 (fetch failed) get no keys at all
    expect(features.U2).toBeUndefined();
    expect(features.W3).toBeUndefined();
    expect(features.U1.opt_unusual_n).toBe(4);
    expect(features.W0.opt_unusual_n).toBe(0);
  });

  it("a cached request that failed counts as failed and never throws", async () => {
    const out = await scanOptionsExt(["U1"], [], { peek: () => Promise.reject(new Error("crumb")), fetch: vi.fn() });
    expect(out.stats).toEqual({ targets: 1, scanned: 0, unusual: 0, failed: 1 });
  });

  it("a name in both lists is fetched once and counted once", async () => {
    const fetch = vi.fn(async () => SWEEP);
    const out = await scanOptionsExt(["A", "A"], ["A"], { peek: () => undefined, fetch, sleep: async () => {} });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.stats.targets).toBe(1);
  });

  it("returns features only: no OPTIONS_FLOW signals for the expanded symbols", async () => {
    const out = await scanOptionsExt([], ["W"], { peek: () => undefined, fetch: async () => SWEEP, sleep: async () => {} });
    expect(Object.keys(out).sort()).toEqual(["features", "stats"]);
    expect(JSON.stringify(out)).not.toContain("OPTIONS_FLOW");
  });
});

describe("withOptFeatures", () => {
  it("puts the keys on the scanned symbol's row only (snapshot or watch_only row)", () => {
    const f: Record<string, OptFeatures> = { AAA: optFeaturesFromChain("AAA", SWEEP)! };
    const rows = [
      { symbol: "AAA", features: { p3k3_candidate: true } },
      { symbol: "BBB", features: { p3k3_candidate: false } },
    ];
    const out = withOptFeatures(rows, f);
    expect(out[0].features).toMatchObject({ p3k3_candidate: true, opt_scanned: true, opt_unusual_n: 4, opt_sweep: true });
    expect(out[1]).toBe(rows[1]);
    expect("opt_scanned" in out[1].features).toBe(false);
    expect(rows[0].features).toEqual({ p3k3_candidate: true }); // input untouched
  });
});

describe("optionsExtLine", () => {
  it("formats the health line and warns above 20% failed", () => {
    expect(optionsExtLine({ targets: 10, scanned: 8, unusual: 3, failed: 2 }, 1)).toEqual({ line: "[options-ext] scanned 8/10, unusual hits 3, failed 2, 429s 1", warn: false });
    const w = optionsExtLine({ targets: 10, scanned: 7, unusual: 0, failed: 3 }, 0);
    expect(w.warn).toBe(true);
    expect(w.line).toContain("WARNING: over 20% failed");
    expect(optionsExtLine({ targets: 0, scanned: 0, unusual: 0, failed: 0 }, 0).warn).toBe(false);
  });
});

describe("watchlist reads opt_unusual_n", () => {
  const f = (opt_unusual_n: number, opt_net_premium: number | null) => ({ opt_unusual_n, opt_net_premium });
  it("a hit when opt_unusual_n ≥ 1, direction from the net premium's sign; zero or unknown premium isn't a hit", () => {
    expect(optionsFeatureHits({ aaa: f(2, 5_000), BBB: f(1, -10), CCC: f(0, 9_999), DDD: f(3, 0), EEE: f(3, null) })).toEqual([
      { symbol: "AAA", source: "options", direction: "bullish" },
      { symbol: "BBB", source: "options", direction: "bearish" },
    ]);
  });

  it("feeds the store like any other options hit", () => {
    const store = updateWatchStore(null, optionsFeatureHits({ AAA: f(1, 100) }), "2026-11-26");
    expect(store.entries.AAA.sources.options).toEqual({ last: "2026-11-26", direction: "bullish" });
  });
});

describe("fetch path: 429s", () => {
  beforeEach(() => {
    clearOptionsCache();
    resetYahooHealth();
    mockOptions.mockReset();
    process.env.YAHOO_RETRY_BASE_MS = "0";
  });

  it("a 429 is retried with the existing backoff and counted for the [options-ext] line", async () => {
    mockOptions.mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 })).mockResolvedValueOnce(SWEEP);
    const out = await scanOptionsExt([], ["W"], { peek: peekOptionsRaw, fetch: (s) => fetchOptionsRaw(s), sleep: async () => {} });
    expect(mockOptions).toHaveBeenCalledTimes(2);
    expect(out.features.W.opt_unusual_n).toBe(4);
    expect(yahoo429s("options")).toBe(1);
    // Now cached for the run: the universe path reads it without a new request
    await scanOptionsExt(["W"], [], { peek: peekOptionsRaw, fetch: vi.fn() });
    expect(mockOptions).toHaveBeenCalledTimes(2);
  });

  it("a 404 isn't counted as a 429 and isn't retried", async () => {
    mockOptions.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const out = await scanOptionsExt([], ["W"], { peek: peekOptionsRaw, fetch: (s) => fetchOptionsRaw(s), sleep: async () => {} });
    expect(mockOptions).toHaveBeenCalledTimes(1);
    expect(out.stats.failed).toBe(1);
    expect(yahoo429s("options")).toBe(0);
  });
});

describe("health", () => {
  it("the opt_* snapshot keys are log-only live keys, not the 1h opt family", () => {
    for (const k of OPT_EXT_KEYS) expect(isLiveStpKey(k), k).toBe(true);
    expect(isLiveStpKey("opt_call_premium")).toBe(false);
  });
});
