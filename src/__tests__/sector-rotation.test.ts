import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import {
  computeEtfStats,
  computeSectorRotation,
  INDUSTRY_ETFS,
  rankDesc,
  ROTATION_ETFS,
  SECTOR_ETFS,
  tickerSectorFeatures,
} from "@/lib/harvester/universe/sector-rotation";
import { computeSectorExtras } from "@/lib/harvester/universe/harvest-prep";

const AFTER_CLOSE = new Date(1795210000 * 1000);
const raw = (s: string) => JSON.parse(readFileSync(join(__dirname, `fixtures/universe/chart-${s}-3mo.json`), "utf8"));
const bars = (s: string) => parseChartBars(raw(s), AFTER_CLOSE);
const spy = bars("SPY");

// Weekday 9:30 ET bars ending Fri 2026-11-20, same timestamps for every series.
function weekdayTimes(count: number): number[] {
  const out: number[] = [];
  let t = Date.UTC(2026, 10, 20, 14, 30) / 1000;
  while (out.length < count) {
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(t);
    t -= 86_400;
  }
  return out;
}
function series(closes: number[]): DailyBar[] {
  const times = weekdayTimes(closes.length);
  return closes.map((c, i) => ({ open: c, high: c + 1, low: c - 1, close: c, volume: 1000, time: times[i] }));
}

describe("sector and industry ETF maps", () => {
  it("covers the 11 SPDR sectors with Yahoo's sector names", () => {
    expect(Object.keys(SECTOR_ETFS)).toHaveLength(11);
    expect(new Set(Object.values(SECTOR_ETFS)).size).toBe(11);
  });
  it("lists every ETF once for fetching (11 sectors plus about 25+ industry ETFs)", () => {
    expect(ROTATION_ETFS.length).toBe(new Set(ROTATION_ETFS).size);
    expect(new Set(Object.values(INDUSTRY_ETFS)).size).toBeGreaterThanOrEqual(25);
  });
});

describe("computeEtfStats on real XLK + SPY fixtures", () => {
  it("fills every stat for the 2026-11-20 session", () => {
    const s = computeEtfStats(bars("XLK"), spy);
    for (const [k, v] of Object.entries(s)) expect(v, k).not.toBeNull();
  });
});

describe("computeSectorRotation", () => {
  const flat = Array(70).fill(100);
  const spyBars = series(flat);
  // XLK rises late (strong now, flat 4 weeks ago); XLE rose early then flattened (strong 4 weeks ago).
  const xlk = series(flat.map((c, i) => (i >= 50 ? 100 + (i - 49) : c)));
  const xle = series(flat.map((c, i) => (i >= 30 && i < 50 ? 100 + (i - 29) * 2 : i >= 50 ? 140 : c)));
  const rot = computeSectorRotation({ XLK: xlk, XLE: xle, SMH: xlk }, spyBars, "2026-11-20");

  it("ranks sectors by 20-day RS vs SPY and reports the 4-week rank change", () => {
    const k = rot.sectors.find((s) => s.etf === "XLK")!;
    const e = rot.sectors.find((s) => s.etf === "XLE")!;
    expect(k.rank_20d).toBe(1);
    expect(e.rank_20d).toBe(2); // flat for 20 bars: RS 0, ties with missing sectors excluded
    expect(e.rank_20d_4w_ago).toBe(1);
    expect(k.rank_change_4w).toBe(1); // 2 → 1
    expect(e.rank_change_4w).toBe(-1); // 1 → 2
  });

  it("leaves sectors without bars unranked (null), never 0", () => {
    const xlu = rot.sectors.find((s) => s.etf === "XLU")!;
    expect(xlu.rank_20d).toBeNull();
    expect(xlu.stats.return_20d).toBeNull();
  });

  it("keeps stats for industry ETFs too", () => {
    expect(rot.etfs.SMH.return_20d).toBeCloseTo(120 / 100 - 1, 12);
    expect(rot.bar_date).toBe("2026-11-20");
  });
});

describe("rankDesc", () => {
  it("ranks highest first and skips nulls", () => {
    expect(rankDesc([0.1, null, 0.3, -0.2])).toEqual([2, null, 1, 3]);
  });
});

describe("tickerSectorFeatures", () => {
  const etf = (r20: number) => ({ return_20d: r20, return_60d: null, rs_vs_spy_20d: r20, rs_vs_spy_60d: null, rs_vs_spy_20d_4w_ago: null, wtd: null, mtd: null, day: null });
  const rot = {
    version: 1,
    bar_date: "2026-11-20",
    sectors: [{ sector: "Technology", etf: "XLK", stats: etf(0.02), rank_20d: 2, rank_20d_4w_ago: 5, rank_change_4w: 3, rank_wtd: 1 }],
    etfs: { XLK: etf(0.02), SMH: etf(0.04) },
  };

  it("computes return vs sector and industry ETFs and carries the sector rank", () => {
    const f = tickerSectorFeatures("Technology", "Semiconductors", 0.1, rot, 3);
    expect(f.rs_vs_sector_20d).toBeCloseTo(0.08, 12);
    expect(f.rs_vs_industry_20d).toBeCloseTo(0.06, 12);
    expect(f).toMatchObject({ sector_etf: "XLK", industry_etf: "SMH", sector_rank_20d: 2, sector_rank_change_4w: 3, industry_ticker_count: 3 });
  });

  it("is null for unmapped industries, unknown sectors, missing returns or no rotation", () => {
    const f = tickerSectorFeatures("Technology", "Some New Industry", 0.1, rot, 1);
    expect(f.industry_etf).toBeNull();
    expect(f.rs_vs_industry_20d).toBeNull();
    expect(tickerSectorFeatures(undefined, undefined, 0.1, rot, null).sector_etf).toBeNull();
    expect(tickerSectorFeatures("Technology", "Semiconductors", null, rot, 1).rs_vs_sector_20d).toBeNull();
    expect(tickerSectorFeatures("Technology", "Semiconductors", 0.1, null, 1).sector_rank_20d).toBeNull();
    expect(tickerSectorFeatures("Technology", null, 0.1, rot, null).industry_ticker_count).toBeNull();
  });
});

describe("computeSectorExtras", () => {
  it("fetches SPY and every rotation ETF once, and leaves failed ETFs out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getChart = vi.fn(async (s: string) =>
      s === "XLE" ? { ok: false as const, status: 429, rateLimited: true } : { ok: true as const, json: raw(s === "SPY" ? "SPY" : "XLK") },
    );
    const rot = (await computeSectorExtras(getChart as never, { delayMs: 0 }))!;
    expect(getChart).toHaveBeenCalledTimes(ROTATION_ETFS.length + 1);
    expect(rot.etfs.XLE).toBeUndefined();
    expect(rot.sectors.find((s) => s.etf === "XLE")!.rank_20d).toBeNull();
    expect(rot.sectors.find((s) => s.etf === "XLK")!.rank_20d).not.toBeNull();
    expect(rot.bar_date).toBe("2026-11-20");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("industry string normalization (review of #14)", () => {
  it("maps em dash, en dash and spaced-hyphen forms to the same ETF", async () => {
    const { industryEtfFor } = await import("@/lib/harvester/universe/sector-rotation");
    expect(industryEtfFor("Software—Application")).toBe("IGV");
    expect(industryEtfFor("Software - Application")).toBe("IGV");
    expect(industryEtfFor("Software – Application")).toBe("IGV");
    expect(industryEtfFor("Banks - Regional")).toBe("KRE");
    expect(industryEtfFor("Drug Manufacturers - Specialty & Generic")).toBe("XPH");
    expect(industryEtfFor("Semiconductors")).toBe("SMH");
    expect(industryEtfFor("Some New Industry")).toBeNull();
    expect(industryEtfFor(null)).toBeNull();
  });

  it("uses the normalized lookup for ticker features", () => {
    const rot = { version: 1, bar_date: null, sectors: [], etfs: { IGV: { return_20d: 0.01, return_60d: null, rs_vs_spy_20d: null, rs_vs_spy_60d: null, rs_vs_spy_20d_4w_ago: null, wtd: null, mtd: null, day: null } } };
    expect(tickerSectorFeatures("Technology", "Software - Infrastructure", 0.05, rot, 1)).toMatchObject({ industry_etf: "IGV" });
  });

  it("lists unmapped industries, most frequent first", async () => {
    const { unmappedIndustries } = await import("@/lib/harvester/universe/sector-rotation");
    expect(unmappedIndustries(["Shell Companies", "Software - Application", "Shell Companies", "Tobacco", null])).toEqual([
      ["Shell Companies", 2],
      ["Tobacco", 1],
    ]);
  });
});
