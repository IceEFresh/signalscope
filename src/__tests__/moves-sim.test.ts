import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { zigzag } from "@/lib/harvester/universe/swings";
import { atrSeries, scanSymbol } from "@/lib/eval/stp-sim";
import {
  moveInputs,
  MoveStats,
  newMoveStatsTable,
  P3K4_COMPARISONS,
  P3K4_GATE_STEPS,
  p3k4Lines,
  p3k4Member,
  symbolMoves,
  uturnTriggers,
  withMoves,
  type P3k4Candidate,
} from "@/lib/eval/moves-sim";
import { MOVE_VARIANTS, type Move } from "@/lib/eval/moves";
import { LIVE_P3K4_KEYS, liveStpKeys } from "@/lib/harvester/universe/stp-live";
import { isLiveStpKey } from "@/lib/health/harvest-health";

/** A deterministic trending random walk with pullbacks (seeded LCG), weekday dates. */
function walk(n: number, seed = 7): DailyBar[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  let t = Date.UTC(2023, 0, 2, 14, 30) / 1000;
  let c = 50;
  const out: DailyBar[] = [];
  for (let k = 0; k < n; k++) {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const drift = Math.sin(k / 40) * 0.4;
    const o = c + (rnd() - 0.5) * 0.8;
    c = Math.max(5, o + drift + (rnd() - 0.5) * 2.4);
    const h = Math.max(o, c) + rnd() * 1.2;
    const l = Math.min(o, c) - rnd() * 1.2;
    out.push({ open: o, high: h, low: l, close: c, volume: 1e6 * (0.5 + rnd()), time: t });
    t += 86_400;
  }
  return out;
}

describe("U-turn triggers over the whole history", () => {
  const bars = walk(420);
  const found = uturnTriggers(bars);

  it("every butn / brutn the STP scan records is found, with its candle shape", () => {
    const scanned = scanSymbol("W", bars);
    const fromScan = [...scanned.setups, ...scanned.rollingSetups].filter((s) => s.type === "butn" || s.type === "brutn");
    expect(fromScan.length).toBeGreaterThan(0);
    const key = (x: { i: number; type: string }) => `${x.i}:${x.type}`;
    const set = new Set(found.map(key));
    for (const s of fromScan) expect(set.has(key(s)), key(s)).toBe(true);
    for (const f of found) {
      const b = bars[f.i];
      const p = bars[f.i - 1];
      expect(f.type === "butn" ? b.close > b.open! && p.close < p.open! : b.close < b.open! && p.close > p.open!).toBe(true);
      expect(f.dir).toBe(f.type === "butn" ? 1 : -1);
    }
  });

  it("the detector runs on a real-shaped series: completed moves, no move starts while one is active", () => {
    const inp = moveInputs(bars, zigzag(bars, 2), atrSeries(bars), found);
    const det = symbolMoves(inp);
    for (const d of [1, -1] as const) {
      const ms = det[d].moves;
      expect(ms.length).toBeGreaterThan(0);
      for (let k = 1; k < ms.length; k++) expect(ms[k].knownAt).toBeGreaterThan(ms[k - 1].endBar!);
      for (const m of ms) expect(m.endBar!).toBeGreaterThanOrEqual(m.knownAt);
    }
    // Every descriptive variant runs
    for (const opts of Object.values(MOVE_VARIANTS)) expect(() => symbolMoves(inp, opts)).not.toThrow();
  });
});

describe("p3k4 membership and comparisons", () => {
  const v2 = { ma: true, opens: true, screens: true, base: true, earnings: true, rr: true, optimal: true, room: false, room75: false, slope: false };
  const cand = (move: Partial<P3k4Candidate["move"]>, gates = v2) =>
    ({ v2: gates, move: { active: true, startType: "uturn", pausesSoFar: 1, moveUsed: 0.3, profile: null, pass: true, passNoVolume: true, volumeOk: true, ...move } }) as unknown as P3k4Candidate;

  it("the P3-0k3 gates with the move gate in place of the room gate", () => {
    expect(p3k4Member(cand({}))).toBe(true); // room gate failed, move gate passed
    expect(p3k4Member(cand({ pass: false }))).toBe(false);
    expect(p3k4Member(cand({}, { ...v2, screens: false }))).toBe(false);
    expect(p3k4Member(cand({ volumeOk: false }))).toBe(false); // volume amendment
    expect(P3K4_GATE_STEPS.map(([s]) => s).slice(-5)).toEqual([
      "an active move at D",
      "a move profile (≥ 3 completed moves)",
      "pauses so far 1 or 2",
      "move used ≤ 0.5",
      "trigger volume (U-turn above average, inside below; equal or missing fails)",
    ]);
  });

  it("4 provisional comparisons labelled p3k4, benchmarked on all P3-0k3 triggers", () => {
    expect(P3K4_COMPARISONS.map((c) => c.id)).toEqual(["p3k4:vs-all:long", "p3k4:vs-control:long", "p3k4:vs-all:short", "p3k4:vs-control:short"]);
    expect(P3K4_COMPARISONS.every((c) => c.provisional)).toBe(true);
    const t = { arm: "stop", population: "p3k3_all", dir: 1 } as never;
    expect(P3K4_COMPARISONS[0].bench!(t)).toBe(true);
  });

  it("withMoves attaches the position at the trigger bar", () => {
    const bars = walk(300);
    const inp = moveInputs(bars, zigzag(bars, 2), atrSeries(bars), uturnTriggers(bars));
    const det = symbolMoves(inp);
    const c = { dir: 1, setup: { i: 250, entry: bars[250].high + 0.1, type: "inside" } } as unknown as Parameters<typeof withMoves>[0][number];
    const [w] = withMoves([c], inp, det);
    expect(w.move.active).toBe(det[1].activeAt[250] != null);
  });
});

describe("report", () => {
  it("MoveStats accumulates without keeping moves; the section renders with no trades", () => {
    const m = (size: number, end: number | null): Move => ({ dir: 1, startType: "breakout", startBar: 0, knownAt: 0, anchor: 0, rangeEdge: 0, atrStart: 1, extreme: size, endType: end == null ? null : "failed_breakout", endBar: end, size, legs: 2, pauses: [0.8], duration: 4, failed: size < 1 });
    const s = new MoveStats();
    s.add([m(5, 10), m(0.5, 12), m(7, null)]);
    expect(s.summary()).toMatchObject({ moves: 2, failed: 1, open: 1, medianSize: 5, medianLegs: 2, failedByStart: { breakout: { n: 2, failed: 1 } } });
    const t = newMoveStatsTable();
    t.primary.long.add([m(5, 10)]);
    const lines = p3k4Lines([], [], { long: [], short: [] }, t).join("\n");
    expect(lines).toContain("## P3-0k4: moves, not legs");
    expect(lines).toContain("| long | 1 | 0 (0.0%) | 0 | 5.00 |");
    expect(lines).toContain("pauses so far no active move");
    expect(lines).toContain("| range 2 ATR | long |");
  });
});

describe("live keys", () => {
  it("move keys are written on stock rows and registered as log-only", () => {
    const bars = walk(300);
    const keys = liveStpKeys(bars, undefined, { assetClass: "stock", events: [] }) as Record<string, unknown>;
    for (const k of LIVE_P3K4_KEYS) {
      expect(k in keys, k).toBe(true);
      expect(isLiveStpKey(k), k).toBe(true);
    }
    expect(typeof keys.move_active).toBe("boolean");
  });
});
