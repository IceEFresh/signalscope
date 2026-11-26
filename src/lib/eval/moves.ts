/**
 * P3-0k4: moves, not legs (docs/PHASE3-PREP.md §P3-0k4). Replaces the P3-0k3 room gate.
 * Provisional: set after the second P3-0k3 run (#100). Pure; every decision at bar t uses bars ≤ t.
 *
 * A move is a run of pushes and pauses in one direction. One move per direction is active at a
 * time; start signals during an active move are ignored. Long (shorts mirrored):
 * - start, the first of: (1) a confirmed k = 2 swing low above the previous confirmed swing low
 *   (start = the low's bar, known from its confirmation bar); (2) a butn trigger, rolling or
 *   calendar (start = the trigger bar); (3) a range breakout: close > the prior 20 sessions' high,
 *   that range (max high − min low) ≤ 3 × ATR14, and F25 or F22 passing that day.
 * - move low: the lowest low from the start bar back to the last confirmed swing high (a
 *   breakout: the range low).
 * - end, the first of (the bar it's known): (1) a brutn trigger on volume above its 20-session
 *   average; (2) a close below a level armed by mX or pmX (low − fudge on the bar the rule fired;
 *   a newer signal replaces it, a close at a new move high disarms it); (3) a lower confirmed swing
 *   high, then a close below the last confirmed swing low; (4) for a breakout start, a close back
 *   below the range low.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { sma } from "@/lib/harvester/universe/bar-features";
import { htfOpensAt } from "@/lib/harvester/universe/stp";
import type { Pivot } from "@/lib/harvester/universe/swings";
import { barFudge, type Dir } from "./stp-sim";

export type MoveStartType = "swing" | "uturn" | "breakout";
export type MoveEndType = "uturn_volume" | "mx_break" | "structure" | "failed_breakout";

export const RANGE_SESSIONS = 20;
export const RANGE_ATR = 3;
export const VOLUME_SESSIONS = 20;
export const PROFILE_MOVE_SESSIONS = 750;
export const MIN_PROFILE_MOVES = 3;
/** A completed move under this many ATR is a failed start: counted, never in the profile. */
export const FAILED_START_ATR = 1;
export const GATE_PAUSES = [1, 2] as const;
export const GATE_MOVE_USED = 0.5;

export interface MoveOptions {
  /** Max 20-session range for a breakout, in ATR14. */
  rangeAtr: number;
  /** Require F25/F22 (shorts F08/F13) on the breakout bar. */
  breakoutFilter: boolean;
  /** End on an opposite U-turn: with volume > 20-session average (primary), on any volume, or never. */
  endUturn: "volume" | "any" | "off";
  /** mX/pmX: arm a level and end on its break (primary), end when the rule fires, or never. */
  endMx: "arm" | "fire" | "off";
  endStructure: boolean;
  endFailedBreakout: boolean;
}

export const MOVE_PRIMARY: MoveOptions = { rangeAtr: RANGE_ATR, breakoutFilter: true, endUturn: "volume", endMx: "arm", endStructure: true, endFailedBreakout: true };

/** Descriptive variants (§P3-0k4 items 3 and 4). */
export const MOVE_VARIANTS: Record<string, MoveOptions> = {
  primary: MOVE_PRIMARY,
  "mX/pmX firing ends": { ...MOVE_PRIMARY, endMx: "fire" },
  "U-turn without volume": { ...MOVE_PRIMARY, endUturn: "any" },
  "structure only": { ...MOVE_PRIMARY, endUturn: "off", endMx: "off", endFailedBreakout: false },
  "range 2 ATR": { ...MOVE_PRIMARY, rangeAtr: 2 },
  "range 4 ATR": { ...MOVE_PRIMARY, rangeAtr: 4 },
  "breakout without Finviz": { ...MOVE_PRIMARY, breakoutFilter: false },
};

export interface MoveTrigger {
  i: number;
  dir: Dir;
  type: string;
}

export interface MoveInputs {
  bars: readonly DailyBar[];
  /** k = 2 zigzag pivots. */
  pivots: readonly Pivot[];
  atr: ReadonlyArray<number | null>;
  /** STP triggers, calendar and rolling (butn/brutn used here). */
  triggers: readonly MoveTrigger[];
  /** F25 or F22 (long) / F08 or F13 (short) passing on bar i. */
  breakoutScreen: (i: number, dir: Dir) => boolean;
}

export interface Move {
  dir: Dir;
  startType: MoveStartType;
  startBar: number;
  /** The bar the start is known (a swing low's confirmation bar; else the start bar). */
  knownAt: number;
  /** The move low (long) / high (short) gains are measured from. */
  anchor: number;
  /** Breakout starts: the range low (long) / high (short). */
  rangeEdge: number | null;
  atrStart: number;
  /** The move's extreme so far (high for longs). */
  extreme: number;
  endType: MoveEndType | null;
  /** The bar the end is known; null while open. */
  endBar: number | null;
  /** (extreme − anchor) ÷ ATR14 at the start. */
  size: number;
  /** Pushes: confirmed pauses inside the move + 1. */
  legs: number;
  /** Depth of each pause (confirmed swing high → next confirmed swing low inside the move), ATR. */
  pauses: number[];
  duration: number;
  failed: boolean;
}

const crossesBelow = (p: number | null, pl: number | null, c: number | null, cl: number | null) => p != null && pl != null && c != null && cl != null && p >= pl && c < cl;
const crossesAbove = (p: number | null, pl: number | null, c: number | null, cl: number | null) => p != null && pl != null && c != null && cl != null && p <= pl && c > cl;

/** mX (close × sma20, or sma10 × sma20) or pmX (trend[t−1] ≥ 1 and close × sma10) against the move on bar t. */
export function mxPmxFires(bars: readonly DailyBar[], closes: readonly number[], t: number, dir: Dir): boolean {
  if (t < 1) return false;
  const below = dir === 1 ? crossesBelow : crossesAbove;
  const s10 = sma(closes, 10, t);
  const s20 = sma(closes, 20, t);
  const s10p = sma(closes, 10, t - 1);
  const s20p = sma(closes, 20, t - 1);
  if (below(closes[t - 1], s20p, closes[t], s20) || below(s10p, s20p, s10, s20)) return true;
  const td = htfOpensAt(bars, t - 1);
  return td != null && dir * td >= 1 && below(closes[t - 1], s10p, closes[t], s10);
}

const avgVolume = (bars: readonly DailyBar[], t: number, n = VOLUME_SESSIONS): number | null => {
  if (t < n) return null;
  let s = 0;
  for (let k = t - n; k < t; k++) s += bars[k].volume ?? 0;
  return s / n;
};

/** Every move in one direction, plus the move active after each bar (null = none). */
export function detectMoves(inp: MoveInputs, dir: Dir, opts: MoveOptions = MOVE_PRIMARY): { moves: Move[]; activeAt: Array<Move | null> } {
  const { bars, pivots, atr } = inp;
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const hi = (k: number) => (dir === 1 ? bars[k].high : bars[k].low); // the move's direction
  const lo = (k: number) => (dir === 1 ? bars[k].low : bars[k].high); // against it
  const better = (a: number, b: number) => dir * (a - b) > 0;
  const startKind = dir === 1 ? "low" : "high";
  const endKind = dir === 1 ? "high" : "low";
  const confirmedOn = new Map<number, Pivot[]>();
  for (const p of pivots) (confirmedOn.get(p.confirmedAt) ?? confirmedOn.set(p.confirmedAt, []).get(p.confirmedAt)!).push(p);
  const triggersOn = new Map<number, MoveTrigger[]>();
  for (const s of inp.triggers) (triggersOn.get(s.i) ?? triggersOn.set(s.i, []).get(s.i)!).push(s);
  const startUturn = dir === 1 ? "butn" : "brutn";
  const endUturn = dir === 1 ? "brutn" : "butn";

  const moves: Move[] = [];
  const activeAt: Array<Move | null> = new Array(n).fill(null);
  let lastStartPivot: Pivot | null = null; // last confirmed swing low (long)
  let lastEndPivot: Pivot | null = null; // last confirmed swing high (long)
  let m: Move | null = null;
  let armed: number | null = null;
  let lowerEnd = false; // a lower confirmed swing high inside the move (long)
  let prevEndPivotInMove: Pivot | null = null;

  const finish = (t: number, type: MoveEndType) => {
    const mv = m!;
    mv.endType = type;
    mv.endBar = t;
    mv.duration = t - mv.startBar;
    // Pauses: a confirmed swing high, then the next confirmed swing low, both inside the move and known by t
    const inside = pivots.filter((p) => p.i >= mv.startBar && p.confirmedAt <= t).sort((a, b) => a.i - b.i);
    mv.pauses = [];
    for (let k = 0; k < inside.length - 1; k++)
      if (inside[k].kind === endKind && inside[k + 1].kind === startKind) mv.pauses.push(Math.abs(inside[k].price - inside[k + 1].price) / mv.atrStart);
    mv.legs = mv.pauses.length + 1;
    mv.size = (dir * (mv.extreme - mv.anchor)) / mv.atrStart;
    mv.failed = mv.size < FAILED_START_ATR;
    moves.push(mv);
    m = null;
    armed = null;
  };

  for (let t = 0; t < n; t++) {
    const newPivots = confirmedOn.get(t) ?? [];
    if (m) {
      const mv = m as Move;
      const prevExtreme = mv.extreme;
      if (better(hi(t), mv.extreme)) mv.extreme = hi(t);
      // Structure: a lower swing high confirmed inside the move
      for (const p of newPivots)
        if (p.kind === endKind && p.i >= mv.startBar) {
          if (prevEndPivotInMove ? better(prevEndPivotInMove.price, p.price) : lastEndPivot != null && better(lastEndPivot.price, p.price)) lowerEnd = true;
          prevEndPivotInMove = p;
        }
      let end: MoveEndType | null = null;
      if (opts.endUturn !== "off" && (triggersOn.get(t) ?? []).some((s) => s.type === endUturn && s.dir === -dir)) {
        const av = avgVolume(bars, t);
        if (opts.endUturn === "any" || (av != null && (bars[t].volume ?? 0) > av)) end = "uturn_volume";
      }
      if (!end && opts.endMx === "arm" && armed != null && dir * (closes[t] - armed) < 0) end = "mx_break";
      if (!end && opts.endMx === "fire" && mxPmxFires(bars, closes, t, dir)) end = "mx_break";
      const lastStart = newPivots.filter((p) => p.kind === startKind).at(-1) ?? lastStartPivot;
      if (!end && opts.endStructure && lowerEnd && lastStart && dir * (closes[t] - lastStart.price) < 0) end = "structure";
      if (!end && opts.endFailedBreakout && mv.startType === "breakout" && mv.rangeEdge != null && dir * (closes[t] - mv.rangeEdge) < 0) end = "failed_breakout";
      if (end) finish(t, end);
      else if (opts.endMx === "arm") {
        if (better(closes[t], prevExtreme)) armed = null; // a close at a new move high disarms
        if (mxPmxFires(bars, closes, t, dir)) armed = lo(t) - dir * (barFudge(atr[t]) ?? 0.02); // applies from t + 1
      }
    } else {
      // Starts, in priority order
      let start: { type: MoveStartType; bar: number; rangeEdge: number | null } | null = null;
      for (const p of newPivots)
        if (p.kind === startKind && lastStartPivot && better(p.price, lastStartPivot.price)) start = { type: "swing", bar: p.i, rangeEdge: null };
      if (!start && (triggersOn.get(t) ?? []).some((s) => s.type === startUturn && s.dir === dir)) start = { type: "uturn", bar: t, rangeEdge: null };
      if (!start && t >= RANGE_SESSIONS && atr[t] != null) {
        let rHi = -Infinity;
        let rLo = Infinity;
        for (let k = t - RANGE_SESSIONS; k < t; k++) {
          rHi = Math.max(rHi, bars[k].high);
          rLo = Math.min(rLo, bars[k].low);
        }
        const edgeBreak = dir === 1 ? closes[t] > rHi : closes[t] < rLo;
        if (edgeBreak && rHi - rLo <= opts.rangeAtr * atr[t]! && (!opts.breakoutFilter || inp.breakoutScreen(t, dir))) start = { type: "breakout", bar: t, rangeEdge: dir === 1 ? rLo : rHi };
      }
      if (start) {
        let anchor: number;
        if (start.rangeEdge != null) anchor = start.rangeEdge;
        else {
          const endP = [...pivots].reverse().find((p) => p.kind === endKind && p.confirmedAt <= t && p.i < start!.bar);
          const from = endP ? endP.i : Math.max(0, start.bar - RANGE_SESSIONS);
          anchor = lo(from);
          for (let k = from; k <= start.bar; k++) if (better(anchor, lo(k))) anchor = lo(k);
        }
        let extreme = hi(start.bar);
        for (let k = start.bar; k <= t; k++) if (better(hi(k), extreme)) extreme = hi(k);
        const a = atr[start.bar] ?? atr[t];
        if (a != null && a > 0) {
          m = { dir, startType: start.type, startBar: start.bar, knownAt: t, anchor, rangeEdge: start.rangeEdge, atrStart: a, extreme, endType: null, endBar: null, size: 0, legs: 1, pauses: [], duration: 0, failed: false };
          armed = null;
          lowerEnd = false;
          prevEndPivotInMove = null;
        }
      }
    }
    for (const p of newPivots) {
      if (p.kind === startKind) lastStartPivot = p;
      else lastEndPivot = p;
    }
    activeAt[t] = m;
  }
  return { moves, activeAt };
}

// ── Profile and position ─────────────────────────────────────────────────────────

const quantile = (xs: readonly number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};

export interface MoveProfile {
  n: number;
  medianSize: number;
  p75Size: number;
  medianLegs: number;
}

/**
 * The stock's completed moves whose end is known by D, ending within the last 750 sessions, failed
 * starts excluded; null with fewer than 3. Open moves never enter (look-ahead).
 */
export function moveProfile(moves: readonly Move[], d: number): MoveProfile | null {
  const done = moves.filter((m) => m.endBar != null && m.endBar <= d && m.endBar > d - PROFILE_MOVE_SESSIONS && !m.failed);
  if (done.length < MIN_PROFILE_MOVES) return null;
  return { n: done.length, medianSize: quantile(done.map((m) => m.size), 0.5)!, p75Size: quantile(done.map((m) => m.size), 0.75)!, medianLegs: quantile(done.map((m) => m.legs), 0.5)! };
}

/** Trigger types counted as a pause (an inside day or a pullback) when below the move high. */
export const pauseTrigger = (type: string, dir: Dir) => type === "inside" || type === "mech1" || type === "mech2" || type === (dir === 1 ? "butn" : "brutn");

export interface MovePosition {
  active: boolean;
  startType: MoveStartType | null;
  /** Confirmed swing highs inside the move before the trigger bar, + 1 for a pause trigger below the move high. */
  pausesSoFar: number | null;
  /** (entry − move low) ÷ ATR14(D) ÷ median move size. */
  moveUsed: number | null;
  profile: MoveProfile | null;
  pass: boolean;
}

/** The move active at D and where the entry sits in it, with the P3-0k4 gate. */
export function movePosition(
  inp: Pick<MoveInputs, "bars" | "pivots" | "atr">,
  detected: { moves: readonly Move[]; activeAt: ReadonlyArray<Move | null> },
  d: number,
  dir: Dir,
  entry: number,
  triggerType: string,
): MovePosition {
  const profile = moveProfile(detected.moves, d);
  const m = detected.activeAt[d];
  if (!m) return { active: false, startType: null, pausesSoFar: null, moveUsed: null, profile, pass: false };
  const endKind = dir === 1 ? "high" : "low";
  let pauses = inp.pivots.filter((p) => p.kind === endKind && p.i >= m.startBar && p.confirmedAt < d).length;
  if (pauseTrigger(triggerType, dir) && d > m.startBar) {
    let before = dir === 1 ? -Infinity : Infinity;
    for (let k = m.startBar; k < d; k++) before = dir === 1 ? Math.max(before, inp.bars[k].high) : Math.min(before, inp.bars[k].low);
    if (dir === 1 ? inp.bars[d].high < before : inp.bars[d].low > before) pauses++;
  }
  const a = inp.atr[d];
  const moveUsed = profile && a != null && a > 0 && profile.medianSize > 0 ? (dir * (entry - m.anchor)) / a / profile.medianSize : null;
  const pass = profile != null && moveUsed != null && (GATE_PAUSES as readonly number[]).includes(pauses) && moveUsed <= GATE_MOVE_USED + 1e-12;
  return { active: true, startType: m.startType, pausesSoFar: pauses, moveUsed, profile, pass };
}

// ── Descriptive summaries ────────────────────────────────────────────────────────

export interface MoveSummary {
  moves: number;
  failed: number;
  open: number;
  medianSize: number | null;
  p75Size: number | null;
  medianLegs: number | null;
  meanLegs: number | null;
  medianDuration: number | null;
  medianPauseDepth: number | null;
  startMix: Record<MoveStartType, number>;
  endMix: Record<MoveEndType, number>;
  failedByStart: Record<MoveStartType, { n: number; failed: number }>;
}

export function summarizeMoves(moves: readonly Move[]): MoveSummary {
  const done = moves.filter((m) => m.endBar != null);
  const ok = done.filter((m) => !m.failed);
  const startMix: Record<MoveStartType, number> = { swing: 0, uturn: 0, breakout: 0 };
  const endMix: Record<MoveEndType, number> = { uturn_volume: 0, mx_break: 0, structure: 0, failed_breakout: 0 };
  const failedByStart: MoveSummary["failedByStart"] = { swing: { n: 0, failed: 0 }, uturn: { n: 0, failed: 0 }, breakout: { n: 0, failed: 0 } };
  for (const m of done) {
    startMix[m.startType]++;
    if (m.endType) endMix[m.endType]++;
    failedByStart[m.startType].n++;
    if (m.failed) failedByStart[m.startType].failed++;
  }
  const legs = ok.map((m) => m.legs);
  return {
    moves: done.length,
    failed: done.length - ok.length,
    open: moves.length - done.length,
    medianSize: quantile(ok.map((m) => m.size), 0.5),
    p75Size: quantile(ok.map((m) => m.size), 0.75),
    medianLegs: quantile(legs, 0.5),
    meanLegs: legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : null,
    medianDuration: quantile(ok.map((m) => m.duration), 0.5),
    medianPauseDepth: quantile(ok.flatMap((m) => m.pauses), 0.5),
    startMix,
    endMix,
    failedByStart,
  };
}
