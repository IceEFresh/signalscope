import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { etParts, parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { computeStp, type StpResult } from "@/lib/harvester/universe/stp";
import { computeStpRolling, rollingHtfOpensAt, ROLLING_WINDOWS } from "@/lib/harvester/universe/stp-rolling";
import { liveStpKeys, LIVE_STP_KEY_PREFIXES } from "@/lib/harvester/universe/stp-live";
import { swingEntry } from "@/lib/harvester/universe/swings";
import { computeSnapshotRows } from "@/lib/harvester/universe/snapshot";
import { cryptoSnapshotRow, parseCryptoBars } from "@/lib/harvester/crypto/universe";
import { liveContextFor, loadLiveEtfStates } from "@/lib/harvester/universe/harvest-prep";
import { stockFactor } from "@/lib/eval/stp-sim";
import { candidateKeys } from "@/lib/eval/features";
import { familyOf, isLiveStpKey } from "@/lib/health/harvest-health";
import type { EtfState } from "@/lib/harvester/universe/pyramid";

const raw = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8")) as unknown;
const NOW = new Date("2030-01-01T00:00:00Z");
const amd = parseChartBars(raw("universe/chart-AMD-3mo.json"), NOW);
const stpAmd = computeStp(amd);
const lastDate = etParts(new Date(amd.at(-1)!.time! * 1000)).date;

describe("P3-0i2 live keys on a stock", () => {
  const k = liveStpKeys(amd, stpAmd, { assetClass: "stock" });

  it("logs every family's keys on every row (null when not computable)", () => {
    for (const p of LIVE_STP_KEY_PREFIXES) expect(Object.keys(k).some((key) => key.startsWith(p)), p).toBe(true);
    expect(k).toHaveProperty("stp_trigger_type_rolling");
    expect(k).toHaveProperty("pyramid_market_spy_htf", null); // no ETF states given
  });

  it("rolling opens use 5/20 sessions for stocks and 7/30 bars for crypto", () => {
    const t = amd.length - 1;
    expect(k.stp_htf_opens_rolling).toBe(rollingHtfOpensAt(amd, t, ROLLING_WINDOWS.stock));
    expect(k.stp_trigger_rolling).toBe(computeStpRolling(amd, ROLLING_WINDOWS.stock).trigger);
    const c = liveStpKeys(amd, stpAmd, { assetClass: "crypto" });
    expect(c.stp_htf_opens_rolling).toBe(rollingHtfOpensAt(amd, t, ROLLING_WINDOWS.crypto));
    expect(c.stp_trigger_rolling).toBe(computeStpRolling(amd, ROLLING_WINDOWS.crypto).trigger);
  });

  it("a rolling open exactly at the window edge: defined with 20 bars, null with 19 (stocks)", () => {
    expect(liveStpKeys(amd.slice(0, 20), undefined, { assetClass: "stock" }).stp_htf_opens_rolling).not.toBeNull();
    expect(liveStpKeys(amd.slice(0, 19), undefined, { assetClass: "stock" }).stp_htf_opens_rolling).toBeNull();
    expect(liveStpKeys(amd.slice(0, 30), undefined, { assetClass: "crypto" }).stp_htf_opens_rolling).not.toBeNull();
    expect(liveStpKeys(amd.slice(0, 29), undefined, { assetClass: "crypto" }).stp_htf_opens_rolling).toBeNull();
  });

  it("a U-turn reads the rolling trend at t−3", () => {
    // 60 bars, open = 100 + i, close 200: price far above every rolling open
    let t0 = Date.UTC(2026, 0, 5, 14, 30) / 1000;
    const u: DailyBar[] = Array.from({ length: 60 }, (_, i) => {
      while ([0, 6].includes(new Date(t0 * 1000).getUTCDay())) t0 += 86_400;
      const b = { open: 100 + i, high: 205, low: 99 + i, close: 200, volume: 1, time: t0 };
      t0 += 86_400;
      return b;
    });
    u[57] = { ...u[57], open: 250, high: 260, low: 150, close: 255 };
    u[58] = { ...u[58], open: 240, high: 250, low: 140, close: 141 };
    u[59] = { ...u[59], open: 142, high: 249, low: 139, close: 150 };
    expect(liveStpKeys(u, undefined, { assetClass: "stock" }).stp_trigger_type_rolling).toBe("butn");
    u[56] = { ...u[56], close: 50 }; // only t−3's rolling trend flips
    expect(liveStpKeys(u, undefined, { assetClass: "stock" }).stp_trigger_type_rolling).not.toBe("butn");
  });

  it("size factors use the fixed rule per direction; the live stp_size_factor (abs) is untouched", () => {
    expect(k.stp_size_factor_long).toBe(stockFactor(stpAmd.htfOpens, stpAmd.maState, 1));
    expect(k.stp_size_factor_short).toBe(stockFactor(stpAmd.htfOpens, stpAmd.maState, -1));
    const stale: StpResult = { ...stpAmd, barDate: "1999-01-01" };
    expect(liveStpKeys(amd, stale, { assetClass: "stock" }).stp_size_factor_long).toBeNull(); // STP from another bar is not used
  });

  it("Power Pyramid keys from the ETF states on the row's date; sizes combine with the stock factor", () => {
    const agree = new Map<string, EtfState>([[lastDate, { opens: 1, trend: 1 }]]);
    const down = new Map<string, EtfState>([[lastDate, { opens: -1, trend: -1 }]]);
    const p = liveStpKeys(amd, stpAmd, { assetClass: "stock", market: [agree, agree, down], sectorEtf: "XLK", sectorStates: down, industryEtf: "SMH", industryStates: agree });
    expect(p).toMatchObject({
      pyramid_market_spy_htf: 1, pyramid_market_dia_htf: -1, pyramid_market_long: "agree", pyramid_market_short: "disagree",
      pyramid_sector_etf: "XLK", pyramid_sector_long: "disagree", pyramid_industry_etf: "SMH", pyramid_industry_long: "agree",
      pyramid_size_long: 0.5, pyramid_size_short: 0.5,
    });
    expect(p.size_combined_long).toBe(Math.max(0.25, (p.stp_size_factor_long as number) * 0.5));
  });

  it("Finviz: base as a boolean and the passing screens as space-joined IDs; none on crypto", () => {
    expect(typeof k.finviz_base === "boolean" || k.finviz_base === null).toBe(true);
    expect(typeof k.finviz_screens).toBe("string");
    const c = liveStpKeys(amd, stpAmd, { assetClass: "crypto" });
    expect(Object.keys(c).some((x) => x.startsWith("finviz_") || x.startsWith("pyramid_"))).toBe(false);
  });

  it("swings: room_3r only with an STP trigger (from its entry and stop); otherwise null", () => {
    const trig: StpResult = { ...stpAmd, trigger: 1, triggerType: "inside", entry: amd.at(-1)!.high + 0.5, stop: amd.at(-1)!.low - 0.5 };
    const t = liveStpKeys(amd, trig, { assetClass: "stock" });
    const e = swingEntry(amd, amd.length - 1, trig.entry!, trig.entry! - trig.stop!, 1, 2);
    expect(t.swing_k2_room_3r_at_entry).toBe(e.room3R);
    expect(t.swing_k2_rally_used).toBe(e.rallyUsed);
    const none: StpResult = { ...stpAmd, trigger: 0, entry: null, stop: null };
    expect(liveStpKeys(amd, none, { assetClass: "stock" }).swing_k2_room_3r_at_entry).toBeNull();
  });
});

describe("P3-0i2 wiring", () => {
  it("the snapshot rows carry the live keys; a failure in them never drops the row", async () => {
    const cache: Record<string, unknown> = { AMD: raw("universe/chart-AMD-3mo.json"), SPY: raw("universe/chart-SPY-3mo.json") };
    const peek = (s: string) => (cache[s] ? Promise.resolve({ ok: true as const, json: cache[s] }) : undefined);
    const ok = await computeSnapshotRows(["AMD"], { AMD: stpAmd }, peek, undefined, (_s, bars, r) => liveStpKeys(bars, r, { assetClass: "stock" }));
    expect(ok.rows.find((r) => r.symbol === "AMD")!.features).toHaveProperty("stp_htf_opens_rolling");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = await computeSnapshotRows(["AMD"], {}, peek, undefined, () => { throw new Error("boom"); });
    expect(bad.rows.map((r) => r.symbol).sort()).toEqual(["AMD", "SPY"]);
    warn.mockRestore();
  });

  it("crypto rows get the rolling keys at 7/30 and no stock-only keys", () => {
    const btc = parseCryptoBars(raw("crypto/chart-BTC-USD-3mo.json"), new Date("2026-11-24T21:20:00Z"));
    const row = cryptoSnapshotRow("BTC-USD", btc, btc)!;
    expect(row.features.stp_htf_opens_rolling).toBe(rollingHtfOpensAt(btc, btc.length - 1, ROLLING_WINDOWS.crypto));
    expect(Object.keys(row.features).some((x) => x.startsWith("pyramid_"))).toBe(false);
  });

  it("ETF states come from the run's chart cache only (no requests); the context maps sector and industry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cache: Record<string, unknown> = { SPY: raw("universe/chart-SPY-3mo.json"), XLK: raw("universe/chart-XLK-3mo.json") };
    const states = await loadLiveEtfStates((s) => (cache[s] ? Promise.resolve({ ok: true as const, json: cache[s] }) : undefined));
    expect([...states.keys()].sort()).toEqual(["SPY", "XLK"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const ctx = liveContextFor("AMD", { AMD: { sector: "Technology", industry: "Semiconductors" } }, states);
    expect(ctx).toMatchObject({ assetClass: "stock", sectorEtf: "XLK", industryEtf: "SMH", industryStates: null });
    expect(ctx.market).toHaveLength(3);
    expect(liveContextFor("ZZZ", {}, states)).toMatchObject({ sectorEtf: null, industryEtf: null });
  });

  it("live keys are not pre-registered candidates and belong to no health family", () => {
    const keys = Object.keys(liveStpKeys(amd, stpAmd, { assetClass: "stock" }));
    for (const key of keys) {
      expect(isLiveStpKey(key), key).toBe(true);
      expect(familyOf(key)).toBeNull();
    }
    expect(familyOf("stp_ma_state")).toBe("stp"); // the registered STP states stay
    const rows = [{ scanId: "s", scanStart: NOW, symbol: "X", ret: {}, excess: {}, attrs: { ...liveStpKeys(amd, stpAmd, { assetClass: "stock" }), stp_ma_state: 1 } }];
    expect(candidateKeys(rows)).toEqual(["stp_ma_state"]);
  });
});
