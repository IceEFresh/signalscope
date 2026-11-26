import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import type { Pivot } from "@/lib/harvester/universe/swings";
import {
  detectMoves,
  moveProfile,
  movePosition,
  MOVE_PRIMARY,
  MOVE_VARIANTS,
  summarizeMoves,
  type Move,
  type MoveInputs,
  type MoveTrigger,
} from "@/lib/eval/moves";

type Row = [number, number, number, number] | [number, number, number, number, number];
function weekdayBars(rows: Row[], start = Date.UTC(2025, 0, 6, 14, 30) / 1000): DailyBar[] {
  let t = start;
  return rows.map(([open, high, low, close, volume = 1e6]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume, time: t };
    t += 86_400;
    return b;
  });
}
const flat = (n: number, c = 100): Row[] => Array.from({ length: n }, () => [c, c + 0.5, c - 0.5, c]);
const piv = (kind: "high" | "low", i: number, price: number, confirmedAt: number): Pivot => ({ kind, i, price, confirmedAt, atr: 2 });
const trig = (i: number, type: string, dir: 1 | -1 = 1): MoveTrigger => ({ i, type, dir });

function inputs(rows: Row[], extra: Partial<MoveInputs> = {}): MoveInputs {
  const bars = weekdayBars(rows);
  return { bars, pivots: [], atr: bars.map(() => 2), triggers: [], breakoutScreen: () => true, ...extra };
}

describe("starts", () => {
  it("swing: a confirmed swing low above the previous one starts the move at the low's bar, known at confirmation", () => {
    const rows = flat(40);
    rows[10] = [100, 100.5, 95, 99];
    rows[20] = [100, 100.5, 97, 99];
    const inp = inputs(rows, { pivots: [piv("low", 10, 95, 12), piv("high", 15, 100.5, 17), piv("low", 20, 97, 22)], breakoutScreen: () => false });
    const { activeAt } = detectMoves(inp, 1);
    expect(activeAt[21]).toBeNull();
    expect(activeAt[22]).toMatchObject({ startType: "swing", startBar: 20, knownAt: 22, anchor: 97 });
    // A lower second low doesn't start one
    const lower = inputs(rows, { pivots: [piv("low", 10, 95, 12), piv("low", 20, 94, 22)], breakoutScreen: () => false });
    expect(detectMoves(lower, 1).activeAt.every((m) => m == null)).toBe(true);
  });

  it("U-turn: a butn trigger starts the move on its bar; the anchor is the low since the last confirmed swing high", () => {
    const rows = flat(40);
    rows[25] = [100, 100.5, 96, 99];
    const inp = inputs(rows, { pivots: [piv("high", 22, 100.5, 24)], triggers: [trig(30, "butn")], breakoutScreen: () => false });
    expect(detectMoves(inp, 1).activeAt[30]).toMatchObject({ startType: "uturn", startBar: 30, anchor: 96 });
  });

  it("range breakout: close above a ≤ 3 ATR 20-session range with F25/F22; a wider range or no screen is rejected; the filter-off variant takes it", () => {
    const rows = flat(30);
    rows[25] = [100, 102, 99.6, 101.8];
    const ok = detectMoves(inputs(rows), 1).activeAt[25];
    expect(ok).toMatchObject({ startType: "breakout", anchor: 99.5, rangeEdge: 99.5 });
    const wide = flat(30);
    wide[10] = [100, 100.5, 93, 100]; // range 7.5 > 3 × 2
    wide[25] = rows[25];
    expect(detectMoves(inputs(wide), 1).activeAt[25]).toBeNull();
    expect(detectMoves(inputs(rows, { breakoutScreen: () => false }), 1).activeAt[25]).toBeNull();
    expect(detectMoves(inputs(rows, { breakoutScreen: () => false }), 1, MOVE_VARIANTS["breakout without Finviz"]).activeAt[25]).not.toBeNull();
  });

  it("a start signal during an active move is ignored", () => {
    const inp = inputs(flat(40), { triggers: [trig(25, "butn"), trig(30, "butn")], breakoutScreen: () => false });
    const { activeAt } = detectMoves(inp, 1);
    expect(activeAt[30]).toBe(activeAt[25]);
    expect(activeAt[30]!.startBar).toBe(25);
  });
});

describe("ends", () => {
  const base = (vol: number, opts = MOVE_PRIMARY) => {
    const rows = flat(40);
    rows[32] = [100, 101, 99, 99.6, vol];
    return detectMoves(inputs(rows, { triggers: [trig(25, "butn"), trig(32, "brutn", -1)], breakoutScreen: () => false }), 1, opts);
  };

  it("a brutn on volume above its 20-session average ends the move; at or below average it doesn't", () => {
    expect(base(2e6).moves[0]).toMatchObject({ endType: "uturn_volume", endBar: 32 });
    expect(base(1e6).moves).toHaveLength(0);
    expect(base(1e6).activeAt[32]).not.toBeNull();
    expect(base(1e6, MOVE_VARIANTS["U-turn without volume"]).moves[0]?.endType).toBe("uturn_volume");
  });

  // Flat at 100 (sma20 = 100), a U-turn start on bar 30 closing 101, bar 31 closes 99.5: mX (close × sma20) arms low[31] − fudge = 98.78
  const mxRows = (after: Row[]): Row[] => [...flat(30), [100, 101.2, 99.8, 101], [101, 101, 99, 99.5], ...after];

  it("mX/pmX arms a level; the first later close below it ends the move", () => {
    const inp = inputs(mxRows([[99.5, 100, 99, 99.2], [99, 99.2, 98, 98.5]]), { triggers: [trig(30, "butn")], breakoutScreen: () => false });
    const { moves, activeAt } = detectMoves(inp, 1);
    expect(activeAt[32]).not.toBeNull(); // 99.2 is above 98.78
    expect(moves[0]).toMatchObject({ endType: "mx_break", endBar: 33 });
    // The "firing ends" variant ends on bar 31 itself
    expect(detectMoves(inp, 1, MOVE_VARIANTS["mX/pmX firing ends"]).moves[0]).toMatchObject({ endType: "mx_break", endBar: 31 });
  });

  it("a close at a new move high disarms the level", () => {
    const inp = inputs(mxRows([[100, 102, 100, 101.9], [101, 101.5, 98, 98.5]]), { triggers: [trig(30, "butn")], breakoutScreen: () => false });
    const { moves, activeAt } = detectMoves(inp, 1, { ...MOVE_PRIMARY, endStructure: false });
    expect(moves.filter((m) => m.endBar === 33 && m.endType === "mx_break")).toHaveLength(0);
    expect(activeAt[33]).not.toBeNull();
  });

  it("structure: a lower confirmed swing high, then a close below the last confirmed swing low", () => {
    const rows = flat(50);
    rows[38] = [100, 100.5, 99, 99]; // close 99 < swing low 99.4
    const pivots = [piv("high", 26, 104, 28), piv("low", 29, 99.4, 31), piv("high", 33, 103, 35)];
    const inp = inputs(rows, { pivots, triggers: [trig(25, "butn")], breakoutScreen: () => false });
    const { moves } = detectMoves(inp, 1, { ...MOVE_PRIMARY, endMx: "off" });
    expect(moves[0]).toMatchObject({ endType: "structure", endBar: 38 });
    // Same lows without the lower high: no structure end
    const higher = [piv("high", 26, 104, 28), piv("low", 29, 99.4, 31), piv("high", 33, 105, 35)];
    expect(detectMoves({ ...inp, pivots: higher }, 1, { ...MOVE_PRIMARY, endMx: "off" }).moves).toHaveLength(0);
  });

  it("failed breakout: a close back below the range low", () => {
    const rows = flat(32);
    rows[25] = [100, 102, 99.6, 101.8];
    rows[28] = [100, 100, 99, 99.3];
    const { moves } = detectMoves(inputs(rows), 1, { ...MOVE_PRIMARY, endMx: "off" });
    expect(moves[0]).toMatchObject({ startType: "breakout", endType: "failed_breakout", endBar: 28 });
  });
});

const mv = (endBar: number | null, size: number, extra: Partial<Move> = {}): Move => ({
  dir: 1, startType: "uturn", startBar: 0, knownAt: 0, anchor: 0, rangeEdge: null, atrStart: 1, extreme: size, endType: endBar == null ? null : "structure", endBar, size, legs: 2, pauses: [1], duration: 5, failed: size < 1, ...extra,
});

describe("profile", () => {
  it("failed starts (< 1 ATR) are counted but excluded; a move ending after D is excluded; < 3 moves → none", () => {
    const moves = [mv(100, 6), mv(150, 8), mv(180, 0.5), mv(190, 10), mv(260, 20), mv(null, 30)];
    expect(moveProfile(moves, 200)).toEqual({ n: 3, medianSize: 8, p75Size: 9, medianLegs: 2 });
    expect(moveProfile(moves, 170)).toBeNull(); // only 2 completed by then
    // Ends more than 750 sessions before D drop out
    expect(moveProfile(moves, 860)).toEqual({ n: 3, medianSize: 10, p75Size: 15, medianLegs: 2 });
    expect(summarizeMoves(moves)).toMatchObject({ moves: 5, failed: 1, open: 1 });
  });
});

describe("position and gate", () => {
  // Three completed moves of size 10 ATR (U-turn starts, brutn-on-volume ends), then an open one from bar 90
  function setup(extraPivots: Pivot[] = []) {
    const rows: Row[] = flat(130);
    for (const [s, e] of [[25, 35], [45, 55], [65, 75]]) {
      rows[s + 3] = [110, 120, 109, 119];
      rows[e] = [100, 101, 99, 99.6, 3e6];
    }
    const triggers = [25, 45, 65, 90].map((i) => trig(i, "butn")).concat([35, 55, 75].map((i) => trig(i, "brutn", -1)));
    const inp = inputs(rows, { triggers, pivots: extraPivots, breakoutScreen: () => false });
    return { inp, det: detectMoves(inp, 1, { ...MOVE_PRIMARY, endMx: "off", endStructure: false }) };
  }

  it("the profile comes from the completed moves; no active move → not a candidate", () => {
    const { inp, det } = setup();
    expect(det.moves.filter((m) => !m.failed)).toHaveLength(3);
    expect(det.moves[0].size).toBeCloseTo(10.25, 2); // (120 − 99.5) ÷ 2
    expect(movePosition(inp, det, 85, 1, 100, "inside")).toMatchObject({ active: false, pass: false });
    // Bar 70: the third move is active but only 2 have completed → no profile, no candidate
    expect(movePosition(inp, det, 70, 1, 100, "inside")).toMatchObject({ active: true, profile: null, pass: false });
  });

  it("pauses_so_far: confirmed swing highs inside the move before D, + 1 for a pause trigger below the move high (0/1/2/3)", () => {
    const highs = [piv("high", 92, 104, 94), piv("high", 96, 105, 98)];
    const rows = (d: number) => {
      const { inp, det } = setup(highs);
      (inp.bars as DailyBar[])[92] = { ...inp.bars[92], high: 104 };
      (inp.bars as DailyBar[])[96] = { ...inp.bars[96], high: 105 };
      return { inp, det, d };
    };
    let { inp, det } = rows(0);
    expect(movePosition(inp, det, 93, 1, 100.5, "mech1").pausesSoFar).toBe(1); // trigger below the move high (104)
    expect(movePosition(inp, det, 93, 1, 100.5, "egop").pausesSoFar).toBe(0); // not a pause trigger
    expect(movePosition(inp, det, 95, 1, 100.5, "egop").pausesSoFar).toBe(1); // high at 92 confirmed on 94
    expect(movePosition(inp, det, 99, 1, 100.5, "inside").pausesSoFar).toBe(3);
    ({ inp, det } = rows(0));
    const p2 = movePosition(inp, det, 95, 1, 100.5, "inside");
    expect(p2).toMatchObject({ pausesSoFar: 2, pass: true });
    expect(movePosition(inp, det, 99, 1, 100.5, "inside").pass).toBe(false); // 3 pauses
  });

  it("move_used at the 0.5 edge", () => {
    const { inp, det } = setup([piv("high", 92, 104, 94)]);
    (inp.bars as DailyBar[])[92] = { ...inp.bars[92], high: 104 };
    // Move from bar 90: no confirmed swing high before it, so the anchor is the 20-bar low (99, bar 75).
    // Profile: moves of 10.25, 10.5 and 10.5 ATR → median 10.5. move_used 0.5 at entry 99 + 0.5 × 10.5 × 2
    expect(movePosition(inp, det, 95, 1, 99 + 10.5, "inside")).toMatchObject({ pass: true, profile: { n: 3, medianSize: 10.5 } });
    expect(movePosition(inp, det, 95, 1, 99 + 10.5, "inside").moveUsed).toBeCloseTo(0.5, 9);
    expect(movePosition(inp, det, 95, 1, 99 + 10.6, "inside").pass).toBe(false);
  });

  it("no look-ahead: changing bars after D leaves the profile and position at D unchanged", () => {
    const { inp, det } = setup([piv("high", 92, 104, 94)]);
    const at = movePosition(inp, det, 95, 1, 101, "inside");
    const bars2 = inp.bars.map((b, k) => (k > 95 ? { ...b, close: 50, low: 40, high: 60, volume: 9e6 } : b));
    const trig2 = [...inp.triggers, trig(97, "brutn", -1)];
    const det2 = detectMoves({ ...inp, bars: bars2, triggers: trig2 }, 1, { ...MOVE_PRIMARY, endMx: "off", endStructure: false });
    expect(movePosition({ ...inp, bars: bars2 }, det2, 95, 1, 101, "inside")).toEqual(at);
  });
});

describe("short mirror", () => {
  it("brutn starts a short move, a butn on volume ends it; the anchor is the high since the last confirmed swing low", () => {
    const rows = flat(40);
    rows[22] = [100, 104, 99.5, 100];
    rows[34] = [100, 101, 99, 100.4, 2e6];
    const inp = inputs(rows, { pivots: [piv("low", 20, 99.5, 21)], triggers: [trig(25, "brutn", -1), trig(34, "butn")], breakoutScreen: () => false });
    const { moves } = detectMoves(inp, -1);
    expect(moves[0]).toMatchObject({ dir: -1, startType: "uturn", anchor: 104, endType: "uturn_volume", endBar: 34 });
    expect(detectMoves(inp, 1).moves).toHaveLength(0); // the long side ignores the brutn start
  });
});
