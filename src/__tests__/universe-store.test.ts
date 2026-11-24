import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawSignal } from "@/lib/harvester/types";
import { UNIVERSE_RULE } from "@/lib/harvester/universe/rule";

const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockUniverseCreate = vi.fn();
const mockUniverseFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    graduationWatch: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
    universe: { create: (...a: unknown[]) => mockUniverseCreate(...a), findFirst: (...a: unknown[]) => mockUniverseFindFirst(...a) },
  },
}));

const { saveUniverse, loadUniverse, recordWatchEntries, applyWatchChecks } = await import("@/lib/harvester/universe/store");

const insider: RawSignal = {
  symbol: "SMOL", source: "SEC_INSIDER", author: "Jane Doe", insiderTitle: "CEO",
  purchaseValue: 1e5, filedAt: "2026-11-18", filingKey: "k1",
};

beforeEach(() => vi.clearAllMocks());

describe("saveUniverse", () => {
  it("refuses a build under 50 members", async () => {
    await expect(saveUniverse({ rule: UNIVERSE_RULE, directoryCount: 1, prefilterCount: 1, members: [] })).rejects.toThrow(/not stored/);
    expect(mockUniverseCreate).not.toHaveBeenCalled();
  });

  it("P3-0e: stores stock members as stock and crypto members as crypto; memberCount counts stocks", async () => {
    mockUniverseCreate.mockResolvedValue({ id: "u1" });
    const stock = Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}`, price: 10, marketCap: 1e9, dollarVolume20d: 3e7, atrPct: 0.04, hv20: 0.5, hasOptions: true }));
    const crypto = [{ symbol: "BTC-USD", coingeckoId: "bitcoin", price: 6e4, marketCap: 1e12, dollarVolume20d: 3e10, atrPct: 0.03, hv20: 0.4 }];
    await saveUniverse({ rule: UNIVERSE_RULE, directoryCount: 1, prefilterCount: 1, members: stock, crypto });
    const data = mockUniverseCreate.mock.calls[0][0].data;
    expect(data.memberCount).toBe(50);
    const rows = data.members.createMany.data;
    expect(rows.filter((r: { assetClass: string }) => r.assetClass === "stock")).toHaveLength(50);
    expect(rows.at(-1)).toMatchObject({ symbol: "BTC-USD", assetClass: "crypto", coingeckoId: "bitcoin", hasOptions: false });
  });
});

describe("loadUniverse (P3-0e)", () => {
  it("scans stocks only: crypto members are returned separately, never in symbols", async () => {
    mockUniverseFindFirst.mockResolvedValue({
      id: "u1", refreshedAt: new Date(),
      members: [{ symbol: "AMD", assetClass: null }, { symbol: "NVDA", assetClass: "stock" }, { symbol: "BTC-USD", assetClass: "crypto" }],
    });
    const u = await loadUniverse();
    expect([...u!.symbols].sort()).toEqual(["AMD", "NVDA"]);
    expect(u!.crypto).toEqual(["BTC-USD"]);
  });
});

describe("recordWatchEntries", () => {
  it("creates a new row for a first buy outside the universe", async () => {
    mockFindFirst.mockResolvedValue(null);
    expect(await recordWatchEntries([insider], () => true)).toBe(1);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ symbol: "SMOL", source: "INSIDER", filingKeys: ["k1"], filingCount: 1 });
  });

  it("skips a filing already on the active row", async () => {
    mockFindFirst.mockResolvedValue({ id: "w1", firstFiledAt: new Date(), lastFiledAt: new Date(), actorNames: [], actorRoles: [], filingKeys: ["k1"], totalValue: 1e5, filingCount: 1, isCluster: false, reportingGapDays: null, expiresAt: new Date() });
    expect(await recordWatchEntries([insider], () => true)).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("ignores buys inside the universe", async () => {
    expect(await recordWatchEntries([insider], () => false)).toBe(0);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe("applyWatchChecks", () => {
  it("stamps graduation fields only on graduated rows", async () => {
    await applyWatchChecks(
      [
        { watchId: "w1", failingCriteria: ["options"], graduated: false, flippedCriteria: [] },
        { watchId: "w2", failingCriteria: [], graduated: true, flippedCriteria: ["options"] },
      ],
      "scan_1",
    );
    expect(mockUpdate.mock.calls[0][0].data).not.toHaveProperty("graduatedAt");
    expect(mockUpdate.mock.calls[1][0].data).toMatchObject({ graduatedScanId: "scan_1", flippedCriteria: ["options"] });
  });
});
