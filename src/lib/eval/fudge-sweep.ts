/**
 * P3-0k2 descriptive: STP fudge sweep (Chris, 2026-11-25). No verdicts.
 *
 * The STP entry and stop sit one "fudge" beyond the trigger bar: entry = high + fudge, stop =
 * low − fudge (short mirrored), fudge = max(0.11 × ATR14, $0.02). The sweep replays the same
 * triggers with fudge at 11%, 17%, 19% and 23% of ATR ($0.02 floor):
 * - "both": the swept fudge on entry and stop;
 * - "stop-only": entry at 11%, stop at the swept value.
 * Everything else is unchanged: the trigger set, the size rule, exit B management, and the
 * trailing stops' per-bar fudge (11%). One position per ticker per variant.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { atrSeries, entryOnNextBar, initialShares, simulateExit, stoppedEarly, type Dir, type ExitExtras, type Setup } from "./stp-sim";

export const FUDGE_FLOOR = 0.02;
export const BASE_FUDGE_PCT = 0.11;
export const SWEEP_PCTS = [0.11, 0.17, 0.19, 0.23] as const;

export interface FudgeVariant {
  id: string;
  entryPct: number;
  stopPct: number;
}

export const FUDGE_VARIANTS: readonly FudgeVariant[] = [
  ...SWEEP_PCTS.map((p) => ({ id: `both ${Math.round(p * 100)}%`, entryPct: p, stopPct: p })),
  ...SWEEP_PCTS.filter((p) => p !== BASE_FUDGE_PCT).map((p) => ({ id: `stop-only ${Math.round(p * 100)}%`, entryPct: BASE_FUDGE_PCT, stopPct: p })),
];

export const fudgeAt = (atr: number, pct: number) => Math.max(pct * atr, FUDGE_FLOOR);

/**
 * The trigger's ATR14: recovered from its 11% fudge when above the floor (exactly computeStp's
 * own ATR), else the full-series ATR at the trigger bar.
 */
export const setupAtr = (s: Setup, seriesAtr: number | null) => (s.fudge > FUDGE_FLOOR + 1e-12 ? s.fudge / BASE_FUDGE_PCT : seriesAtr);

/** Entry and stop for a variant: the trigger bar's high/low (from the 11% levels) plus the swept fudges. */
export function sweptLevels(s: Setup, atr: number, v: FudgeVariant): { entry: number; stop: number } {
  const d: Dir = s.dir;
  const edgeEntry = s.entry - d * s.fudge; // high (long) / low (short)
  const edgeStop = s.stop + d * s.fudge; // low (long) / high (short)
  return { entry: edgeEntry + d * fudgeAt(atr, v.entryPct), stop: edgeStop - d * fudgeAt(atr, v.stopPct) };
}

export interface SweepOutcome {
  scanId: string;
  dir: Dir;
  filled: boolean;
  /** Present when the fill was traded (≥ 1 share). */
  netR?: number;
  stoppedEarly?: boolean;
}

/** One symbol, one variant: every setup in order, one position at a time. */
export function sweepSymbol(
  bars: readonly DailyBar[],
  setups: readonly Setup[],
  v: FudgeVariant,
  opts: { baseRisk: (s: Setup) => number; extras?: (f: number) => ExitExtras },
): SweepOutcome[] {
  const closes = bars.map((b) => b.close);
  const atr = atrSeries(bars);
  const out: SweepOutcome[] = [];
  let openUntil = -1;
  for (const s of setups) {
    if (s.i < openUntil) continue;
    const a = setupAtr(s, atr[s.i]);
    const scanId = barDateOf(bars[s.i]) ?? s.date;
    if (a == null) continue;
    const { entry, stop } = sweptLevels(s, a, v);
    const e = entryOnNextBar(bars[s.i + 1], s.dir, entry, stop);
    if (e.status === "no_bar") continue;
    if (e.status !== "filled") {
      out.push({ scanId, dir: s.dir, filled: false });
      continue;
    }
    const baseRisk = opts.baseRisk(s);
    if (initialShares(baseRisk, e.risk) < 1) {
      out.push({ scanId, dir: s.dir, filled: true });
      continue;
    }
    // Trailing stops keep the 11% per-bar fudge: the trigger's own fudge is only their fallback
    const x = simulateExit(bars, closes, atr, s.i + 1, s.dir, e.fill, e.risk, stop, s.fudge, s.type, "B", baseRisk, opts.extras?.(s.i + 1));
    openUntil = x.exitIndex;
    out.push({ scanId, dir: s.dir, filled: true, netR: x.netR, stoppedEarly: stoppedEarly(x) });
  }
  return out;
}

export interface SweepRow {
  variant: string;
  attempts: number;
  fillRate: number | null;
  trades: number;
  winRate: number | null;
  expTrain: number | null;
  expHeld: number | null;
  stoppedEarlyShare: number | null;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** The held-out cut: the newest 30% of trigger dates (the same cut for every variant of a population). */
export function heldOutFrom(scanIds: readonly string[], testFraction = 0.3): string | null {
  const dates = [...new Set(scanIds)].sort();
  if (!dates.length) return null;
  return dates[Math.floor(dates.length * (1 - testFraction))] ?? null;
}

export function sweepRow(variant: string, outcomes: readonly SweepOutcome[], heldFrom: string | null): SweepRow {
  const traded = outcomes.filter((o) => o.netR != null);
  const held = (o: SweepOutcome) => heldFrom != null && o.scanId >= heldFrom;
  return {
    variant,
    attempts: outcomes.length,
    fillRate: outcomes.length ? outcomes.filter((o) => o.filled).length / outcomes.length : null,
    trades: traded.length,
    winRate: traded.length ? traded.filter((o) => o.netR! > 0).length / traded.length : null,
    expTrain: mean(traded.filter((o) => !held(o)).map((o) => o.netR!)),
    expHeld: mean(traded.filter(held).map((o) => o.netR!)),
    stoppedEarlyShare: traded.length ? traded.filter((o) => o.stoppedEarly).length / traded.length : null,
  };
}

const r3 = (v: number | null) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

export function sweepTable(title: string, rows: readonly SweepRow[], heldFrom: string | null): string[] {
  return [
    `**${title}** (held out: triggers from ${heldFrom ?? "n/a"})`,
    "",
    "| variant | setups | fill rate | trades | win rate | net exp R (training) | net exp R (held out) | stopped within 3 sessions |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.variant} | ${r.attempts} | ${pct(r.fillRate)} | ${r.trades} | ${pct(r.winRate)} | ${r3(r.expTrain)} | ${r3(r.expHeld)} | ${pct(r.stoppedEarlyShare)} |`),
    "",
  ];
}
