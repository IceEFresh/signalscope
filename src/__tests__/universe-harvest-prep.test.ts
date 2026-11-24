import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  computeIngestExtras,
  computeStpExtras,
  isStale,
  prepareHarvest,
  universeUrlFrom,
  type HarvestPrepDeps,
} from "@/lib/harvester/universe/harvest-prep";
import { SCAN_SYMBOLS } from "@/lib/harvester/sources/ticker-utils";
import type { BarMetrics } from "@/lib/harvester/universe/bar-metrics";
import type { UniverseBuildResult } from "@/lib/harvester/universe/build";
import { UNIVERSE_RULE } from "@/lib/harvester/universe/rule";

const now = new Date("2026-11-20T13:30:00Z");
const fresh = { id: "u1", refreshedAt: "2026-11-18T13:00:00Z", symbols: ["AAA", "BBB"] };
const build: UniverseBuildResult = {
  rule: UNIVERSE_RULE,
  directoryCount: 10,
  prefilterCount: 5,
  members: [{ symbol: "NEW", price: 10, marketCap: 1e9, dollarVolume20d: 3e7, atrPct: 0.04, hv20: 0.5, hasOptions: true }],
};

function deps(over: Partial<HarvestPrepDeps> = {}): HarvestPrepDeps {
  return {
    getState: vi.fn(async () => ({ universe: fresh, watch: [] })),
    build: vi.fn(async () => build),
    postBuild: vi.fn(async () => "u2"),
    now: () => now,
    ...over,
  };
}

describe("universeUrlFrom", () => {
  it("derives the universe endpoint from the ingest endpoint unless overridden", () => {
    expect(universeUrlFrom("http://web:3000/api/harvest/ingest")).toBe("http://web:3000/api/harvest/universe");
    expect(universeUrlFrom("http://web:3000/api/harvest/ingest", "http://x/u")).toBe("http://x/u");
  });
});

describe("isStale", () => {
  it("is stale after 7 days, when missing, or when unparseable", () => {
    expect(isStale("2026-11-14T13:00:00Z", now)).toBe(false);
    expect(isStale("2026-11-13T13:00:00Z", now)).toBe(true);
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale("garbage", now)).toBe(true);
  });
});

describe("prepareHarvest", () => {
  it("uses a fresh universe without rebuilding", async () => {
    const d = deps();
    expect(await prepareHarvest(d)).toEqual({ universeId: "u1", scanSymbols: ["AAA", "BBB"], profiles: {}, cryptoSymbols: [], watch: [] });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("rebuilds and posts a stale universe", async () => {
    const d = deps({ getState: async () => ({ universe: { ...fresh, refreshedAt: "2026-11-01T00:00:00Z" }, watch: [] }) });
    const prep = await prepareHarvest(d);
    expect(prep).toMatchObject({ universeId: "u2", scanSymbols: ["NEW"] });
    expect(d.postBuild).toHaveBeenCalledWith(build);
  });

  it("keeps the previous universe when the rebuild fails", async () => {
    const stale = { ...fresh, refreshedAt: "2026-11-01T00:00:00Z" };
    const prep = await prepareHarvest(deps({ getState: async () => ({ universe: stale, watch: [] }), build: async () => { throw new Error("yahoo down"); } }));
    expect(prep).toMatchObject({ universeId: "u1", scanSymbols: ["AAA", "BBB"] });
  });

  it("falls back to static SCAN_SYMBOLS and skips the rebuild when the web app is unreachable", async () => {
    const d = deps({ getState: async () => { throw new Error("503"); } });
    const prep = await prepareHarvest(d);
    expect(prep).toEqual({ universeId: null, scanSymbols: SCAN_SYMBOLS, profiles: {}, cryptoSymbols: [], watch: [] });
    expect(d.build).not.toHaveBeenCalled();
    expect(d.postBuild).not.toHaveBeenCalled();
  });

  it("falls back to static SCAN_SYMBOLS when there is no universe and storing the rebuild fails", async () => {
    const prep = await prepareHarvest(
      deps({ getState: async () => ({ universe: null, watch: [] }), postBuild: async () => { throw new Error("503"); } }),
    );
    expect(prep).toEqual({ universeId: null, scanSymbols: SCAN_SYMBOLS, profiles: {}, cryptoSymbols: [], watch: [] });
  });
});

describe("computeIngestExtras", () => {
  const metric: BarMetrics = { lastClose: 10, dollarVolume20d: 3e7, atrPct: 0.04, hv20: 0.5, barCount: 63 };
  const watchRow = {
    id: "w1", symbol: "SMOL", source: "INSIDER" as const, firstFiledAt: "2026-11-01T00:00:00Z",
    lastFiledAt: "2026-11-10T00:00:00Z", totalValue: 1e5, isCluster: false, failingCriteria: ["dollarVolume"],
  };

  it("fetches bars once for signal and watch symbols and emits graduations", async () => {
    const fetchMetrics = vi.fn(async (s: string[]) => new Map(s.filter((x) => x !== "FAIL").map((x) => [x, metric])));
    const evaluate = vi.fn(async () => new Map([["SMOL", { passes: true, failing: [], metrics: metric }]]));
    const fetchFeatures = vi.fn(async (s: string[]) => Object.fromEntries(s.map((x) => [x, { features_version: 1 } as never])));
    const out = await computeIngestExtras(
      [{ symbol: "AAA", source: "REDDIT" }, { symbol: "AAA", source: "TWITTER" }, { symbol: "FAIL", source: "REDDIT" }],
      [watchRow],
      fetchMetrics,
      evaluate,
      now,
      fetchFeatures,
    );
    // Features only for signal symbols whose chart loaded (not FAIL, not the watch-only SMOL)
    expect(fetchFeatures).toHaveBeenCalledWith(["AAA"]);
    expect(Object.keys(out.barFeatures)).toEqual(["AAA"]);
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    expect(fetchMetrics).toHaveBeenCalledWith(["AAA", "FAIL", "SMOL"]);
    expect(Object.keys(out.barMetrics).sort()).toEqual(["AAA", "SMOL"]); // FAIL absent, not zero
    expect(out.barMetrics.AAA).toEqual({ dollarVolume20d: 3e7, atrPct: 0.04, hv20: 0.5 });
    expect(out.watchChecks).toEqual([{ watchId: "w1", failingCriteria: [], graduated: true, flippedCriteria: ["dollarVolume"] }]);
    expect(out.graduationSignals.map((s) => [s.symbol, s.source])).toEqual([["SMOL", "GRADUATION"]]);
  });

  it("returns empty extras instead of throwing when every fetch fails", async () => {
    const out = await computeIngestExtras(
      [{ symbol: "AAA", source: "REDDIT" }],
      [watchRow],
      async () => { throw new Error("network"); },
      async () => { throw new Error("network"); },
      now,
      async () => { throw new Error("network"); },
    );
    expect(out).toEqual({ barMetrics: {}, barFeatures: {}, watchChecks: [], graduationSignals: [] });
  });
});

describe("computeStpExtras (PLAN.md 1g)", () => {
  const amd = JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-AMD-3mo.json"), "utf8"));

  it("computes STP for every symbol from cached charts, de-duplicated, skipping failed charts", async () => {
    const getChart = vi.fn(async (s: string) =>
      s === "BAD" ? { ok: false as const, status: 500, rateLimited: false } : { ok: true as const, json: amd },
    );
    const fetchQuotes = vi.fn(async () => new Map([["AMD", { earningsTs: null }]]));
    const out = await computeStpExtras(["AMD", "AMD", "BAD"], fetchQuotes, getChart as never);
    expect(Object.keys(out)).toEqual(["AMD"]);
    expect(getChart).toHaveBeenCalledTimes(2);
    expect(out.AMD.atr14).toBeGreaterThan(0);
  });

  it("still computes STP when the earnings quote batch fails", async () => {
    const out = await computeStpExtras(
      ["AMD"],
      async () => { throw new Error("crumb"); },
      (async () => ({ ok: true as const, json: amd })) as never,
    );
    expect(out.AMD).toBeDefined();
  });

  it("returns {} for no symbols without fetching", async () => {
    const fetchQuotes = vi.fn();
    expect(await computeStpExtras([], fetchQuotes as never)).toEqual({});
    expect(fetchQuotes).not.toHaveBeenCalled();
  });
});
