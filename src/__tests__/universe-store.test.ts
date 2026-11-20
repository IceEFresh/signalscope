import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawSignal } from "@/lib/harvester/types";
import { UNIVERSE_RULE } from "@/lib/harvester/universe/rule";

const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockUniverseCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    graduationWatch: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
    universe: { create: (...a: unknown[]) => mockUniverseCreate(...a) },
  },
}));

const { saveUniverse, recordWatchEntries, applyWatchChecks } = await import("@/lib/harvester/universe/store");

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
