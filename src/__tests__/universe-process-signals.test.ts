import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawSignal } from "@/lib/harvester/types";

const mockCreateScan = vi.fn();
const mockUpdateScan = vi.fn();
const mockCreateManyTicker = vi.fn();
const mockScoreBatch = vi.fn();
const mockLoadUniverse = vi.fn();
const mockRecordWatch = vi.fn();
const mockApplyChecks = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    scan: {
      create: (...a: unknown[]) => mockCreateScan(...a),
      update: (...a: unknown[]) => mockUpdateScan(...a),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    signal: { findMany: vi.fn().mockResolvedValue([]) },
    validatedTicker: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        signal: { createMany: vi.fn(), updateMany: vi.fn() },
        validatedTicker: { createMany: (...a: unknown[]) => mockCreateManyTicker(...a) },
        scan: { update: mockUpdateScan },
      }),
  },
  createDevPrismaClient: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/ai", () => ({ resetCostTracker: vi.fn(), getTotalCost: vi.fn().mockReturnValue(0) }));
vi.mock("@/lib/harvester/scoring", () => ({
  scoreSymbolBatch: (...a: unknown[]) => mockScoreBatch(...a),
  defaultScore: vi.fn((agg: { symbol: string }) => ({ symbol: agg.symbol, score: 20, sentiment: "neutral", rawScore: 20 })),
}));
vi.mock("@/lib/harvester/pnd-filter", () => ({
  checkPndFlags: vi.fn().mockReturnValue({ flagged: false, flags: [], score: 0 }),
  aiPndAssessment: vi.fn(),
  PND_THRESHOLD: 3,
  INFORMATIONAL_FLAGS: new Set<string>(),
}));
const fund = { price: 20, marketCap: 2e9, shortFloat: null, wk52Lo: 10, wk52Hi: 30, exchange: "NasdaqGS" };
vi.mock("@/lib/harvester/fundamentals", () => ({
  fetchFundamentals: vi.fn(async (syms: string[]) => new Map(syms.map((s) => [s, fund]))),
}));
vi.mock("@/lib/harvester/universe/store", () => ({
  loadUniverse: (...a: unknown[]) => mockLoadUniverse(...a),
  recordWatchEntries: (...a: unknown[]) => mockRecordWatch(...a),
  applyWatchChecks: (...a: unknown[]) => mockApplyChecks(...a),
}));

const { processSignals, ILLIQUID_FILTER_REASON } = await import("@/lib/harvester/index");
const { deriveRecommendation } = await import("@/lib/harvester/recommendation");

const two = (symbol: string): RawSignal[] => [
  { symbol, source: "REDDIT", title: "a", postAge: 1, sortType: "rising", subreddit: "stocks" },
  { symbol, source: "STOCKTWITS", title: "b" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateScan.mockResolvedValue({ id: "scan_1", startedAt: new Date() });
  mockScoreBatch.mockImplementation(async (batch: Array<{ symbol: string }>) =>
    batch.map((b) => ({ symbol: b.symbol, score: 70, sentiment: "bullish", reasoning: "r", rawScore: 70 })),
  );
  mockLoadUniverse.mockResolvedValue({ id: "u1", refreshedAt: new Date(), symbols: new Set(["LIQD"]) });
  mockRecordWatch.mockResolvedValue(0);
  mockApplyChecks.mockResolvedValue(undefined);
});

function rows() {
  return mockCreateManyTicker.mock.calls[0][0].data as Array<Record<string, unknown>>;
}

describe("processSignals with a universe (PR 1-0)", () => {
  it("FILTERS candidates outside the universe as illiquid, without AI scoring, and they label Avoid", async () => {
    await processSignals([...two("LIQD"), ...two("SMOL")], {
      universeId: "u1",
      barMetrics: { LIQD: { dollarVolume20d: 5e7, atrPct: 0.05, hv20: 0.6 } },
    });

    const scored = mockScoreBatch.mock.calls.flatMap((c) => (c[0] as Array<{ symbol: string }>).map((a) => a.symbol));
    expect(scored).toEqual(["LIQD"]);

    const liqd = rows().find((r) => r.symbol === "LIQD")!;
    const smol = rows().find((r) => r.symbol === "SMOL")!;
    expect(liqd).toMatchObject({ inUniverse: true, filterReason: null, dollarVolume20d: 5e7, atrPct: 0.05 });
    expect(liqd.stage).not.toBe("FILTERED");
    expect(smol).toMatchObject({ stage: "FILTERED", inUniverse: false, filterReason: ILLIQUID_FILTER_REASON });
    expect(smol.dollarVolume20d).toBeNull(); // missing bars stored as null, never 0
    expect(smol.atrPct).toBeNull();

    expect(
      deriveRecommendation({
        aiScore: 99, stage: "FILTERED", sourceCount: 3, hasCatalystSource: true, pndFlagged: false,
        price: 20, marketCap: 2e9, medianSignalAgeHrs: null,
      }),
    ).toBe("Avoid");

    expect(mockUpdateScan).toHaveBeenCalledWith({ where: { id: "scan_1" }, data: { universeId: "u1" } });
    expect(mockLoadUniverse).toHaveBeenCalledWith("u1");
  });

  it("FILTERS out-of-universe non-candidates too", async () => {
    await processSignals([{ symbol: "LONE", source: "REDDIT", title: "x" }]);
    expect(rows()[0]).toMatchObject({ symbol: "LONE", stage: "FILTERED", filterReason: "illiquid" });
  });

  it("treats a ticker with a GRADUATION signal as inside the universe", async () => {
    await processSignals([{ symbol: "GRAD", source: "GRADUATION", title: "g", graduationSource: "INSIDER" }]);
    const grad = rows()[0];
    expect(grad).toMatchObject({ symbol: "GRAD", inUniverse: true, filterReason: null, signalType: "graduation" });
    expect(grad.stage).not.toBe("FILTERED");
  });

  it("turns the gate off when no universe is stored yet", async () => {
    mockLoadUniverse.mockResolvedValue(null);
    await processSignals(two("SMOL"));
    expect(rows()[0]).toMatchObject({ inUniverse: null, filterReason: null });
    expect(rows()[0].stage).not.toBe("FILTERED");
  });

  it("does not fail the scan when the universe load or the watch update throws", async () => {
    mockLoadUniverse.mockRejectedValue(new Error("db down"));
    mockRecordWatch.mockRejectedValue(new Error("db down"));
    await expect(processSignals(two("SMOL"))).resolves.toBe("scan_1");
    expect(rows()[0].inUniverse).toBeNull();
  });

  it("records watch entries with the illiquid check and applies watch checks", async () => {
    const checks = [{ watchId: "w1", failingCriteria: [], graduated: true, flippedCriteria: ["options"] }];
    await processSignals(two("SMOL"), { watchChecks: checks });
    const isOutside = mockRecordWatch.mock.calls[0][1] as (s: string) => boolean;
    expect(isOutside("SMOL")).toBe(true);
    expect(isOutside("LIQD")).toBe(false);
    expect(mockApplyChecks).toHaveBeenCalledWith(checks, "scan_1");
  });

  it("stores 1a bar features as-is and does not change any score, stage or label input (log only)", async () => {
    const features = { features_version: 1, close_vs_sma20: 0.05, nr7: true, bar_date: "2026-11-19", rsi14: null };
    await processSignals(two("LIQD"), { barMetrics: { LIQD: { dollarVolume20d: 5e7, atrPct: 0.05, hv20: 0.6 } } });
    const without = { ...rows()[0] };
    mockCreateManyTicker.mockClear();
    await processSignals(two("LIQD"), {
      barMetrics: { LIQD: { dollarVolume20d: 5e7, atrPct: 0.05, hv20: 0.6 } },
      barFeatures: { LIQD: features },
    });
    const withF = rows()[0];
    expect(withF.features).toEqual(features);
    expect(without.features).toBeUndefined(); // column left null when no features
    // opportunityScore, aiScore, stage, everything else identical
    expect({ ...withF, features: undefined }).toEqual({ ...without, features: undefined });
  });
});
