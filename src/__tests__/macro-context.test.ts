import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { commonBarDate, computeMacro, normalizeYield, MACRO_SYMBOLS, type MacroInput } from "@/lib/harvester/universe/macro";
import { computeMacroExtras } from "@/lib/harvester/universe/harvest-prep";
import { parseCryptoBars } from "@/lib/harvester/crypto/universe";
import { buildUniverseRows, type StoredSnapshotRow } from "@/lib/eval/universe-dataset";
import { candidateKeys } from "@/lib/eval/features";
import { scanAttrs } from "@/lib/eval/scan-attrs";
import { analyzeScan, flagsFor, renderText } from "@/lib/health/harvest-health";

const NOW = new Date("2030-01-01T00:00:00Z");
const file: Record<string, string> = {
  "DX-Y.NYB": "macro/chart-DX-Y.NYB-3mo.json", UUP: "macro/chart-UUP-3mo.json", HYG: "macro/chart-HYG-3mo.json", LQD: "macro/chart-LQD-3mo.json",
  "^TNX": "macro/chart-TNX-3mo.json", "^IRX": "macro/chart-IRX-3mo.json", GLD: "macro/chart-GLD-3mo.json", DBB: "macro/chart-DBB-3mo.json",
  "BTC-USD": "crypto/chart-BTC-USD-3mo.json",
};
const json = (sym: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", file[sym]), "utf8")) as unknown;
const bars = (sym: string) => parseChartBars(json(sym), NOW);

const realInput = (): MacroInput => ({
  dxy: bars("DX-Y.NYB"), uup: null, hyg: bars("HYG"), lqd: bars("LQD"), tnx: bars("^TNX"), irx: bars("^IRX"),
  gld: bars("GLD"), dbb: bars("DBB"), btc: parseCryptoBars(json("BTC-USD"), new Date("2026-11-24T21:20:00Z")),
});

describe("macro on real Yahoo fixtures (2026-11-24)", () => {
  it("every symbol returns daily bars, and the series share a session calendar", () => {
    for (const s of ["DX-Y.NYB", "UUP", "HYG", "LQD", "^TNX", "^IRX", "GLD", "DBB"]) expect(bars(s).length).toBeGreaterThan(55);
    const m = computeMacro(realInput());
    expect(m.macro_bar_date).toBe("2026-11-24");
    expect(m.dxy_source).toBe("DX-Y.NYB");
    for (const [k, v] of Object.entries(m)) if (k !== "dxy_source" && k !== "macro_bar_date") expect(v, k).not.toBeNull();
  });

  it("yields are in percent on Yahoo today: 10y 4.904, 3m 4.168, curve 0.736 pp", () => {
    const m = computeMacro(realInput());
    expect(m.yield_10y).toBeCloseTo(4.904, 3);
    expect(m.yield_3m).toBeCloseTo(4.168, 3);
    expect(m.curve_10y_3m).toBeCloseTo(0.736, 3);
    expect(m.credit_ratio).toBeCloseTo(76.43 / 103.79, 6);
    expect(m.copper_gold_ratio).toBeCloseTo(22.0 / 325.45, 6);
  });

  it("BTC never looks past the stock session: UTC days up to macro_bar_date only", () => {
    const input = realInput();
    const m = computeMacro({ ...input, hyg: input.hyg!.slice(0, -2), lqd: input.lqd!.slice(0, -2) });
    expect(m.macro_bar_date! < "2026-11-24").toBe(true);
    const cut = computeMacro({ ...input, btc: input.btc!.filter((b) => new Date(b.time! * 1000).toISOString().slice(0, 10) <= m.macro_bar_date!) });
    expect(m.btc_return_20d).toBe(cut.btc_return_20d);
  });
});

// Synthetic weekday bars at 14:30 UTC (ET date = UTC date).
function series(closes: number[], start = Date.UTC(2026, 0, 5, 14, 30) / 1000): DailyBar[] {
  const out: DailyBar[] = [];
  let t = start;
  for (const c of closes) {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    out.push({ open: c, high: c, low: c, close: c, volume: 1, time: t });
    t += 86_400;
  }
  return out;
}
const lin = (n: number, a: number, step: number) => Array.from({ length: n }, (_, i) => a + step * i);

describe("exact values on synthetic bars", () => {
  const n = 60;
  const input: MacroInput = {
    dxy: series(lin(n, 100, 0.1)), uup: null,
    hyg: series(lin(n, 80, 0.2)), lqd: series(Array(n).fill(100)),
    tnx: series(lin(n, 4, 0.01)), irx: series(Array(n).fill(4)),
    gld: series(Array(n).fill(200)), dbb: series(lin(n, 20, 0.05)),
    btc: null,
  };
  const m = computeMacro(input);
  it("dollar: close, 20-session return, close vs SMA50", () => {
    const last = 100 + 0.1 * 59;
    expect(m.dxy_close).toBeCloseTo(last, 12);
    expect(m.dxy_return_20d).toBeCloseTo(last / (100 + 0.1 * 39) - 1, 12);
    const sma50 = (100 + 0.1 * 10 + last) / 2; // mean of bars 10..59
    expect(m.dxy_vs_sma50).toBeCloseTo(last / sma50 - 1, 12);
  });
  it("credit ratio, curve (pp) and copper/gold with 20-session changes", () => {
    expect(m.credit_ratio).toBeCloseTo((80 + 0.2 * 59) / 100, 12);
    expect(m.credit_ratio_change_20d).toBeCloseTo((80 + 0.2 * 59) / (80 + 0.2 * 39) - 1, 12);
    expect(m.yield_10y).toBeCloseTo(4.59, 12);
    expect(m.curve_10y_3m).toBeCloseTo(0.59, 12);
    expect(m.curve_change_20d).toBeCloseTo(0.2, 12); // percentage points, not a ratio
    expect(m.copper_gold_change_20d).toBeCloseTo((20 + 0.05 * 59) / (20 + 0.05 * 39) - 1, 12);
  });
  it("macro_bar_date is the latest session every stock-market series has", () => {
    expect(commonBarDate([input.dxy, input.hyg!.slice(0, -3), null])).toBe(commonBarDate([input.hyg!.slice(0, -3)]));
    const late = computeMacro({ ...input, hyg: input.hyg!.slice(0, -3) });
    expect(late.dxy_close).toBeCloseTo(100 + 0.1 * 56, 12); // the dollar is cut to the same date
  });
});

describe("yield scale", () => {
  it("a ×10 quote (Yahoo's old ^TNX scale) is divided by 10; a percent quote is kept", () => {
    expect(normalizeYield(49.04)).toBeCloseTo(4.904, 12);
    expect(normalizeYield(4.904)).toBe(4.904);
    const n = 30;
    const m = computeMacro({
      dxy: null, uup: null, hyg: null, lqd: null, gld: null, dbb: null, btc: null,
      tnx: series(Array(n).fill(49.04)), irx: series(Array(n).fill(4.168)),
    });
    expect(m.yield_10y).toBeCloseTo(4.904, 12);
    expect(m.curve_10y_3m).toBeCloseTo(0.736, 12);
  });
});

describe("missing data", () => {
  it("a failed series gives null fields and a warning, never a throw; UUP stands in for the dollar index", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const getChart = vi.fn(async (s: string) =>
      s === MACRO_SYMBOLS.hyg || s === MACRO_SYMBOLS.dxy ? { ok: false as const, status: 404, rateLimited: false } : { ok: true as const, json: json(s) },
    );
    const m = await computeMacroExtras(getChart as never, new Date("2026-11-24T21:20:00Z"));
    expect(m.credit_ratio).toBeNull();
    expect(m.credit_ratio_change_20d).toBeNull();
    expect(m.dxy_source).toBe("UUP");
    expect(m.dxy_close).toBeCloseTo(29.63, 2);
    expect(m.yield_10y).not.toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/\[macro\] missing series: DX-Y.NYB \(using UUP\), HYG/);
    const none = await computeMacroExtras((async () => { throw new Error("network"); }) as never);
    expect(none.macro_bar_date).toBeNull();
    expect(Object.entries(none).filter(([k, v]) => k !== "macro_version" && v != null)).toEqual([]);
    warn.mockRestore();
    log.mockRestore();
  });
});

describe("harness and health report", () => {
  const macro = computeMacro(realInput()) as unknown as Record<string, unknown>;
  const rf = { regime_version: 1, spy_close_vs_sma20: 0.01, macro };

  it("macro.* are conditioning columns only: present in attrs, never candidates; no regime.macro", () => {
    const attrs = scanAttrs(rf, { regime: true });
    expect(attrs["macro.curve_10y_3m"]).toBe(macro.curve_10y_3m);
    expect(attrs).not.toHaveProperty("regime.macro");
    const row: StoredSnapshotRow = {
      scanId: "s1", scanStartedAt: new Date("2026-11-25T13:30:00Z"), symbol: "AMD", sessionDate: "2026-11-24", close: 1,
      features: { rsi14: 50 }, regimeFeatures: rf,
    };
    const rows = buildUniverseRows([row], [{ date: "2026-11-24", close: 1 }]);
    expect(rows[0].attrs["macro.yield_10y"]).toBe(macro.yield_10y);
    expect(candidateKeys(rows).filter((k) => k.startsWith("macro.") || k === "regime.macro")).toEqual([]);
    expect(candidateKeys(rows)).toContain("regime.spy_close_vs_sma20");
  });

  it("crypto rows get macro.* but not the stock regime (P3-0e: regime stays stock-only)", () => {
    const row: StoredSnapshotRow = {
      scanId: "s1", scanStartedAt: new Date("2026-11-25T13:30:00Z"), symbol: "ETH-USD", sessionDate: "2026-11-24", close: 1,
      features: { rsi14: 50 }, regimeFeatures: rf, assetClass: "crypto",
    };
    const rows = buildUniverseRows([row], [{ date: "2026-11-24", close: 1 }], { crypto: true, benchmark: "BTC-USD" });
    expect(Object.keys(rows[0].attrs).some((k) => k.startsWith("regime."))).toBe(false);
    expect(rows[0].attrs["macro.btc_vs_sma50"]).toBe(macro.btc_vs_sma50);
  });

  it("health report shows the macro keys and flags null ones", () => {
    const base = { scanId: "s1", startedAt: NOW, universeSize: 1500, sectorRotation: { a: 1 }, stpRows: 1, tickers: [] };
    const ok = analyzeScan({ ...base, regimeFeatures: rf });
    expect(renderText([ok], [])).toMatch(/Macro \(2026-11-24\): dxy_source=DX-Y.NYB, dxy_close=103.8/);
    expect(flagsFor([ok]).some((f) => f.message.startsWith("macro"))).toBe(false);
    const partial = analyzeScan({ ...base, regimeFeatures: { ...rf, macro: { ...macro, credit_ratio: null } } });
    expect(flagsFor([partial]).map((f) => f.message)).toContain("macro fields null: credit_ratio");
    const onlyMacro = analyzeScan({ ...base, regimeFeatures: { macro } });
    expect(onlyMacro.scanLevel.regime).toBe(false);
  });
});
