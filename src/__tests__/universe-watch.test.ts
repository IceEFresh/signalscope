import { describe, it, expect } from "vitest";
import type { RawSignal } from "@/lib/harvester/types";
import {
  applyWatchResults,
  mergeWatchEntry,
  watchEntriesFromSignals,
  WATCH_DAYS,
  type ActiveWatchRow,
  type WatchEntry,
} from "@/lib/harvester/universe/watch";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-20T13:30:00Z");
const outside = (s: string) => s !== "LIQD";

const insider = (over: Partial<RawSignal> = {}): RawSignal => ({
  symbol: "SMOL",
  source: "SEC_INSIDER",
  author: "Jane Doe",
  insiderTitle: "CEO",
  purchaseValue: 120_000,
  filedAt: "2026-11-18",
  filingKey: "insider:SMOL|Jane Doe|2026-11-17|1000|120",
  ...over,
});

const congress = (over: Partial<RawSignal> = {}): RawSignal => ({
  symbol: "SMOL",
  source: "CONGRESS",
  author: "Rep. John Roe",
  purchaseValue: 15_001,
  filedAt: "2026-11-19T00:00:00Z",
  filingKey: "congress:123",
  reportingGapDays: 30,
  ...over,
});

describe("watchEntriesFromSignals", () => {
  it("watches insider and congress buys only on symbols outside the universe", () => {
    const entries = watchEntriesFromSignals(
      [insider(), insider({ symbol: "LIQD", filingKey: "k2" }), congress(), { symbol: "SMOL", source: "REDDIT" }],
      outside,
    );
    expect(entries.map((e) => [e.symbol, e.source])).toEqual([
      ["SMOL", "INSIDER"],
      ["SMOL", "POLITICIAN"],
    ]);
    expect(entries[1].reportingGapDays).toBe(30);
  });

  it("applies the $15K politician floor and the $50K insider floor", () => {
    const entries = watchEntriesFromSignals(
      [congress({ purchaseValue: 14_999 }), insider({ purchaseValue: 49_999 })],
      outside,
    );
    expect(entries).toEqual([]);
  });

  it("skips signals without a filing key and keeps a null date for a bad filedAt", () => {
    expect(watchEntriesFromSignals([insider({ filingKey: undefined })], outside)).toEqual([]);
    expect(watchEntriesFromSignals([insider({ filedAt: "not a date" })], outside)[0].filedAt).toBeNull();
  });
});

describe("mergeWatchEntry", () => {
  const entry = (over: Partial<WatchEntry> = {}): WatchEntry => ({
    symbol: "SMOL",
    source: "INSIDER",
    filingKey: "a",
    filedAt: new Date("2026-11-18T00:00:00Z"),
    actorName: "Jane Doe",
    actorRole: "CEO",
    value: 100_000,
    reportingGapDays: null,
    ...over,
  });

  it("starts a row that expires 90 days after the filing", () => {
    const row = mergeWatchEntry(null, entry(), now)!;
    expect(row.filingCount).toBe(1);
    expect(row.totalValue).toBe(100_000);
    expect(row.isCluster).toBe(false);
    expect(row.expiresAt.getTime() - row.lastFiledAt.getTime()).toBe(WATCH_DAYS * DAY);
  });

  it("ignores a filing already on the row (repeat listing on a later run)", () => {
    const row = mergeWatchEntry(null, entry(), now)!;
    expect(mergeWatchEntry(row, entry(), now)).toBeNull();
  });

  it("marks a cluster when a second insider buys, sums value and extends expiry", () => {
    const first = mergeWatchEntry(null, entry(), now)!;
    const second = mergeWatchEntry(
      first,
      entry({ filingKey: "b", actorName: "Bob Roe", actorRole: "CFO", value: 60_000, filedAt: new Date("2026-11-20T00:00:00Z") }),
      now,
    )!;
    expect(second.isCluster).toBe(true);
    expect(second.actorNames).toEqual(["Jane Doe", "Bob Roe"]);
    expect(second.totalValue).toBe(160_000);
    expect(second.firstFiledAt.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(second.expiresAt.toISOString()).toBe(new Date(Date.parse("2026-11-20T00:00:00Z") + WATCH_DAYS * DAY).toISOString());
  });

  it("does not mark a cluster for the same insider buying twice", () => {
    const first = mergeWatchEntry(null, entry(), now)!;
    expect(mergeWatchEntry(first, entry({ filingKey: "b" }), now)!.isCluster).toBe(false);
  });

  it("keeps value null when no filing has a value", () => {
    expect(mergeWatchEntry(null, entry({ value: null }), now)!.totalValue).toBeNull();
  });
});

describe("applyWatchResults", () => {
  const row: ActiveWatchRow = {
    id: "w1",
    symbol: "SMOL",
    source: "INSIDER",
    firstFiledAt: "2026-11-01T00:00:00.000Z",
    lastFiledAt: "2026-11-10T00:00:00.000Z",
    totalValue: 250_000,
    isCluster: true,
    failingCriteria: ["dollarVolume", "options"],
  };

  it("emits one GRADUATION signal with source, filing age, value and flipped criteria", () => {
    const { checks, signals } = applyWatchResults([row], new Map([["SMOL", { passes: true, failing: [] }]]), now);
    expect(checks).toEqual([{ watchId: "w1", failingCriteria: [], graduated: true, flippedCriteria: ["dollarVolume", "options"] }]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      symbol: "SMOL",
      source: "GRADUATION",
      graduationSource: "INSIDER",
      filingAgeDays: 10,
      purchaseValue: 250_000,
      flippedCriteria: ["dollarVolume", "options"],
    });
    expect(signals[0].body).toContain("cluster");
  });

  it("records failing criteria without a signal when the rule still fails", () => {
    const { checks, signals } = applyWatchResults([row], new Map([["SMOL", { passes: false, failing: ["dollarVolume"] }]]), now);
    expect(checks[0]).toMatchObject({ graduated: false, failingCriteria: ["dollarVolume"], flippedCriteria: [] });
    expect(signals).toEqual([]);
  });

  it("leaves a row untouched when its fetch failed", () => {
    expect(applyWatchResults([row], new Map(), now)).toEqual({ checks: [], signals: [] });
  });

  it("emits one signal per symbol even with an insider and a politician row", () => {
    const pol = { ...row, id: "w2", source: "POLITICIAN" as const };
    const { checks, signals } = applyWatchResults([row, pol], new Map([["SMOL", { passes: true, failing: [] }]]), now);
    expect(checks).toHaveLength(2);
    expect(signals).toHaveLength(1);
  });
});
