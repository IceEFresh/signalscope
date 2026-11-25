import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etParts, parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { barStoreLine, isReadjusted, mergeBars, swingHistory, toChartJson, updateBarStore, STORE_SESSIONS, type BarStoreIO } from "@/lib/harvester/universe/bar-store";
import { liveStpKeys } from "@/lib/harvester/universe/stp-live";
import { seedBarStore } from "../../scripts/seed-bar-store";

/** Weekday bars at 14:30 UTC from closes (open = previous close, ±1 range). */
function series(closes: number[], start = Date.UTC(2025, 0, 6, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return closes.map((c, i) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open: i ? closes[i - 1] : c, high: c + 1, low: c - 1, close: c, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}
const date = (b: DailyBar) => etParts(new Date(b.time! * 1000)).date;
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
const NOW = new Date("2030-01-01T00:00:00Z");

describe("merge", () => {
  const stored = series([10, 11, 12, 13, 14]);
  it("dedupes by date, the chart's values win, oldest first", () => {
    const chart = series([12.5, 13.5, 14.5, 15.5], stored[2].time!); // overlaps dates 3–5, adds one
    const m = mergeBars(stored, chart, "2099-01-01");
    expect(m.map((b) => b.close)).toEqual([10, 11, 12.5, 13.5, 14.5, 15.5]);
  });
  it("an unfinished day (the run's session date or later) is never stored", () => {
    const today = date(stored[4]);
    expect(mergeBars(stored, [], today).map(date)).not.toContain(today);
    expect(mergeBars(stored, [], today)).toHaveLength(4);
  });
  it(`keeps the newest ${STORE_SESSIONS} sessions`, () => {
    const long = series(Array.from({ length: 700 }, (_, i) => 100 + i));
    const m = mergeBars(long, [], "2099-01-01");
    expect(m).toHaveLength(STORE_SESSIONS);
    expect(m[0].close).toBe(200);
  });
  it("round-trips through the chart-JSON file format", () => {
    expect(parseChartBars(toChartJson(stored), NOW)).toEqual(stored);
  });
});

describe("updateBarStore", () => {
  const io = (files: Record<string, unknown>, fetched: unknown | null = null): BarStoreIO & { fetch2y: ReturnType<typeof vi.fn> } => ({
    read: (s) => files[s] ?? null,
    write: (s, j) => {
      files[s] = j;
    },
    fetch2y: vi.fn(async () => fetched),
  });
  const base = series(Array.from({ length: 30 }, (_, i) => 100 + i));

  it("appends the chart to an existing file without any request", async () => {
    const files: Record<string, unknown> = { AAA: toChartJson(base.slice(0, 20)) };
    const x = io(files);
    const r = await updateBarStore(["AAA"], async () => base.slice(15), x, NOW);
    expect(x.fetch2y).not.toHaveBeenCalled();
    expect(r.histories.get("AAA")).toHaveLength(30);
    expect(parseChartBars(files.AAA, NOW)).toHaveLength(30);
  });

  it("a >1% close mismatch on a shared date means a re-adjusted history: one 2-year fetch rewrites the file", async () => {
    const adjusted = base.map((b) => ({ ...b, close: b.close / 2, high: b.high / 2, low: b.low / 2, open: b.open! / 2 }));
    expect(isReadjusted(base.slice(0, 20), adjusted.slice(15))).toBe(true);
    expect(isReadjusted(base.slice(0, 20), base.slice(15).map((b) => ({ ...b, close: b.close * 1.009 })))).toBe(false);
    const files: Record<string, unknown> = { AAA: toChartJson(base.slice(0, 20)) };
    const x = io(files, toChartJson(adjusted));
    const r = await updateBarStore(["AAA"], async () => adjusted.slice(15), x, NOW);
    expect(x.fetch2y).toHaveBeenCalledTimes(1);
    expect(r.stats.readjusted).toBe(1);
    expect(parseChartBars(files.AAA, NOW)[0].close).toBe(50); // the old unadjusted 100 is gone
  });

  it("a new member with no file gets one 2-year fetch", async () => {
    const files: Record<string, unknown> = {};
    const x = io(files, toChartJson(base));
    const r = await updateBarStore(["NEW"], async () => base.slice(-5), x, NOW);
    expect(x.fetch2y).toHaveBeenCalledTimes(1);
    expect(r.stats.seededNew).toBe(1);
    expect(r.histories.get("NEW")).toHaveLength(30);
  });

  it("a re-adjusted symbol whose 2-year fetch fails keeps its file byte-identical; the run uses the chart alone", async () => {
    const adjusted = base.map((b) => ({ ...b, close: b.close / 2, high: b.high / 2, low: b.low / 2, open: b.open! / 2 }));
    const original = toChartJson(base.slice(0, 20));
    const before = JSON.stringify(original);
    const files: Record<string, unknown> = { AAA: original };
    const write = vi.fn((s: string, j: unknown) => {
      files[s] = j;
    });
    const r = await updateBarStore(["AAA"], async () => adjusted.slice(15), { read: (s) => files[s], write, fetch2y: async () => null }, NOW);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(files.AAA)).toBe(before);
    expect(r.stats).toMatchObject({ readjusted: 0, readjustDeferred: 1, fetchErrors: 1 });
    expect(r.histories.get("AAA")!.map((b) => b.close)).toEqual(adjusted.slice(15).map((b) => b.close));
  });

  it("caps 2-year fetches at 100 per run: 150 new symbols → 100 fetches, 50 deferred, no file for the deferred", async () => {
    const files: Record<string, unknown> = {};
    const fetch2y = vi.fn(async () => toChartJson(base));
    const syms = Array.from({ length: 150 }, (_, i) => `N${i}`);
    const r = await updateBarStore(syms, async () => base.slice(-3), { read: (s) => files[s] ?? null, write: (s, j) => { files[s] = j; }, fetch2y }, NOW);
    expect(fetch2y).toHaveBeenCalledTimes(100);
    expect(r.stats).toMatchObject({ seededNew: 100, deferred: 50 });
    expect(Object.keys(files)).toHaveLength(100);
    expect(r.histories.get("N149")).toHaveLength(3); // deferred: chart only this run
    expect(barStoreLine(r.stats).line).toContain("50 deferred (fetch cap 100)");
  });

  it("a write error is counted and the next symbol still updates", async () => {
    const files: Record<string, unknown> = { AAA: toChartJson(base), BBB: toChartJson(base) };
    const x: BarStoreIO = {
      read: (s) => files[s],
      write: (s, j) => {
        if (s === "AAA") throw new Error("disk full");
        files[s] = j;
      },
      fetch2y: async () => null,
    };
    const r = await updateBarStore(["AAA", "BBB"], async () => base.slice(-3), x, NOW);
    expect(r.stats.writeErrors).toBe(1);
    expect(r.histories.get("BBB")).toHaveLength(30);
    expect(barStoreLine(r.stats).line).toBe(
      "[bar-store] 0/2 members with ≥250 sessions, 0 re-adjusted, 0 seeded new, 0 deferred (fetch cap 100), 0 re-adjust deferred, 1 write errors, 0 fetch errors",
    );
    expect(barStoreLine(r.stats).warn).toBe(true);
  });
});

describe("live swing keys from the store", () => {
  // ~330 bars of clean swings: 20 flat, then cycles of +25 over 10 bars and −15 over 6
  const closes: number[] = Array(20).fill(100);
  let p = 100;
  for (let c = 0; c < 19; c++) {
    closes.push(...ramp(p, p + 25, 10));
    p += 25;
    closes.push(...ramp(p, p - 15, 6));
    p -= 15;
  }
  const all = series(closes);
  const chart = all.slice(-63);
  const history = all.slice(0, -10); // the store lags the chart by a few sessions

  it("swing keys turn non-null once the store has ≥250 sessions with ≥4 legs; the 63-bar chart alone gives null", () => {
    expect(history.length).toBeGreaterThanOrEqual(250);
    const without = liveStpKeys(chart, undefined, { assetClass: "stock" });
    const withStore = liveStpKeys(chart, undefined, { assetClass: "stock", history });
    expect(without.swing_k3_rally_median_atr).toBeNull();
    expect(withStore.swing_k3_rally_median_atr).not.toBeNull();
    expect(withStore.swing_k2_rally_used).not.toBeNull();
    // other keys still come from the chart alone
    expect(withStore.stp_htf_opens_rolling).toBe(without.stp_htf_opens_rolling);
  });

  it("look-ahead: a stored bar dated after D (the chart's last bar) is ignored", () => {
    const future = series([1, 1e6], all.at(-1)!.time! + 3 * 86_400);
    const h = swingHistory([...history, ...future], chart);
    expect(date(h.at(-1)!)).toBe(date(chart.at(-1)!));
    expect(liveStpKeys(chart, undefined, { assetClass: "stock", history: [...history, ...future] })).toEqual(
      liveStpKeys(chart, undefined, { assetClass: "stock", history }),
    );
  });
});

describe("seed script", () => {
  it("copies the backfill cache into the store and skips symbols already present", () => {
    const root = mkdtempSync(join(tmpdir(), "bar-store-"));
    const src = join(root, "backfill-bars");
    const dest = join(root, "store");
    mkdirSync(src);
    mkdirSync(dest);
    writeFileSync(join(src, "AAA.json"), "{\"a\":1}");
    writeFileSync(join(src, "BBB.json"), "{\"b\":1}");
    writeFileSync(join(dest, "BBB.json"), "{\"kept\":true}");
    expect(seedBarStore(src, dest)).toEqual({ copied: 1, skipped: 1 });
    expect(readdirSync(dest).sort()).toEqual(["AAA.json", "BBB.json"]);
    expect(readFileSync(join(dest, "BBB.json"), "utf8")).toBe("{\"kept\":true}");
    expect(seedBarStore(src, dest)).toEqual({ copied: 0, skipped: 2 });
  });
});
