import type { RawSignal } from "../types";
import { SCAN_SYMBOLS } from "./ticker-utils";
import { FetchStats, fetchDailyChart, type ChartFetchResult } from "../yahoo-chart";

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

/** Upstream averaged the bars of a range=15d chart. 1a fetches 3 months once and keeps the same window. */
export const VOLUME_WINDOW_DAYS = 15;

export function parseVolumeData(symbol: string, json: unknown, now: Date = new Date()): VolumeData | null {
  const result = (json as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
    | {
        meta?: { regularMarketVolume?: number };
        timestamp?: (number | null)[];
        indicators?: { quote?: Array<{ volume?: (number | null)[] }> };
      }
    | undefined;
  if (!result) return null;

  const meta = result.meta;
  const allVolumes: (number | null)[] = result?.indicators?.quote?.[0]?.volume ?? [];
  // Keep only the bars a range=15d request would have returned, so the signal is unchanged.
  const times = result.timestamp ?? [];
  const cutoff = now.getTime() / 1000 - VOLUME_WINDOW_DAYS * 24 * 60 * 60;
  const volumes = times.length === allVolumes.length
    ? allVolumes.filter((_, i) => times[i] == null || (times[i] as number) >= cutoff)
    : allVolumes;
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
  // The v8 chart API no longer returns averageDailyVolume10Day in meta, so we compute it
  // from the volume series. PLAN.md 1a: the shared 3-month chart replaces the old range=15d
  // call; parseVolumeData keeps the last 15 calendar days so the average is unchanged.
  const res = await fetchDailyChart(symbol, { retryDelayMs });
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
