/**
 * Universe-wide daily snapshot, docs/PHASE3-PREP.md P3-0c. LOG ONLY.
 *
 * One row per universe member (plus SPY, the benchmark) from data this run already
 * has: the per-run chart cache (volume spike and STP fetched every universe chart)
 * and the STP states. Never makes a network request: a symbol whose chart isn't
 * cached is left out. Sector features (1f, P3-0d) use each member's sector and
 * industry from the weekly universe build plus this run's sector rotation; a member
 * with no stored profile gets null sector features.
 */
import { peekDailyChart } from "../yahoo-chart";
import { parseChartBars, type DailyBar } from "./bar-metrics";
import { computeBarFeatures } from "./bar-features";
import type { StpResult } from "./stp";
import { normalizeIndustry, tickerSectorFeatures, type SectorRotation } from "./sector-rotation";

export interface SectorContext {
  sector: string | null;
  industry: string | null;
  rotation: SectorRotation | null;
  /** Universe members with the same (normalized) industry. */
  industryCount: number | null;
}

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_BATCH = 500;
export const BENCHMARK_SYMBOL = "SPY";

export interface SnapshotRow {
  symbol: string;
  sessionDate: string;
  close: number;
  features: Record<string, unknown>;
  /** P3-0e: "crypto" for crypto rows; omitted = stock. */
  assetClass?: "stock" | "crypto";
}

/** One snapshot row from a symbol's completed bars and its STP states (pure). Null without a dated last bar. */
export function snapshotRow(
  symbol: string,
  bars: readonly DailyBar[],
  spyBars: readonly DailyBar[] | null,
  stp: StpResult | undefined,
  sector?: SectorContext,
): SnapshotRow | null {
  if (bars.length === 0) return null;
  const f = computeBarFeatures(bars, spyBars) as unknown as Record<string, unknown>;
  const sessionDate = typeof f.bar_date === "string" ? f.bar_date : null;
  const close = typeof f.close === "number" && Number.isFinite(f.close) ? f.close : null;
  if (!sessionDate || close == null) return null;
  return {
    symbol,
    sessionDate,
    close,
    features: {
      snapshot_version: SNAPSHOT_VERSION,
      ...f,
      // STP states only (the trigger and trade levels stay in StpSignal), and only for the same bar
      stp_ma_state: stp && stp.barDate === sessionDate ? stp.maState : null,
      stp_well_bid: stp && stp.barDate === sessionDate ? stp.wellBid : null,
      stp_size_factor: stp && stp.barDate === sessionDate ? stp.sizeFactor : null,
      // Sector features (1f) from the weekly profile; all null when the member has none
      ...(sector
        ? tickerSectorFeatures(sector.sector, sector.industry, f.return_20d as number | null | undefined, sector.rotation, sector.industryCount)
        : {}),
    },
  };
}

/** Snapshot rows for `symbols` plus SPY, from cached charts only. */
export async function computeSnapshotRows(
  symbols: readonly string[],
  stp: Record<string, StpResult>,
  peek: (s: string) => ReturnType<typeof peekDailyChart> = peekDailyChart,
  sectorInput?: { profiles: Record<string, { sector: string | null; industry: string | null }>; rotation: SectorRotation | null },
): Promise<{ rows: SnapshotRow[]; missing: number }> {
  const industryCounts = new Map<string, number>();
  for (const p of Object.values(sectorInput?.profiles ?? {})) {
    if (p.industry) {
      const k = normalizeIndustry(p.industry);
      industryCounts.set(k, (industryCounts.get(k) ?? 0) + 1);
    }
  }
  const sectorFor = (s: string): SectorContext | undefined => {
    if (!sectorInput || s === BENCHMARK_SYMBOL) return undefined;
    const p = sectorInput.profiles[s];
    return {
      sector: p?.sector ?? null,
      industry: p?.industry ?? null,
      rotation: sectorInput.rotation,
      industryCount: p?.industry ? industryCounts.get(normalizeIndustry(p.industry)) ?? null : null,
    };
  };
  const load = async (s: string): Promise<DailyBar[] | null> => {
    const p = peek(s);
    if (!p) return null;
    try {
      const res = await p;
      return res.ok ? parseChartBars(res.json) : null;
    } catch {
      return null;
    }
  };
  const spyBars = await load(BENCHMARK_SYMBOL);
  const rows: SnapshotRow[] = [];
  let missing = 0;
  for (const s of [...new Set([...symbols, BENCHMARK_SYMBOL])]) {
    const bars = s === BENCHMARK_SYMBOL ? spyBars : await load(s);
    const row = bars ? snapshotRow(s, bars, spyBars, stp[s], sectorFor(s)) : null;
    if (row) rows.push(row);
    else missing++;
  }
  return { rows, missing };
}

export function chunk<T>(items: readonly T[], size = SNAPSHOT_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
