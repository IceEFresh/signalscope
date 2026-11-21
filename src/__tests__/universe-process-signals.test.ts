import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawSignal } from "@/lib/harvester/types";

const mockCreateScan = vi.fn();
const mockUpdateScan = vi.fn();
const mockCreateManyTicker = vi.fn();
const mockScoreBatch = vi.fn();
const mockLoadUniverse = vi.fn();
const mockRecordWatch = vi.fn();
const mockApplyChecks = vi.fn();
const mockStpCreateMany = vi.fn();

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
    stpSignal: { createMany: (...a: unknown[]) => mockStpCreateMany(...a) },
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
const mockShadowBatch = vi.fn();
vi.mock("@/lib/harvester/scoring", () => ({
  scoreSymbolBatch: (...a: unknown[]) => mockScoreBatch(...a),
  scoreSymbolBatchShadow: (...a: unknown[]) => mockShadowBatch(...a),
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
  mockShadowBatch.mockResolvedValue(new Map());
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
    expect(withF.features).toMatchObject(features);
    // without bar features only the 1b earnings keys are present (all null here: no earnings date)
    expect(without.features).toEqual({
      earnings_date: null, days_to_earnings: null, earnings_within_5d: null,
      earnings_date_is_estimate: null, earnings_window_days: null, options_flow_near_earnings: null,
      // 1f sector keys: no sector, industry or rotation in this fixture
      industry: null, sector_etf: null, industry_etf: null, rs_vs_sector_20d: null, rs_vs_industry_20d: null,
      sector_rank_20d: null, sector_rank_change_4w: null, industry_ticker_count: null,
      // 1d shadow score: none in this fixture
      shadow_ai_score: null, shadow_ai_raw_score: null, shadow_ai_sentiment: null, shadow_ai_model: null,
    });
    // opportunityScore, aiScore, stage, everything else identical
    expect({ ...withF, features: undefined }).toEqual({ ...without, features: undefined });
  });

  it("stores 1g STP rows for every scanned symbol with universe membership, log only", async () => {
    mockStpCreateMany.mockResolvedValue({ count: 2 });
    const stpRow = {
      barDate: "2026-11-19", htfOpens: 1, maState: 1, wellBid: 0, sizeFactor: 1, trigger: 1, triggerType: "inside",
      firedRules: ["inside+"], atr14: 2, fudge: 0.22, entry: 10.22, stop: 8.78, risk: 1.44,
      target2R: 13.1, target3R: 14.54, addLevel2R: 12.22, addLevel3R: 14.22,
    };
    await processSignals(two("LIQD"), { stp: { LIQD: stpRow, NOSIG: { ...stpRow, trigger: 0, triggerType: null } } });
    const data = mockStpCreateMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ scanId: "scan_1", symbol: "LIQD", inUniverse: true, trigger: 1, entry: 10.22 });
    expect(data[1]).toMatchObject({ symbol: "NOSIG", inUniverse: false, trigger: 0 });
    // the ticker row is unaffected by STP data
    expect(rows()[0]).not.toHaveProperty("stp");
  });

  it("does not fail the scan when storing STP rows throws", async () => {
    mockStpCreateMany.mockRejectedValue(new Error("db down"));
    await expect(processSignals(two("LIQD"), { stp: { LIQD: { barDate: null, htfOpens: null, maState: null, wellBid: null, sizeFactor: null, trigger: null, triggerType: null, firedRules: [], atr14: null, fudge: null, entry: null, stop: null, risk: null, target2R: null, target3R: null, addLevel2R: null, addLevel3R: null } } })).resolves.toBe("scan_1");
  });

  it("adds 1b earnings timing to features from the fundamentals, log only", async () => {
    const { fetchFundamentals } = await import("@/lib/harvester/fundamentals");
    const scanStart = new Date("2026-11-20T13:30:00Z"); // Fri 8:30 ET
    mockCreateScan.mockResolvedValue({ id: "scan_1", startedAt: scanStart });
    const earningsTs = Date.parse("2026-11-24T21:05:00Z") / 1000; // Tue after close
    vi.mocked(fetchFundamentals).mockResolvedValueOnce(
      new Map([["LIQD", { ...fund, earningsTs, earningsTsStart: earningsTs, earningsTsEnd: earningsTs, isEarningsDateEstimate: false }]]),
    );
    await processSignals([...two("LIQD"), { symbol: "LIQD", source: "OPTIONS_FLOW", title: "calls" }]);
    expect(rows()[0].features).toMatchObject({
      earnings_date: "2026-11-24",
      days_to_earnings: 4,
      earnings_within_5d: true,
      earnings_date_is_estimate: false,
      earnings_window_days: 0,
      options_flow_near_earnings: true,
    });
  });

  it("stores 1c regime fields on the scan", async () => {
    const regime = { regime_version: 1, spy_close_vs_sma20: -0.03, spy_distribution_days_25: 5, vix_close: 35.9 };
    await processSignals(two("LIQD"), { regime });
    expect(mockUpdateScan).toHaveBeenCalledWith({ where: { id: "scan_1" }, data: { regimeFeatures: regime } });
  });

  it("adds 1f sector/industry keys and industry clustering, and stores the rotation on the scan", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetchFundamentals } = await import("@/lib/harvester/fundamentals");
    vi.mocked(fetchFundamentals).mockResolvedValueOnce(
      new Map([
        ["LIQD", { ...fund, sector: "Technology", industry: "Semiconductors" }],
        ["CHIP", { ...fund, sector: "Technology", industry: "Semiconductors" }],
      ]),
    );
    const etf = (r20: number) => ({ return_20d: r20, return_60d: null, rs_vs_spy_20d: r20, rs_vs_spy_60d: null, rs_vs_spy_20d_4w_ago: null, wtd: null, mtd: null, day: null });
    const sectorRotation = {
      version: 1,
      bar_date: "2026-11-19",
      sectors: [{ sector: "Technology", etf: "XLK", stats: etf(0.02), rank_20d: 3, rank_20d_4w_ago: 7, rank_change_4w: 4, rank_wtd: 1 }],
      etfs: { XLK: etf(0.02), SMH: etf(0.05) },
    };
    await processSignals([...two("LIQD"), ...two("CHIP")], {
      barFeatures: { LIQD: { return_20d: 0.1 } },
      sectorRotation,
    });
    const liqd = rows().find((r) => r.symbol === "LIQD")!;
    expect(liqd.features).toMatchObject({
      industry: "Semiconductors",
      sector_etf: "XLK",
      industry_etf: "SMH",
      sector_rank_20d: 3,
      sector_rank_change_4w: 4,
      industry_ticker_count: 2,
    });
    expect((liqd.features as Record<string, number>).rs_vs_sector_20d).toBeCloseTo(0.08, 12);
    expect((liqd.features as Record<string, number>).rs_vs_industry_20d).toBeCloseTo(0.05, 12);
    expect(mockUpdateScan).toHaveBeenCalledWith({ where: { id: "scan_1" }, data: { sectorRotation } });
    expect(log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[sectors] industries unmapped"))).toBe(
      "[sectors] industries unmapped: 0 distinct",
    );
    log.mockRestore();
  });

  it("stores 1d shadow scores in features without changing aiScore, stage or opportunity score", async () => {
    await processSignals(two("LIQD"));
    const baseline = { ...rows()[0] };
    mockCreateManyTicker.mockClear();
    mockShadowBatch.mockResolvedValue(
      new Map([["LIQD", { score: 22, rawScore: 22, sentiment: "bearish", model: "claude-haiku-5-5" }]]),
    );
    await processSignals(two("LIQD"));
    const row = rows()[0];
    expect(row.features).toMatchObject({
      shadow_ai_score: 22, shadow_ai_raw_score: 22, shadow_ai_sentiment: "bearish", shadow_ai_model: "claude-haiku-5-5",
    });
    expect(row.aiScore).toBe(baseline.aiScore);
    expect(row.stage).toBe(baseline.stage);
    expect(row.opportunityScore).toBe(baseline.opportunityScore);
    // shadow scoring only sees liquid candidates
    const lastBatch = mockShadowBatch.mock.calls.at(-1)![0] as Array<{ symbol: string }>;
    expect(lastBatch.map((a) => a.symbol)).toEqual(["LIQD"]);
  });

  it("keeps the scan going when shadow scoring throws", async () => {
    mockShadowBatch.mockRejectedValue(new Error("anthropic down"));
    await expect(processSignals(two("LIQD"))).resolves.toBe("scan_1");
    expect((rows()[0].features as Record<string, unknown>).shadow_ai_score).toBeNull();
  });
});
