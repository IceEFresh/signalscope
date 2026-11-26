import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fetchShortInterest,
  fetchShortVolume,
  parseShortInterest,
  parseShortVolume,
  siCandidateGroups,
  siFeaturesAt,
  siFileUrl,
  siPublicationSession,
  siRowsFor,
  svFeaturesAt,
  svFileUrl,
  svRatiosFor,
  type FinraCache,
  type SiRow,
} from "@/lib/harvester/finra";

const fx = (f: string) => readFileSync(join(__dirname, "fixtures/finra", f), "utf8");

function weekdays(a: string, b: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
// 2024-11-28 (Thanksgiving) is a holiday
const SESSIONS = weekdays("2024-10-01", "2024-12-31").filter((d) => d !== "2024-11-28");

describe("parse", () => {
  it("short interest file: symbol → settlement, current, previous, average daily volume (OTC rows too)", () => {
    const m = parseShortInterest(fx("shrt20241115.csv"));
    expect(m.get("AAPL")).toEqual({ settlement: "2024-11-15", current: 141037864, previous: 133040194, avgDailyVolume: 44920191 });
    expect(m.get("AAALY")?.current).toBe(1);
    expect(m.size).toBe(7);
  });

  it("newer files quote every field: same parse", () => {
    const m = parseShortInterest(fx("shrt20261113-quoted.csv"));
    expect(m.size).toBe(2);
    expect(m.get("A")).toEqual({ settlement: "2026-11-13", current: 5050890, previous: 4892390, avgDailyVolume: 1964501 });
    expect(m.get("AAPL")?.settlement).toBe("2026-11-13");
    expect(parseShortVolume('"Date"|"Symbol"|"ShortVolume"|"ShortExemptVolume"|"TotalVolume"|"Market"\n"20261125"|"A"|"515153.884785"|"3797"|"1061246.031589"|"B,Q,N"').get("A")).toEqual({
      short: 515153.884785,
      total: 1061246.031589,
    });
  });

  it("daily short volume: symbol → short and total; header and the trailing count line skipped", () => {
    const m = parseShortVolume(fx("CNMSshvol20241122.txt"));
    expect(m.get("AAPL")).toEqual({ short: 4854930, total: 12352802 });
    expect(m.size).toBe(5);
    expect(m.has("10183")).toBe(false);
  });
});

describe("publication-date rule", () => {
  it("a report is first used on the 7th session after settlement (holidays skipped)", () => {
    // 2024-11-15 settlement: 18, 19, 20, 21, 22, 25, 26 → FINRA's published date 2024-11-26
    expect(siPublicationSession("2024-11-15", SESSIONS)).toBe("2024-11-26");
    // 2024-11-29 settlement: Dec 2, 3, 4, 5, 6, 9, 10
    expect(siPublicationSession("2024-11-29", SESSIONS)).toBe("2024-12-10");
    expect(siPublicationSession("2024-12-30", SESSIONS)).toBeNull(); // not published within the list
  });

  it("not usable before publication: the previous report until then, null when there's none", () => {
    const reports: SiRow[] = [
      { settlement: "2024-10-31", current: 100, previous: 80, avgDailyVolume: 50 },
      { settlement: "2024-11-15", current: 200, previous: 100, avgDailyVolume: 40 },
    ];
    expect(siFeaturesAt(reports, "2024-11-25", SESSIONS, 1000).si_settlement).toBe("2024-10-31");
    expect(siFeaturesAt(reports, "2024-11-26", SESSIONS, 1000).si_settlement).toBe("2024-11-15");
    expect(siFeaturesAt(reports.slice(1), "2024-11-25", SESSIONS, 1000)).toEqual({
      si_shares: null,
      si_pct_float: null,
      si_days_to_cover: null,
      si_change_pct: null,
      si_high: null,
      si_settlement: null,
    });
  });
});

describe("siFeaturesAt", () => {
  const aapl = siRowsFor([{ rows: parseShortInterest(fx("shrt20241115.csv")) }], "aapl");

  it("shares, % of float, days to cover, change vs the prior report, si_high at > 20%", () => {
    const f = siFeaturesAt(aapl, "2024-11-26", SESSIONS, 14_800_000_000);
    expect(f).toEqual({
      si_shares: 141037864,
      si_pct_float: 0.95,
      si_days_to_cover: 3.14,
      si_change_pct: 6.01,
      si_high: false,
      si_settlement: "2024-11-15",
    });
    expect(siFeaturesAt([{ settlement: "2024-11-15", current: 21, previous: null, avgDailyVolume: 0 }], "2024-11-26", SESSIONS, 100)).toMatchObject({
      si_pct_float: 21,
      si_high: true,
      si_days_to_cover: null,
      si_change_pct: null,
    });
    expect(siFeaturesAt([{ settlement: "2024-11-15", current: 20, previous: 20, avgDailyVolume: 1 }], "2024-11-26", SESSIONS, 100).si_high).toBe(false);
  });

  it("si_pct_float (and si_high) null without a float; the other keys stay", () => {
    for (const float of [null, undefined, 0]) {
      const f = siFeaturesAt(aapl, "2024-11-26", SESSIONS, float);
      expect(f.si_pct_float).toBeNull();
      expect(f.si_high).toBeNull();
      expect(f.si_shares).toBe(141037864);
    }
  });
});

describe("svFeaturesAt", () => {
  it("ratio, the mean of the 20 sessions before, and the z-score", () => {
    const ratios = [...Array.from({ length: 20 }, (_, k) => (k % 2 ? 0.4 : 0.6)), 0.8];
    const f = svFeaturesAt(ratios, 20);
    const sd = Math.sqrt((20 * 0.01) / 19);
    expect(f.sv_ratio).toBe(0.8);
    expect(f.sv_ratio_20d).toBe(0.5);
    expect(f.sv_z).toBeCloseTo((0.8 - 0.5) / sd, 2);
  });

  it("needs 15 of the 20 baseline sessions; missing today keeps the baseline but no ratio or z", () => {
    const few = [...Array(6).fill(null), ...Array(14).fill(0.5), 0.6];
    expect(svFeaturesAt(few, 20)).toEqual({ sv_ratio: 0.6, sv_ratio_20d: null, sv_z: null });
    const enough = [...Array(5).fill(null), ...Array.from({ length: 15 }, (_, k) => 0.4 + 0.01 * k), null];
    const f = svFeaturesAt(enough, 20);
    expect(f.sv_ratio).toBeNull();
    expect(f.sv_ratio_20d).not.toBeNull();
    expect(f.sv_z).toBeNull();
  });

  it("today never enters its own baseline (no look-ahead)", () => {
    const base = Array.from({ length: 20 }, (_, k) => 0.4 + 0.005 * k);
    expect(svFeaturesAt([...base, 0.9], 20).sv_ratio_20d).toBe(svFeaturesAt([...base, 0.1], 20).sv_ratio_20d);
  });

  it("svRatiosFor aligns a symbol's ratios to the sessions (null where the file or symbol is missing)", () => {
    const day = parseShortVolume(fx("CNMSshvol20241122.txt"));
    const r = svRatiosFor(new Map([["2024-11-21", null], ["2024-11-22", day]]), ["2024-11-21", "2024-11-22", "2024-11-25"], "aapl");
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(4854930 / 12352802, 6);
    expect(r[2]).toBeNull();
  });
});

describe("candidates and fetching", () => {
  it("settlement candidates per half-month: weekdays on the 11th–15th and the month's last 5 weekdays, newest first", () => {
    expect(siCandidateGroups("2024-11-01", "2024-11-30")).toEqual([
      ["2024-11-15", "2024-11-14", "2024-11-13", "2024-11-12", "2024-11-11"],
      ["2024-11-29", "2024-11-28", "2024-11-27", "2024-11-26", "2024-11-25"],
    ]);
    // 2024-06-15 is a Saturday
    expect(siCandidateGroups("2024-06-01", "2024-06-20")[0]).toEqual(["2024-06-14", "2024-06-13", "2024-06-12", "2024-06-11"]);
  });

  function memCache(): FinraCache & { m: Map<string, string> } {
    const m = new Map<string, string>();
    return { m, read: (n) => m.get(n) ?? null, write: (n, t) => void m.set(n, t) };
  }

  it("first existing candidate per half wins; files and old misses are cached, recent misses re-probed", async () => {
    const files: Record<string, string> = { [siFileUrl("2024-11-15")]: fx("shrt20241115.csv"), [siFileUrl("2024-11-29")]: fx("shrt20241115.csv") };
    const get = vi.fn(async (url: string) => files[url] ?? null);
    const cache = memCache();
    const stats = { fetched: 0, missing: 0 };
    const out = await fetchShortInterest("2024-11-01", "2024-12-05", get, cache, stats);
    expect(out.map((r) => r.settlement)).toEqual(["2024-11-15", "2024-11-29"]);
    expect(stats).toEqual({ fetched: 2, missing: 0 });
    expect(out[0].rows.get("AAPL")?.current).toBe(141037864);
    // December's mid-month candidates (all after `to`) aren't probed
    expect(get.mock.calls.every((c) => c[0] <= siFileUrl("2024-12-05"))).toBe(true);
    get.mockClear();
    await fetchShortInterest("2024-11-01", "2024-12-05", get, cache);
    expect(get).not.toHaveBeenCalled();
  });

  it("a candidate with no file is remembered only once it's 20+ days old", async () => {
    const get = vi.fn(async () => null);
    const cache = memCache();
    await fetchShortInterest("2024-11-01", "2024-12-10", get, cache);
    // Run on 12-10: the mid-November candidates are 20+ days old → remembered; month-end ones aren't yet
    expect(cache.m.get("shrt20241108.csv")).toBeUndefined();
    expect(cache.m.get("shrt20241111.csv")).toBe("");
    expect(cache.m.has("shrt20241129.csv")).toBe(false);
  });

  it("short volume per session: cached, null where missing, the newest session's miss not remembered", async () => {
    const get = vi.fn(async (url: string) => (url === svFileUrl("2024-11-22") ? fx("CNMSshvol20241122.txt") : null));
    const cache = memCache();
    const m = await fetchShortVolume(["2024-11-21", "2024-11-22", "2024-11-25"], get, cache);
    expect(m.get("2024-11-21")).toBeNull();
    expect(m.get("2024-11-22")?.get("TSLA")).toEqual({ short: 29951601, total: 50982912 });
    expect(cache.m.get("CNMSshvol20241121.txt")).toBe("");
    expect(cache.m.has("CNMSshvol20241125.txt")).toBe(false);
  });
});
