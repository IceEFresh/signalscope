/**
 * Sector and industry rotation, PLAN.md PR 1f (BOOK-IMPROVEMENTS row #8, plus
 * Chris's "STP Sector Rotation" period-open returns). LOG ONLY: stored on
 * Scan.sectorRotation and in ValidatedTicker.features; nothing scores on it.
 *
 * All values come from completed daily bars of the 11 SPDR sector ETFs and a
 * hand-built set of industry ETFs, aligned with SPY by date. Missing data is
 * null, never 0.
 */
import type { DailyBar } from "./bar-metrics";
import { computeBarFeatures } from "./bar-features";

export const SECTOR_ROTATION_VERSION = 1;

/** Yahoo `assetProfile.sector` → SPDR sector ETF. */
export const SECTOR_ETFS: Record<string, string> = {
  Technology: "XLK",
  "Financial Services": "XLF",
  Healthcare: "XLV",
  "Consumer Cyclical": "XLY",
  "Consumer Defensive": "XLP",
  Energy: "XLE",
  Industrials: "XLI",
  "Basic Materials": "XLB",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  "Communication Services": "XLC",
};

/**
 * Yahoo `assetProfile.industry` → industry ETF. [Guessing] hand-built mapping;
 * an industry not listed gets null industry fields (it falls back to sector only).
 */
export const INDUSTRY_ETFS: Record<string, string> = {
  Semiconductors: "SMH",
  "Semiconductor Equipment & Materials": "SMH",
  "Software—Application": "IGV",
  "Software—Infrastructure": "IGV",
  "Information Technology Services": "IGV",
  Biotechnology: "XBI",
  "Drug Manufacturers—Specialty & Generic": "XPH",
  "Drug Manufacturers—General": "XPH",
  "Medical Devices": "IHI",
  "Medical Instruments & Supplies": "IHI",
  "Healthcare Plans": "IHF",
  "Medical Care Facilities": "IHF",
  "Banks—Regional": "KRE",
  "Banks—Diversified": "KBE",
  "Capital Markets": "IAI",
  "Insurance—Property & Casualty": "KIE",
  "Insurance—Life": "KIE",
  "Insurance—Diversified": "KIE",
  "Oil & Gas E&P": "XOP",
  "Oil & Gas Integrated": "XOP",
  "Oil & Gas Equipment & Services": "OIH",
  "Oil & Gas Refining & Marketing": "CRAK",
  "Residential Construction": "ITB",
  "Specialty Retail": "XRT",
  "Apparel Retail": "XRT",
  "Internet Retail": "XRT",
  "Department Stores": "XRT",
  Airlines: "JETS",
  "Aerospace & Defense": "ITA",
  Trucking: "IYT",
  Railroads: "IYT",
  "Integrated Freight & Logistics": "IYT",
  Steel: "XME",
  "Other Industrial Metals & Mining": "XME",
  Copper: "COPX",
  Gold: "GDX",
  Silver: "SIL",
  Uranium: "URA",
  Solar: "TAN",
  "Internet Content & Information": "FDN",
  "Electronic Gaming & Multimedia": "ESPO",
  "Resorts & Casinos": "PEJ",
  "Travel Services": "PEJ",
  Lodging: "PEJ",
  "Auto Manufacturers": "CARZ",
  "REIT—Residential": "REZ",
  "Utilities—Renewable": "ICLN",
};

export const ROTATION_ETFS: string[] = [...new Set([...Object.values(SECTOR_ETFS), ...Object.values(INDUSTRY_ETFS)])];

export interface EtfStats {
  return_20d: number | null;
  return_60d: number | null;
  rs_vs_spy_20d: number | null; // 20-bar return minus SPY's over the same dates
  rs_vs_spy_60d: number | null;
  rs_vs_spy_20d_4w_ago: number | null; // the same measure ending 20 bars earlier
  wtd: number | null; // close / first-session open of the week − 1
  mtd: number | null; // close / first-session open of the month − 1
  day: number | null; // close / open − 1 of the last session
}

export interface SectorRow {
  sector: string;
  etf: string;
  stats: EtfStats;
  rank_20d: number | null; // 1 = strongest 20-day RS vs SPY, out of 11
  rank_20d_4w_ago: number | null;
  rank_change_4w: number | null; // positive = moved up (rotation into the sector)
  rank_wtd: number | null; // 1 = strongest week-to-date, as the STP Sector Rotation table
}

export interface SectorRotation {
  version: number;
  bar_date: string | null;
  sectors: SectorRow[];
  /** Stats for every fetched ETF (sector and industry), keyed by ETF symbol. */
  etfs: Record<string, EtfStats>;
}

function returnOver(bars: readonly DailyBar[], n: number): number | null {
  const k = bars.length;
  return k >= n + 1 ? bars[k - 1].close / bars[k - 1 - n].close - 1 : null;
}

function spyReturnSameDates(etf: readonly DailyBar[], spy: readonly DailyBar[], n: number): number | null {
  const k = etf.length;
  if (k < n + 1) return null;
  const byTime = new Map(spy.map((b) => [b.time, b.close]));
  const to = byTime.get(etf[k - 1].time);
  const from = byTime.get(etf[k - 1 - n].time);
  return to != null && from != null ? to / from - 1 : null;
}

export function computeEtfStats(bars: readonly DailyBar[], spy: readonly DailyBar[] | null): EtfStats {
  const f = computeBarFeatures(bars, spy);
  const r60 = returnOver(bars, 60);
  const spy60 = spy ? spyReturnSameDates(bars, spy, 60) : null;
  const earlier = bars.length > 20 ? computeBarFeatures(bars.slice(0, bars.length - 20), spy) : null;
  const last = bars[bars.length - 1];
  return {
    return_20d: f.return_20d,
    return_60d: r60,
    rs_vs_spy_20d: f.rs_vs_spy_20d,
    rs_vs_spy_60d: r60 != null && spy60 != null ? r60 - spy60 : null,
    rs_vs_spy_20d_4w_ago: earlier?.rs_vs_spy_20d ?? null,
    wtd: f.close_vs_week_open,
    mtd: f.close_vs_month_open,
    day: last?.open ? last.close / last.open - 1 : null,
  };
}

/** Rank descending (1 = highest); nulls get null and don't take a rank. */
export function rankDesc(values: (number | null)[]): (number | null)[] {
  const order = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v != null)
    .sort((a, b) => b.v - a.v);
  const out: (number | null)[] = values.map(() => null);
  order.forEach((x, r) => (out[x.i] = r + 1));
  return out;
}

export function computeSectorRotation(
  etfBars: Record<string, readonly DailyBar[] | null>,
  spy: readonly DailyBar[] | null,
  barDate: string | null,
): SectorRotation {
  const etfs: Record<string, EtfStats> = {};
  for (const [etf, bars] of Object.entries(etfBars)) {
    if (bars && bars.length > 0) etfs[etf] = computeEtfStats(bars, spy);
  }
  const sectors = Object.entries(SECTOR_ETFS);
  const stats = sectors.map(([, etf]) => etfs[etf] ?? null);
  const rankNow = rankDesc(stats.map((s) => s?.rs_vs_spy_20d ?? null));
  const rankPrev = rankDesc(stats.map((s) => s?.rs_vs_spy_20d_4w_ago ?? null));
  const rankWtd = rankDesc(stats.map((s) => s?.wtd ?? null));
  const rows: SectorRow[] = sectors.map(([sector, etf], i) => ({
    sector,
    etf,
    stats: stats[i] ?? emptyStats(),
    rank_20d: rankNow[i],
    rank_20d_4w_ago: rankPrev[i],
    rank_change_4w: rankNow[i] != null && rankPrev[i] != null ? rankPrev[i]! - rankNow[i]! : null,
    rank_wtd: rankWtd[i],
  }));
  return { version: SECTOR_ROTATION_VERSION, bar_date: barDate, sectors: rows, etfs };
}

function emptyStats(): EtfStats {
  return { return_20d: null, return_60d: null, rs_vs_spy_20d: null, rs_vs_spy_60d: null, rs_vs_spy_20d_4w_ago: null, wtd: null, mtd: null, day: null };
}

export interface TickerSectorFeatures {
  industry: string | null;
  sector_etf: string | null;
  industry_etf: string | null;
  rs_vs_sector_20d: number | null; // ticker 20-day return minus its sector ETF's
  rs_vs_industry_20d: number | null; // ticker 20-day return minus its industry ETF's
  sector_rank_20d: number | null;
  sector_rank_change_4w: number | null;
  industry_ticker_count: number | null; // tickers in this scan sharing the industry (theme clustering)
}

export function tickerSectorFeatures(
  sector: string | null | undefined,
  industry: string | null | undefined,
  tickerReturn20d: number | null | undefined,
  rotation: SectorRotation | null | undefined,
  industryCount: number | null,
): TickerSectorFeatures {
  const sectorEtf = sector ? SECTOR_ETFS[sector] ?? null : null;
  const industryEtf = industry ? INDUSTRY_ETFS[industry] ?? null : null;
  const r = tickerReturn20d ?? null;
  const sStats = sectorEtf ? rotation?.etfs[sectorEtf] : undefined;
  const iStats = industryEtf ? rotation?.etfs[industryEtf] : undefined;
  const row = sectorEtf ? rotation?.sectors.find((s) => s.etf === sectorEtf) : undefined;
  return {
    industry: industry ?? null,
    sector_etf: sectorEtf,
    industry_etf: industryEtf,
    rs_vs_sector_20d: r != null && sStats?.return_20d != null ? r - sStats.return_20d : null,
    rs_vs_industry_20d: r != null && iStats?.return_20d != null ? r - iStats.return_20d : null,
    sector_rank_20d: row?.rank_20d ?? null,
    sector_rank_change_4w: row?.rank_change_4w ?? null,
    industry_ticker_count: industry ? industryCount : null,
  };
}
