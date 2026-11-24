import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotRow, computeSnapshotRows, chunk, SNAPSHOT_BATCH, BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { writeSnapshotRows } from "@/lib/harvester/universe/snapshot-store";
import { parseChartBars } from "@/lib/harvester/universe/bar-metrics";
import type { StpResult } from "@/lib/harvester/universe/stp";
import { buildUniverseRows, type StoredSnapshotRow } from "@/lib/eval/universe-dataset";
import { LookAheadError, type SpyClose } from "@/lib/eval/dataset";
import { candidateKeys } from "@/lib/eval/features";
import { analyzeScan, flagsFor, renderText, type ScanInput } from "@/lib/health/harvest-health";
import type { EvalRow } from "@/lib/eval/rules";

const raw = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures/universe", f), "utf8")) as unknown;
const NOW = new Date("2030-01-01T00:00:00Z");
const amdBars = parseChartBars(raw("chart-AMD-3mo.json"), NOW);
const spyBars = parseChartBars(raw("chart-SPY-3mo.json"), NOW);

function stpFor(barDate: string | null): StpResult {
  return {
    barDate, htfOpens: 1, maState: 1, wellBid: 0, sizeFactor: 1, trigger: 0, triggerType: null, firedRules: [],
    atr14: null, fudge: null, entry: null, stop: null, risk: null, target2R: null, target3R: null, addLevel2R: null, addLevel3R: null,
  };
}

describe("snapshot rows (harvester side)", () => {
  it("builds a row from the real AMD chart: session date, close, bar features and STP states", () => {
    const last = amdBars.at(-1)!;
    const row = snapshotRow("AMD", amdBars, spyBars, stpFor(null))!;
    expect(row.symbol).toBe("AMD");
    expect(row.close).toBe(last.close);
    expect(row.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.features).toMatchObject({ snapshot_version: 1, bar_date: row.sessionDate });
    expect(typeof row.features.rsi14).toBe("number");
    // STP from a different bar date is not attached
    expect(row.features.stp_ma_state).toBeNull();
    const withStp = snapshotRow("AMD", amdBars, spyBars, stpFor(row.sessionDate))!;
    expect(withStp.features).toMatchObject({ stp_ma_state: 1, stp_well_bid: 0, stp_size_factor: 1 });
  });

  it("uses cached charts only: no fetch, uncached symbols left out, SPY always included", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cache: Record<string, unknown> = { AMD: raw("chart-AMD-3mo.json"), SPY: raw("chart-SPY-3mo.json") };
    const peek = (s: string) => (cache[s] ? Promise.resolve({ ok: true as const, json: cache[s] }) : undefined);
    const { rows, missing } = await computeSnapshotRows(["AMD", "NOTCACHED"], {}, peek);
    expect(rows.map((r) => r.symbol).sort()).toEqual(["AMD", BENCHMARK_SYMBOL]);
    expect(missing).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("batches rows in chunks of 500, and writes each chunk with createMany", async () => {
    const one = snapshotRow("AMD", amdBars, spyBars, undefined)!;
    const rows = Array.from({ length: 1485 }, (_, i) => ({ ...one, symbol: `S${i}` }));
    expect(chunk(rows).map((c) => c.length)).toEqual([500, 500, 485]);
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const inserted = await writeSnapshotRows("scan1", rows, { createMany });
    expect(inserted).toBe(1485);
    expect(createMany).toHaveBeenCalledTimes(3);
    expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    expect((createMany.mock.calls[2][0] as { data: Array<{ scanId: string }> }).data[0].scanId).toBe("scan1");
    // Payload size for one full batch, as posted to /api/harvest/snapshot
    const batchBytes = JSON.stringify({ scanId: "scan1", rows: rows.slice(0, SNAPSHOT_BATCH) }).length;
    expect(batchBytes).toBeLessThan(1_000_000);
  });
});

// ── Outcomes from later snapshots on the SPY calendar ─────────────────────────
// Jan 2027: Mon 18 is MLK day (no session), plus the weekends.
const SESSIONS = ["2027-01-14", "2027-01-15", "2027-01-19", "2027-01-20", "2027-01-21", "2027-01-22", "2027-01-25", "2027-01-26", "2027-01-27"];
const SPY: SpyClose[] = SESSIONS.map((date, i) => ({ date, close: 500 + i }));
const scanAfter = (d: string) => new Date(`${d}T13:30:00Z`); // runs before the next open; same date is fine too

function snap(symbol: string, sessionDate: string, close: number, scanDate?: string): StoredSnapshotRow {
  return {
    scanId: `scan-${sessionDate}`,
    scanStartedAt: scanAfter(scanDate ?? sessionDate),
    symbol, sessionDate, close,
    features: { rsi14: 50, stp_ma_state: 1 },
    regimeFeatures: { spy_above_sma20: true },
  };
}

describe("universe dataset outcomes", () => {
  const rows = SESSIONS.map((d, i) => snap("AMD", d, 100 + i));

  it("counts trading sessions across a weekend and a holiday", () => {
    const fri = buildUniverseRows(rows, SPY).find((r) => r.scanId === "scan-2027-01-15")!;
    // 1st session after Fri 15 is Tue 19 (weekend + MLK); 3rd is Thu 21; 7th is Wed 27
    expect(fri.ret["1d"]).toBeCloseTo(102 / 101 - 1, 12);
    expect(fri.ret["3d"]).toBeCloseTo(104 / 101 - 1, 12);
    expect(fri.ret["7d"]).toBeCloseTo(108 / 101 - 1, 12);
    expect(fri.excess["1d"]).toBeCloseTo(102 / 101 - 1 - (502 / 501 - 1), 12);
  });

  it("leaves an outcome null when the run for that session is missing, never interpolating", () => {
    const missed = rows.filter((r) => r.sessionDate !== "2027-01-21");
    const fri = buildUniverseRows(missed, SPY).find((r) => r.scanId === "scan-2027-01-15")!;
    expect(fri.ret["3d"]).toBeNull();
    expect(fri.excess["3d"]).toBeNull();
    expect(fri.ret["1d"]).not.toBeNull();
  });

  it("nulls outcomes past the end of the calendar and excludes the SPY row itself", () => {
    const out = buildUniverseRows([...rows, snap(BENCHMARK_SYMBOL, "2027-01-15", 501)], SPY);
    expect(out.some((r) => r.symbol === BENCHMARK_SYMBOL)).toBe(false);
    const last = out.find((r) => r.scanId === "scan-2027-01-27")!;
    expect([last.ret["1d"], last.ret["3d"], last.ret["7d"]]).toEqual([null, null, null]);
  });

  it("keeps the earliest scan when two scans saw the same session", () => {
    const dup = { ...snap("AMD", "2027-01-15", 999, "2027-01-16"), scanId: "later" };
    const out = buildUniverseRows([...rows, dup], SPY).filter((r) => r.symbol === "AMD" && r.scanId.endsWith("01-15") || r.scanId === "later");
    expect(out.map((r) => r.scanId)).toEqual(["scan-2027-01-15"]);
  });

  it("refuses to run on features dated after their scan", () => {
    const bad = snap("AMD", "2027-01-20", 103, "2027-01-19");
    expect(() => buildUniverseRows([...rows, bad], SPY)).toThrow(LookAheadError);
  });

  it("puts snapshot keys and regime in attrs, and the pre-registered universe keys are testable", () => {
    const [r] = buildUniverseRows(rows, SPY);
    expect(r.attrs).toMatchObject({ rsi14: 50, stp_ma_state: 1, "regime.spy_above_sma20": true });
    const md = readFileSync(join(__dirname, "../../docs/PHASE3-PREREG.md"), "utf8");
    const uni = [...md.matchAll(/^\| universe: [^|]+\| (\d+) \| ([^|]+) \|$/gm)];
    const keys = uni.flatMap((m) => m[2].split(",").map((k) => k.trim()));
    expect(uni.reduce((s, m) => s + Number(m[1]), 0)).toBe(43);
    expect(md).toContain("**43 comparisons.**");
    const row: EvalRow = { scanId: "s", scanStart: new Date(), symbol: "X", ret: {}, excess: {}, attrs: Object.fromEntries(keys.map((k) => [k, 1])) };
    expect(candidateKeys([row]).sort()).toEqual([...keys].sort());
  });
});

describe("health report: universe snapshot section", () => {
  const base = (over: Partial<ScanInput>): ScanInput => ({
    scanId: "s1", startedAt: new Date("2027-01-20T13:30:00Z"), universeSize: 1000,
    regimeFeatures: { regime_version: 1 }, sectorRotation: { version: 1 }, stpRows: 1000, tickers: [{ rsi14: 50 }], ...over,
  });
  const feats = snapshotRow("AMD", amdBars, spyBars, stpFor(null))!.features;

  it("reports the row count and coverage line", () => {
    const r = analyzeScan(base({ snapshot: Array.from({ length: 950 }, () => feats) }));
    expect(r.snapshot!.rows).toBe(950);
    const text = renderText([r], flagsFor([r]));
    expect(text).toMatch(/\[universe snapshot\] 950 rows; coverage bar 100%, stp 100%, sector 0%/);
  });

  it("flags a missing or short snapshot", () => {
    expect(flagsFor([analyzeScan(base({ snapshot: [] }))]).map((f) => f.message)).toContain(
      "universe snapshot missing (no UniverseSnapshot rows for the latest scan)",
    );
    expect(flagsFor([analyzeScan(base({ snapshot: Array.from({ length: 500 }, () => feats) }))]).map((f) => f.message)).toContain(
      "universe snapshot has 500 rows for a universe of 1000 (under 90%)",
    );
  });
});

// ── P3-0d: sector features from the weekly profile ────────────────────────────
import { buildUniverse } from "@/lib/harvester/universe/build";
import { prepareHarvest } from "@/lib/harvester/universe/harvest-prep";
import type { SectorRotation } from "@/lib/harvester/universe/sector-rotation";

describe("P3-0d sector features", () => {
  const rotation: SectorRotation = {
    version: 1,
    bar_date: "2026-11-20",
    sectors: [{ sector: "Technology", etf: "XLK", stats: {} as never, rank_20d: 2, rank_20d_4w_ago: 5, rank_change_4w: 3, rank_wtd: 1 }],
    etfs: {
      XLK: { return_20d: 0.01, return_60d: null, rs_vs_spy_20d: null, rs_vs_spy_60d: null, rs_vs_spy_20d_4w_ago: null, wtd: null, mtd: null, day: null },
      SMH: { return_20d: 0.03, return_60d: null, rs_vs_spy_20d: null, rs_vs_spy_60d: null, rs_vs_spy_20d_4w_ago: null, wtd: null, mtd: null, day: null },
    },
  };
  const cache: Record<string, unknown> = { AMD: raw("chart-AMD-3mo.json"), SPY: raw("chart-SPY-3mo.json") };
  const peek = (s: string) => (cache[s] ? Promise.resolve({ ok: true as const, json: cache[s] }) : undefined);

  it("adds the 1f keys from the member's profile and this run's rotation, with the universe industry count", async () => {
    const profiles = {
      AMD: { sector: "Technology", industry: "Semiconductors" },
      NVDA: { sector: "Technology", industry: "Semiconductors" },
      KO: { sector: "Consumer Defensive", industry: "Beverages—Non-Alcoholic" },
    };
    const { rows } = await computeSnapshotRows(["AMD"], {}, peek, { profiles, rotation });
    const amd = rows.find((r) => r.symbol === "AMD")!;
    const r20 = amd.features.return_20d as number;
    expect(amd.features).toMatchObject({
      sector_etf: "XLK",
      industry_etf: "SMH",
      sector_rank_20d: 2,
      sector_rank_change_4w: 3,
      industry_ticker_count: 2,
    });
    expect(amd.features.rs_vs_sector_20d).toBeCloseTo(r20 - 0.01, 12);
    expect(amd.features.rs_vs_industry_20d).toBeCloseTo(r20 - 0.03, 12);
    // SPY, the benchmark, carries no sector keys
    expect(rows.find((r) => r.symbol === "SPY")!.features).not.toHaveProperty("sector_etf");
  });

  it("leaves sector keys null for a member with no stored profile", async () => {
    const { rows } = await computeSnapshotRows(["AMD"], {}, peek, { profiles: {}, rotation });
    expect(rows.find((r) => r.symbol === "AMD")!.features).toMatchObject({ sector_etf: null, industry_etf: null, rs_vs_sector_20d: null, industry_ticker_count: null });
  });

  it("the weekly build fetches profiles for the final members only, and a failure leaves them null", async () => {
    const quote = { quoteType: "EQUITY", price: 50, marketCap: 5e9, avgVolume3m: 5e6 };
    const metric = { dollarVolume20d: 5e8, atrPct: 0.05, hv20: 0.6 } as never;
    const base = {
      fetchDirectory: async () => ["AAA", "BBB", "PENNY"],
      fetchQuotes: async () => new Map([["AAA", quote], ["BBB", quote], ["PENNY", { ...quote, price: 1 }]]),
      fetchMetrics: async (s: string[]) => new Map(s.map((x) => [x, metric])),
      hasListedOptions: async () => true,
    };
    const fetchProfiles = vi.fn(async (s: string[]) => new Map(s.map((x) => [x, { sector: "Technology", industry: `Ind-${x}` }])));
    const built = await buildUniverse({ ...base, fetchProfiles });
    expect(fetchProfiles).toHaveBeenCalledWith(["AAA", "BBB"]);
    expect(built.members.map((m) => [m.symbol, m.sector, m.industry])).toEqual([["AAA", "Technology", "Ind-AAA"], ["BBB", "Technology", "Ind-BBB"]]);
    const failed = await buildUniverse({ ...base, fetchProfiles: async () => { throw new Error("yahoo 503"); } });
    expect(failed.members.every((m) => m.sector === null && m.industry === null)).toBe(true);
  });

  it("harvest prep passes the stored profiles through to the harvester", async () => {
    const prep = await prepareHarvest({
      getState: async () => ({
        universe: { id: "u1", refreshedAt: new Date().toISOString(), symbols: ["AAA"], profiles: { AAA: { sector: "Technology", industry: "Semiconductors" } } },
        watch: [],
      }),
      build: async () => { throw new Error("not called"); },
      postBuild: async () => "x",
    });
    expect(prep.profiles).toEqual({ AAA: { sector: "Technology", industry: "Semiconductors" } });
  });
});
