/**
 * The Stock Market Power Pyramid (docs/PHASE3-PREP.md P3-0i §1g, Chris 2026-11-25). Pure.
 *
 * Layers above the stock (market: SPY, QQQ, DIA; sector SPDR; industry ETF) set the
 * position size. A layer's state on day D uses that ETF's completed bars dated ≤ D:
 * - opens: stp_htf_opens (close vs the calendar weekly and monthly opens);
 * - trend: up = close > sma50 and sma20 > sma50; down = the mirror; else neutral.
 * For a long, a layer AGREES when opens = +1 and trend is up, DISAGREES when opens = −1
 * and trend is down, and is MIXED otherwise (mixed is not a disagreement). Shorts mirror.
 * Opens-only and trend-only variants are kept for the descriptive reports.
 *
 * Size rule (reviewer's assumption, Chris may correct): market and sector layers; 0
 * disagreeing → 1.0, 1 → 0.5, 2 → 0.25. A layer with no data (ETF missing on D, unmapped
 * sector) is treated as mixed and counted. The industry-included variant halves the size
 * per disagreeing layer of the three.
 */
import { etParts, type DailyBar } from "./bar-metrics";
import { sma } from "./bar-features";
import { htfOpensAt } from "./stp";

export const MARKET_ETFS = ["SPY", "QQQ", "DIA"] as const;

export type LayerState = "agree" | "mixed" | "disagree";
export type LayerMode = "both" | "opens" | "trend";

export interface EtfState {
  opens: number | null;
  trend: 1 | -1 | 0 | null;
}

/** State of an ETF on every date it has a bar, each from bars dated ≤ that date. */
export function etfStates(bars: readonly DailyBar[]): Map<string, EtfState> {
  const closes = bars.map((b) => b.close);
  const out = new Map<string, EtfState>();
  bars.forEach((b, i) => {
    if (b.time == null) return;
    const s20 = sma(closes, 20, i);
    const s50 = sma(closes, 50, i);
    const trend = s20 == null || s50 == null ? null : b.close > s50 && s20 > s50 ? 1 : b.close < s50 && s20 < s50 ? -1 : 0;
    out.set(etParts(new Date(b.time * 1000)).date, { opens: htfOpensAt(bars, i), trend });
  });
  return out;
}

/** One layer's state for a trade direction; null when the ETF has no state that day. */
export function layerState(st: EtfState | null | undefined, dir: 1 | -1, mode: LayerMode = "both"): LayerState | null {
  if (!st) return null;
  const opens = st.opens == null ? null : st.opens * dir >= 1 ? 1 : st.opens * dir <= -1 ? -1 : 0;
  const trend = st.trend == null ? null : st.trend * dir;
  if (mode === "opens") return opens == null ? null : opens === 1 ? "agree" : opens === -1 ? "disagree" : "mixed";
  if (mode === "trend") return trend == null ? null : trend === 1 ? "agree" : trend === -1 ? "disagree" : "mixed";
  if (opens == null || trend == null) return null;
  if (opens === 1 && trend === 1) return "agree";
  if (opens === -1 && trend === -1) return "disagree";
  return "mixed";
}

/** Market layer: agree or disagree when at least 2 of the 3 indices do; else mixed; null if all three are null. */
export function marketVote(states: ReadonlyArray<LayerState | null>): LayerState | null {
  if (states.every((s) => s == null)) return null;
  if (states.filter((s) => s === "agree").length >= 2) return "agree";
  if (states.filter((s) => s === "disagree").length >= 2) return "disagree";
  return "mixed";
}

const halvings = (layers: ReadonlyArray<LayerState | null>) => layers.filter((l) => l === "disagree").length;

/** Size multiplier from the market and sector layers: 1, 0.5 or 0.25. Null layers count as mixed. */
export function sizeMult(market: LayerState | null, sector: LayerState | null): number {
  return 0.5 ** halvings([market, sector]);
}

/** Descriptive variant: halve per disagreeing layer of market, sector and industry. */
export function sizeMultWithIndustry(market: LayerState | null, sector: LayerState | null, industry: LayerState | null): number {
  return 0.5 ** halvings([market, sector, industry]);
}

export interface PyramidInputs {
  market: ReadonlyArray<ReadonlyMap<string, EtfState> | null>; // SPY, QQQ, DIA
  sector: ReadonlyMap<string, EtfState> | null;
  industry: ReadonlyMap<string, EtfState> | null;
}

export interface PyramidLayers {
  market: LayerState | null;
  sector: LayerState | null;
  industry: LayerState | null;
  sizeMult: number;
  sizeMultIndustry: number;
  sizeMultOpens: number;
  sizeMultTrend: number;
}

/** All layer states and size multipliers for a trade triggered on `date` in direction `dir`. */
export function pyramidLayers(inputs: PyramidInputs, date: string, dir: 1 | -1): PyramidLayers {
  const at = (m: ReadonlyMap<string, EtfState> | null, mode: LayerMode) => layerState(m?.get(date), dir, mode);
  const market = (mode: LayerMode) => marketVote(inputs.market.map((m) => at(m, mode)));
  const m = market("both");
  const s = at(inputs.sector, "both");
  const ind = at(inputs.industry, "both");
  return {
    market: m,
    sector: s,
    industry: ind,
    sizeMult: sizeMult(m, s),
    sizeMultIndustry: sizeMultWithIndustry(m, s, ind),
    sizeMultOpens: sizeMult(market("opens"), at(inputs.sector, "opens")),
    sizeMultTrend: sizeMult(market("trend"), at(inputs.sector, "trend")),
  };
}
