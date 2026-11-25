import { describe, it, expect, vi } from "vitest";
import { HttpError } from "@/lib/yahoo-retry";
import { fetchProfilesWith, logProfileStats, profilesLine, PROFILE_CONCURRENCY } from "@/lib/harvester/fundamentals";
import { backfillProfiles, profileBackfillLine, type MemberProfileRow } from "@/lib/harvester/universe/profile-backfill";

const summary = (sector: string | null, industry: string | null) => ({ assetProfile: { sector, industry } });
const noSleep = { sleep: async () => {} };

describe("P3-0i4 profile fetch", () => {
  it("counts failures and keeps the first 3 messages; logs the profiles line and the errors", async () => {
    const syms = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const fail = new Set(["B", "D", "F", "H"]);
    const { profiles, stats } = await fetchProfilesWith(
      syms,
      async (s) => {
        if (fail.has(s)) throw new Error(`Invalid Crumb for ${s}`); // not retryable: fails at once
        return s === "G" ? summary(null, null) : summary("Technology", `Ind-${s}`);
      },
      noSleep,
    );
    expect(stats).toMatchObject({ total: 8, fetched: 3, empty: 1, failed: 4 });
    expect(stats.errors).toHaveLength(3);
    expect(stats.errors.every((e) => /^[BDFH]: Invalid Crumb for [BDFH]$/.test(e))).toBe(true);
    expect([...profiles.keys()].sort()).toEqual(["A", "C", "E"]);
    expect(profiles.get("A")).toEqual({ sector: "Technology", industry: "Ind-A" });

    const log = { log: vi.fn(), warn: vi.fn() };
    logProfileStats(stats, log);
    expect(log.log).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.map((c) => c[0])).toEqual([
      "[universe] profiles: 3/8 fetched, 1 empty, 4 failed (under 80%)",
      ...stats.errors.map((e) => `[universe] profile error: ${e}`),
    ]);
    expect(profilesLine({ ...stats, fetched: 8, empty: 0, failed: 0, errors: [] }).warn).toBe(false);
  });

  it("a 429 is retried through withYahooRetry and then succeeds", async () => {
    let calls = 0;
    const { stats, profiles } = await fetchProfilesWith(
      ["AAPL"],
      async () => {
        calls++;
        if (calls < 3) throw new HttpError(429, 0);
        return summary("Technology", "Consumer Electronics");
      },
      noSleep,
    );
    expect(calls).toBe(3);
    expect(stats).toMatchObject({ fetched: 1, failed: 0 });
    expect(profiles.get("AAPL")?.sector).toBe("Technology");
  });

  it("pauses between batches of 5, not before the first", async () => {
    const sleep = vi.fn(async () => {});
    await fetchProfilesWith(Array.from({ length: 12 }, (_, i) => `S${i}`), async () => summary("X", "Y"), { sleep, pauseMs: 500 });
    expect(PROFILE_CONCURRENCY).toBe(5);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});

describe("P3-0i4 backfill-profiles", () => {
  const rows = (): MemberProfileRow[] => [
    { id: "1", symbol: "AAA", sector: null, industry: null },
    { id: "2", symbol: "BBB", sector: "Energy", industry: "Oil & Gas" }, // complete: never fetched or touched
    { id: "3", symbol: "CCC", sector: "Utilities", industry: null }, // only the industry is filled
    { id: "4", symbol: "DDD", sector: null, industry: null }, // fetch fails: stays null
  ];
  const fetched = new Map([
    ["AAA", { sector: "Technology", industry: "Semiconductors" }],
    ["CCC", { sector: "WRONG", industry: "Utilities—Regulated Electric" }],
  ]);

  it("only fills null fields on the latest universe's members and never overwrites a stored value", async () => {
    const db = new Map(rows().map((r) => [r.id, { ...r }]));
    const setIfNull = vi.fn(async (id: string, field: "sector" | "industry", value: string) => {
      const r = db.get(id)!;
      if (r[field] != null) return 0;
      r[field] = value;
      return 1;
    });
    const fetchProfiles = vi.fn(async (symbols: string[]) => ({
      profiles: new Map([...fetched].filter(([s]) => symbols.includes(s))),
      stats: { total: symbols.length, fetched: 2, empty: 0, failed: 1, errors: ["DDD: HTTP 404"] },
    }));
    const r = await backfillProfiles({ latest: async () => ({ id: "u1", refreshedAt: new Date("2026-11-24T12:00:00Z"), members: rows() }), fetchProfiles, setIfNull });
    expect(fetchProfiles).toHaveBeenCalledWith(["AAA", "CCC", "DDD"]);
    expect(setIfNull.mock.calls).toEqual([["1", "sector", "Technology"], ["1", "industry", "Semiconductors"], ["3", "industry", "Utilities—Regulated Electric"]]);
    expect(db.get("2")).toEqual(rows()[1]);
    expect(db.get("3")!.sector).toBe("Utilities");
    expect(db.get("4")).toEqual(rows()[3]);
    expect(r).toMatchObject({ members: 4, missing: 3, sectorUpdated: 1, industryUpdated: 2 });
    expect(profileBackfillLine(r)).toBe(
      "[backfill-profiles] universe u1 (2026-11-24): 4 stock members, 3 missing a sector or industry; profiles 2/3 fetched, 0 empty, 1 failed; updated sector on 1, industry on 2",
    );
  });

  it("--dry-run writes nothing; no universe is a no-op", async () => {
    const setIfNull = vi.fn(async () => 1);
    const fetchProfiles = async (symbols: string[]) => ({ profiles: fetched, stats: { total: symbols.length, fetched: 2, empty: 0, failed: 1, errors: [] } });
    const r = await backfillProfiles({ latest: async () => ({ id: "u1", refreshedAt: new Date("2026-11-24T12:00:00Z"), members: rows() }), fetchProfiles, setIfNull }, { dryRun: true });
    expect(setIfNull).not.toHaveBeenCalled();
    expect(profileBackfillLine(r)).toContain("DRY RUN");
    expect(profileBackfillLine(r)).toContain("would update sector on 1, industry on 2");
    const none = await backfillProfiles({ latest: async () => null, fetchProfiles, setIfNull });
    expect(profileBackfillLine(none)).toBe("[backfill-profiles] no universe stored; nothing to do");
  });
});
