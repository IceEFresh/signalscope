import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { etParts, parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { computeStp } from "@/lib/harvester/universe/stp";
import {
  BACKFILL_SCAN_PREFIX,
  BACKFILL_SCAN_ERROR,
  BackfillLookAheadError,
  backfillRowsForSymbol,
  backfillScanId,
  backfillScanStartedAt,
  backfillSessions,
  barDateOf,
  pendingRows,
  sliceForSession,
  windowStart,
} from "@/lib/harvester/universe/backfill";
import { buildUniverseRows, type StoredSnapshotRow } from "@/lib/eval/universe-dataset";
import { markdownReport, experimentSummaryRow, SURVIVORSHIP_NOTE } from "@/lib/eval/report";
import { candidateKeys } from "@/lib/eval/features";

const raw = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures/universe", f), "utf8")) as unknown;
const NOW = new Date("2030-01-01T00:00:00Z");
const amd = parseChartBars(raw("chart-AMD-3mo.json"), NOW);
const spy = parseChartBars(raw("chart-SPY-3mo.json"), NOW);
const dates = amd.map((b) => barDateOf(b)!);
const D = dates[dates.length - 6]; // a session with 5 later bars in the fixture

describe("P3-0g slicing: no bar after D is used", () => {
  it("the slice for D ends at D and leaves out every later bar", () => {
    const s = sliceForSession(amd, D);
    expect(barDateOf(s.at(-1)!)).toBe(D);
    expect(s.every((b) => barDateOf(b)! <= D)).toBe(true);
  });

  it("a planted future bar changes nothing for D", () => {
    const planted: DailyBar[] = amd.map((b, i) =>
      dates[i] > D ? { ...b, open: 1e6, high: 2e6, low: 1, close: 1e6, volume: 1e12 } : b,
    );
    const clean = backfillRowsForSymbol("AMD", amd, spy, [D]);
    const dirty = backfillRowsForSymbol("AMD", planted, spy, [D]);
    expect(dirty).toEqual(clean);
    expect(clean[0].sessionDate).toBe(D);
    // and the planted bar does show up for its own session
    const after = dates[dates.length - 1];
    expect(backfillRowsForSymbol("AMD", planted, spy, [after])[0].close).toBe(1e6);
  });

  it("refuses a session with no bar dated D (the newest bar used must be D)", () => {
    expect(() => sliceForSession(amd, "2026-11-22")).toThrow(BackfillLookAheadError); // a Sunday
  });

  it("windows to the live 3-month range: older history doesn't change the features", () => {
    expect(windowStart("2026-11-13")).toBe("2026-08-13");
    const first = amd[0].time!;
    const older: DailyBar[] = Array.from({ length: 40 }, (_, i) => ({
      open: 1, high: 500, low: 0.5, close: 1 + i, volume: 1, time: first - (60 + 40 - i) * 86_400 * 2,
    }));
    expect(barDateOf(older.at(-1)!)! < windowStart(D)).toBe(true);
    expect(backfillRowsForSymbol("AMD", [...older, ...amd], spy, [D])).toEqual(backfillRowsForSymbol("AMD", amd, spy, [D]));
  });
});

describe("P3-0g STP on a sliced fixture matches the live computation for the same day", () => {
  it("states equal computeStp on the bars a live run would have had", () => {
    // A live run the morning after D fetches range=3mo: the fixture's bars up to D.
    const live = computeStp(amd.filter((b) => barDateOf(b)! <= D));
    const [row] = backfillRowsForSymbol("AMD", amd, spy, [D]);
    expect(live.barDate).toBe(D);
    expect(live.maState).not.toBeNull();
    expect(row.features).toMatchObject({
      stp_ma_state: live.maState,
      stp_well_bid: live.wellBid,
      stp_size_factor: live.sizeFactor,
      stp_htf_opens: live.htfOpens,
    });
  });
});

describe("P3-0g rows, scans and resume", () => {
  const sessions = backfillSessions(spy, dates[dates.length - 11], dates[dates.length - 1]);
  const rows = backfillRowsForSymbol("AMD", amd, spy, sessions);

  it("one row per session, marked backfill, no sector or regime keys", () => {
    expect(sessions).toHaveLength(10);
    expect(rows.map((r) => r.sessionDate)).toEqual(sessions);
    for (const r of rows) {
      expect(r.features).toMatchObject({ backfill: true, backfill_version: 1, bar_date: r.sessionDate });
      expect(r.features).not.toHaveProperty("sector_etf");
    }
  });

  it("each session gets its own synthetic scan, dated D in ET and marked in error", () => {
    expect(backfillScanId("2026-11-13")).toBe("backfill-v1-2026-11-13");
    expect(etParts(backfillScanStartedAt("2026-11-13")).date).toBe("2026-11-13");
    expect(BACKFILL_SCAN_ERROR.startsWith(BACKFILL_SCAN_PREFIX)).toBe(true);
  });

  it("resumes after a partial run: only rows not yet stored are written", () => {
    const stored = new Set(rows.slice(0, 4).map((r) => `${backfillScanId(r.sessionDate)}|AMD`));
    const todo = pendingRows(rows, stored);
    expect(todo.map((r) => r.sessionDate)).toEqual(sessions.slice(4));
    expect(pendingRows(rows, new Set(rows.map((r) => `${backfillScanId(r.sessionDate)}|AMD`)))).toEqual([]);
  });
});

describe("P3-0g harness: backfill is its own dataset", () => {
  const sessions = backfillSessions(spy, dates[0], dates[dates.length - 1]);
  const toStored = (r: ReturnType<typeof backfillRowsForSymbol>[number]): StoredSnapshotRow => ({
    scanId: backfillScanId(r.sessionDate), scanStartedAt: backfillScanStartedAt(r.sessionDate), symbol: r.symbol,
    sessionDate: r.sessionDate, close: r.close, features: r.features, regimeFeatures: null,
  });
  const backfill = [...backfillRowsForSymbol("AMD", amd, spy, sessions), ...backfillRowsForSymbol("SPY", spy, spy, sessions)].map(toStored);
  const live: StoredSnapshotRow = { ...backfill[0], scanId: "live1", symbol: "NVDA", features: { snapshot_version: 1, rsi14: 50 } };
  const spyCloses = backfill.filter((r) => r.symbol === "SPY").map((r) => ({ date: r.sessionDate, close: r.close }));

  it("never pools: universe drops backfill rows, backfill keeps only them", () => {
    const uni = buildUniverseRows([...backfill, live], spyCloses);
    expect(uni.map((r) => r.symbol)).toEqual(["NVDA"]);
    const bf = buildUniverseRows([...backfill, live], spyCloses, { backfill: true });
    expect(new Set(bf.map((r) => r.symbol))).toEqual(new Set(["AMD"]));
    expect(bf.some((r) => typeof r.excess["7d"] === "number")).toBe(true);
  });

  it("candidate keys are the 22 bar + 4 STP keys (prereg count 26)", () => {
    const keys = candidateKeys(buildUniverseRows(backfill, spyCloses, { backfill: true }));
    expect(keys).toHaveLength(26);
    expect(keys).not.toContain("backfill");
    expect(keys).not.toContain("backfill_version");
  });

  it("the report header and log row state the survivorship bias", () => {
    const md = markdownReport([], { date: "2026-11-24", commit: "abc", rows: 0, scans: 0, dataset: "backfill" });
    expect(md.split("\n")[2]).toBe(SURVIVORSHIP_NOTE);
    expect(SURVIVORSHIP_NOTE).toMatch(/delisted/);
    expect(markdownReport([], { date: "2026-11-24", commit: "abc", rows: 0, scans: 0, dataset: "universe" })).not.toContain("Survivorship");
    expect(experimentSummaryRow([], { number: 1, date: "d", commit: "c", rows: 0, scans: 0, reportPath: "p", dataset: "backfill" })).toMatch(/Survivorship-biased/);
  });
});

describe("etParts memo (P3-0g speed-up)", () => {
  it("returns the same answer on a repeat call, as a copy the caller can't corrupt", () => {
    const d = new Date("2026-11-13T21:00:00Z");
    const a = etParts(d);
    a.date = "mutated";
    expect(etParts(d)).toEqual({ date: "2026-11-13", minutes: 16 * 60 });
  });
});
