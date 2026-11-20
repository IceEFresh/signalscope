import type { RawSignal } from "../types";
import { SCAN_SYMBOLS } from "./ticker-utils";
import { FetchStats, fetchYahooChart, type ChartFetchResult } from "../yahoo-chart";

const VOLUME_SPIKE_THRESHOLD = 2.0;

export interface VolumeSpikeOptions {
  /** Charts fetched in parallel. Matches options-flow (5 per 2 s) to stay under Yahoo's rate limit. */
  batchSize?: number;
  batchDelayMs?: number;
  /** Wait before the single retry after a 429. */
  retryDelayMs?: number;
}

/** Scans `symbols` (the generated universe when available, else the static SCAN_SYMBOLS list). */
export async function fetchVolumeSpikeSignals(
  symbols: readonly string[] = SCAN_SYMBOLS,
  { batchSize = 5, batchDelayMs = 2_000, retryDelayMs }: VolumeSpikeOptions = {},
): Promise<RawSignal[]> {
  console.log("Volume Spike: scanning", symbols.length, "symbols...");
  const signals: RawSignal[] = [];
  const stats = new FetchStats();

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((symbol) => fetchVolumeDataDetailed(symbol, retryDelayMs)));

    for (const { data, fetch } of results) {
      stats.record(fetch);
      if (!data) continue;
      const { symbol, regularMarketVolume, averageDailyVolume10Day } = data;

      if (averageDailyVolume10Day > 0) {
        const ratio = regularMarketVolume / averageDailyVolume10Day;

        if (ratio >= VOLUME_SPIKE_THRESHOLD) {
          signals.push({
            symbol,
            source: "VOLUME_SPIKE",
            title: `Volume spike: ${symbol} trading at ${ratio.toFixed(1)}x average volume`,
            body: `Current volume: ${formatVolume(regularMarketVolume)}, 10-day avg: ${formatVolume(averageDailyVolume10Day)}, ratio: ${ratio.toFixed(2)}x`,
            volumeRatio: Math.round(ratio * 100) / 100,
          });
        }
      }
    }

    if (batchDelayMs > 0 && i + batchSize < symbols.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }

  const line = `Volume Spike: ${signals.length} signals; ${stats.summary()}`;
  if (stats.rateLimited > 0 || stats.failed > 0) console.warn(line);
  else console.log(line);
  return signals;
}

interface VolumeData {
  symbol: string;
  regularMarketVolume: number;
  averageDailyVolume10Day: number;
}

export function parseVolumeData(symbol: string, json: unknown): VolumeData | null {
  const result = (json as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
    | { meta?: { regularMarketVolume?: number }; indicators?: { quote?: Array<{ volume?: (number | null)[] }> } }
    | undefined;
  if (!result) return null;

  const meta = result.meta;
  const volumes: (number | null)[] = result?.indicators?.quote?.[0]?.volume ?? [];
  const validVolumes = volumes.filter((v): v is number => v != null && v > 0);

  if (validVolumes.length < 2) return null;

  // Last bar is current/most-recent day; prior bars form the average
  const regularMarketVolume = meta?.regularMarketVolume ?? validVolumes[validVolumes.length - 1];
  const priorVolumes = validVolumes.slice(0, -1);
  const averageDailyVolume10Day =
    priorVolumes.reduce((sum, v) => sum + v, 0) / priorVolumes.length;

  return { symbol, regularMarketVolume, averageDailyVolume10Day };
}

async function fetchVolumeDataDetailed(
  symbol: string,
  retryDelayMs?: number,
): Promise<{ data: VolumeData | null; fetch: ChartFetchResult }> {
  // Use 15d range to get enough daily bars to compute a 10-day average.
  // The v8 chart API no longer returns averageDailyVolume10Day in meta,
  // so we compute it from the historical volume time-series.
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=15d`;
  const res = await fetchYahooChart(url, { retryDelayMs });
  return { data: res.ok ? parseVolumeData(symbol, res.json) : null, fetch: res };
}

export async function fetchVolumeData(symbol: string): Promise<VolumeData | null> {
  return (await fetchVolumeDataDetailed(symbol)).data;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000_000) return `${(vol / 1_000_000_000).toFixed(1)}B`;
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return vol.toString();
}
