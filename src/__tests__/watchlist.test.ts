import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import type { RawSignal } from "@/lib/harvester/types";
import {
  hitCounts,
  parseWatchStore,
  sessionsBetween,
  updateWatchStore,
  watchHits,
  watchKeys,
  watchSourceHealth,
  withinWatch,
  WATCH_SESSIONS,
} from "@/lib/harvester/watchlist";
import { liveStpKeys, LIVE_WATCH_KEYS } from "@/lib/harvester/universe/stp-live";
import { isLiveStpKey } from "@/lib/health/harvest-health";
import type { StpResult } from "@/lib/harvester/universe/stp";
import { spikeFor, volumeSpikes, watchMember } from "@/lib/eval/watch-backfill";
import type { Candidate } from "@/lib/eval/funnel-sim";

const sig = (source: RawSignal["source"], extra: Partial<RawSignal> = {}): RawSignal => ({ symbol: "abc", source, ...extra });

describe("the 10-session watch window", () => {
  // Monday 2026-01-05; +10 weekdays = Monday 2026-01-19, +11 = Tuesday 2026-01-20
  it("a hit keeps the ticker watched through session 10 and drops it at 11", () => {
    expect(WATCH_SESSIONS).toBe(10);
    expect(sessionsBetween("2026-01-05", "2026-01-19")).toBe(10);
    expect(withinWatch("2026-01-05", "2026-01-05")).toBe(true);
    expect(withinWatch("2026-01-05", "2026-01-19")).toBe(true);
    expect(withinWatch("2026-01-05", "2026-01-20")).toBe(false);
    const day0 = updateWatchStore(null, [{ symbol: "ABC", source: "insider", direction: "bullish" }], "2026-01-05");
    expect(Object.keys(updateWatchStore(day0, [], "2026-01-19").entries)).toEqual(["ABC"]);
    expect(Object.keys(updateWatchStore(day0, [], "2026-01-20").entries)).toEqual([]);
  });
  it("a new hit extends the window; first_seen stays; an expired source drops out of watch_sources", () => {
    let s = updateWatchStore(null, [{ symbol: "ABC", source: "insider", direction: "bullish" }], "2026-01-05");
    s = updateWatchStore(s, [{ symbol: "ABC", source: "reddit", direction: null }], "2026-01-15");
    expect(watchKeys(s.entries.ABC, "2026-01-19")).toEqual({ watch_sources: "reddit insider", watch_first_seen: "2026-01-05", watch_direction: "bullish", directional: true });
    s = updateWatchStore(s, [], "2026-01-20"); // insider (01-05) is 11 sessions old; reddit (01-15) isn't
    expect(watchKeys(s.entries.ABC, "2026-01-20")).toEqual({ watch_sources: "reddit", watch_first_seen: "2026-01-05", watch_direction: null, directional: false });
  });
  it("an unreadable store starts fresh", () => {
    expect(parseWatchStore({ version: 2 }).entries).toEqual({});
    expect(parseWatchStore(null).entries).toEqual({});
  });
});

describe("direction per source", () => {
  it("insider and congress purchases are bullish; a sale isn't a buy signal", () => {
    const hits = watchHits([
      sig("SEC_INSIDER", { title: "Insider purchase: Jane Doe (CEO) bought $1,000,000 of ABC" }),
      sig("SEC_INSIDER", { title: "Insider sale: Jane Doe (CEO) sold $1,000,000 of ABC" }),
      sig("CONGRESS", { title: "Congress buy: Senate Smith (R) purchased ABC" }),
    ]);
    expect(hits).toEqual([
      { symbol: "ABC", source: "insider", direction: "bullish" },
      { symbol: "ABC", source: "congress", direction: "bullish" },
    ]);
  });
  it("options by net premium sign (zero or unknown isn't a hit); volume by the day's move; social and Polymarket have no direction", () => {
    const hits = watchHits(
      [
        sig("OPTIONS_FLOW", { netPremium: 2e6 }),
        sig("OPTIONS_FLOW", { netPremium: -5e5 }),
        sig("OPTIONS_FLOW", { netPremium: 0 }),
        sig("OPTIONS_FLOW"),
        sig("VOLUME_SPIKE"),
        sig("REDDIT"),
        sig("STOCKTWITS"),
        sig("TWITTER"),
        sig("POLYMARKET"),
        sig("GRADUATION"),
      ],
      () => -1.5,
    );
    expect(hits.map((h) => [h.source, h.direction])).toEqual([
      ["options", "bullish"],
      ["options", "bearish"],
      ["volume", "bearish"],
      ["reddit", null],
      ["stocktwits", null],
      ["x", null],
      ["polymarket", null],
    ]);
    expect(hitCounts(hits)).toMatchObject({ options: 2, volume: 1, insider: 0, congress: 0 });
  });
  it("two sources disagreeing on the latest day give no direction", () => {
    const s = updateWatchStore(null, [{ symbol: "ABC", source: "options", direction: "bullish" }, { symbol: "ABC", source: "volume", direction: "bearish" }], "2026-01-05");
    expect(watchKeys(s.entries.ABC, "2026-01-05").watch_direction).toBeNull();
  });
});

describe("watch_entry_ready", () => {
  // 210 rising bars: no level above a long entry just over the last high → open_air, R/R = 10 ATR / risk
  const bars: DailyBar[] = (() => {
    let t = Date.UTC(2025, 0, 6, 14, 30) / 1000;
    return Array.from({ length: 210 }, (_, k) => {
      while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
      const c = 100 + k;
      const b = { open: c - 1, high: c + 0.5, low: c - 1.5, close: c, volume: 1, time: t };
      t += 86_400;
      return b;
    });
  })();
  const last = bars[bars.length - 1];
  const barDate = new Date(last.time! * 1000).toISOString().slice(0, 10);
  const stp = (trigger: 1 | -1, entry: number, stop: number) =>
    ({ barDate, trigger, triggerType: "inside", entry, stop, htfOpens: 1, maState: 1, firedRules: [], fudge: 0.2 }) as unknown as StpResult;
  const watched = (dir: "bullish" | "bearish" | null) => ({ watch_sources: "volume", watch_first_seen: "2025-10-01", watch_direction: dir, directional: dir != null });
  const keys = (s: StpResult | undefined, w?: ReturnType<typeof watched>) => liveStpKeys(bars, s, { assetClass: "stock", events: [], watch: w });

  it("true with a trigger in the watch direction and R/R ≥ 3; false when R/R < 3 or the trigger points the other way", () => {
    expect(keys(stp(1, last.high + 0.2, last.low - 0.2), watched("bullish")).watch_entry_ready).toBe(true);
    expect(keys(stp(1, last.high + 0.2, last.high + 0.2 - 50), watched("bullish")).watch_entry_ready).toBe(false); // risk 50: R/R ≈ 0.4
    expect(keys(stp(1, last.high + 0.2, last.low - 0.2), watched("bearish")).watch_entry_ready).toBe(false);
    expect(keys(undefined, watched("bullish")).watch_entry_ready).toBe(false); // watched, no trigger today
  });
  it("not watched → null, not false; a directionless watch takes the trigger's direction (P3-0l2); the size follows the P3-0k layer rule", () => {
    const off = keys(stp(1, last.high + 0.2, last.low - 0.2));
    expect([off.watch_sources, off.watch_direction, off.watch_entry_ready, off.watch_size]).toEqual([null, null, null, null]);
    expect(keys(stp(1, last.high + 0.2, last.low - 0.2), watched(null))).toMatchObject({ watch_entry_ready: true, watch_direction: "bullish", watch_direction_source: "trigger" });
    expect(keys(stp(1, last.high + 0.2, last.low - 0.2), watched("bullish")).watch_size).toBe(0.25); // three unknown layers
    for (const k of LIVE_WATCH_KEYS) expect(isLiveStpKey(k)).toBe(true);
  });
});

describe("source health", () => {
  const scan = (scanId: string, bySource: Record<string, number>) => ({ scanId, bySource });
  it("warns for a source with zero hits in each of the last 3 runs only", () => {
    const h = watchSourceHealth([scan("s3", { REDDIT: 4 }), scan("s2", { REDDIT: 2, STOCKTWITS: 0 }), scan("s1", { REDDIT: 1 })]);
    expect(h.lines[0]).toContain("reddit 4, stocktwits 0");
    expect(h.warnings).toContain("WARNING [watch] stocktwits: zero hits in each of the last 3 runs");
    expect(h.warnings).not.toContain("WARNING [watch] reddit: zero hits in each of the last 3 runs");
    const later = watchSourceHealth([scan("s4", { STOCKTWITS: 1 }), scan("s3", {}), scan("s2", {})]);
    expect(later.warnings.some((w) => w.includes("stocktwits"))).toBe(false);
    expect(watchSourceHealth([scan("a", {}), scan("b", {})]).warnings).toEqual([]); // fewer than 3 runs: no warning yet
  });
});

describe("volume-spike backfill (descriptive)", () => {
  const vbars = (vols: number[], closes: number[]): DailyBar[] => vols.map((v, k) => ({ open: closes[k], high: closes[k] + 1, low: closes[k] - 1, close: closes[k], volume: v, time: 1_700_000_000 + k * 86_400 }));
  it("a spike is volume ≥ 2 × the prior 10-session average; direction from the close", () => {
    const v = [...Array(10).fill(100), 200, 199, 100];
    const c = [...Array(10).fill(10), 11, 10, 10];
    const s = volumeSpikes(vbars(v, c));
    expect(s.map((x) => [x.i, x.dir])).toEqual([[10, 1]]); // 199 vs avg 110 isn't 2×
  });
  it("a trigger counts 0–10 sessions after a spike in the same direction; entry ready needs R/R ≥ 3", () => {
    const spikes = [{ i: 10, dir: 1 as const, ratio: 2 }];
    const c = (i: number, dir: 1 | -1, rr: number) => ({ setup: { i }, dir, rr: { rr } }) as unknown as Candidate;
    expect(spikeFor(c(10, 1, 3) as never, spikes)).not.toBeNull();
    expect(spikeFor(c(20, 1, 3) as never, spikes)).not.toBeNull();
    expect(spikeFor(c(21, 1, 3) as never, spikes)).toBeNull();
    expect(spikeFor(c(12, -1, 3) as never, spikes)).toBeNull();
    expect(watchMember("watch_volume", spikes)(c(12, 1, 2.9))).toBe(false);
    expect(watchMember("watch_volume", spikes)(c(12, 1, 3))).toBe(true);
    expect(watchMember("watch_volume_any", spikes)(c(12, 1, 0.5))).toBe(true);
  });
});

describe("P3-0l2: directionless sources take the trigger's direction", () => {
  const bars: DailyBar[] = (() => {
    let t = Date.UTC(2025, 0, 6, 14, 30) / 1000;
    return Array.from({ length: 210 }, (_, k) => {
      while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
      const c = 100 + k;
      const b = { open: c - 1, high: c + 0.5, low: c - 1.5, close: c, volume: 1, time: t };
      t += 86_400;
      return b;
    });
  })();
  const last = bars[bars.length - 1];
  const barDate = new Date(last.time! * 1000).toISOString().slice(0, 10);
  const stp = (trigger: 1 | -1, entry: number, stop: number) =>
    ({ barDate, trigger, triggerType: "inside", entry, stop, htfOpens: 1, maState: 1, firedRules: [], fudge: 0.2 }) as unknown as StpResult;
  const social = { watch_sources: "reddit", watch_first_seen: "2025-10-01", watch_direction: null, directional: false };
  const keys = (s: StpResult | undefined, w: typeof social | Record<string, unknown>) => liveStpKeys(bars, s, { assetClass: "stock", events: [], watch: w as never });

  it("any trigger with R/R ≥ 3 → ready, the trigger's direction, flagged watch_direction_source = trigger", () => {
    const k = keys(stp(1, last.high + 0.2, last.low - 0.2), social);
    expect([k.watch_entry_ready, k.watch_direction, k.watch_direction_source, k.watch_size]).toEqual([true, "bullish", "trigger", 0.25]);
  });
  it("R/R < 3 or no trigger → not ready, direction stays null", () => {
    const k = keys(stp(1, last.high + 0.2, last.high + 0.2 - 50), social);
    expect([k.watch_entry_ready, k.watch_direction, k.watch_direction_source, k.watch_size]).toEqual([false, null, null, null]);
    expect(keys(undefined, social).watch_entry_ready).toBe(false);
  });
  it("a directional source keeps its own direction (watch_direction_source = source); disagreeing sources stay null", () => {
    const k = keys(stp(1, last.high + 0.2, last.low - 0.2), { watch_sources: "insider", watch_first_seen: "2025-10-01", watch_direction: "bullish", directional: true });
    expect([k.watch_entry_ready, k.watch_direction, k.watch_direction_source]).toEqual([true, "bullish", "source"]);
    const tie = keys(stp(1, last.high + 0.2, last.low - 0.2), { watch_sources: "options volume", watch_first_seen: "2025-10-01", watch_direction: null, directional: true });
    expect([tie.watch_entry_ready, tie.watch_direction, tie.watch_direction_source]).toEqual([null, null, null]);
  });
  it("watchKeys marks whether any live hit has a direction", () => {
    const s = updateWatchStore(null, [{ symbol: "ABC", source: "reddit", direction: null }, { symbol: "XYZ", source: "insider", direction: "bullish" }], "2026-01-05");
    expect(watchKeys(s.entries.ABC, "2026-01-05").directional).toBe(false);
    expect(watchKeys(s.entries.XYZ, "2026-01-05").directional).toBe(true);
  });
});

describe("P3-0l2: watch_only rows", () => {
  it("picks watched names outside the universe, most recent hit first, capped at 150", async () => {
    const { watchOnlySymbols, WATCH_ONLY_CAP } = await import("@/lib/harvester/watchlist");
    let s = updateWatchStore(null, [{ symbol: "OLD", source: "insider", direction: "bullish" }, { symbol: "AAPL", source: "reddit", direction: null }], "2026-01-05");
    s = updateWatchStore(s, [{ symbol: "NEW", source: "volume", direction: "bullish" }], "2026-01-07");
    expect(watchOnlySymbols(s, ["aapl", "MSFT"])).toEqual({ symbols: ["NEW", "OLD"], skipped: 0 });
    expect(watchOnlySymbols(s, [], 1)).toEqual({ symbols: ["NEW"], skipped: 2 });
    expect(WATCH_ONLY_CAP).toBe(150);
  });
  it("the P3-0c/P3-0d universe dataset drops watch_only rows", async () => {
    const { buildUniverseRows } = await import("@/lib/eval/universe-dataset");
    const row = (symbol: string, features: Record<string, unknown>) => ({
      scanId: "s1", scanStartedAt: new Date("2026-11-25T13:30:00Z"), symbol, sessionDate: "2026-11-24", close: 1, features, regimeFeatures: null,
    });
    const rows = buildUniverseRows([row("AMD", { rsi14: 50 }), row("TINY", { rsi14: 40, watch_only: true })], [{ date: "2026-11-24", close: 1 }]);
    expect(rows.map((r) => r.symbol)).toEqual(["AMD"]);
  });
});
