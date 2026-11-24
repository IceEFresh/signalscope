/**
 * Yahoo v8 chart fetch with retries on HTTP 429, 5xx and network errors
 * (exponential backoff, PLAN.md 1e), plus per-run counters so a source that is
 * being rate-limited shows up in the harvest log instead of silently returning
 * fewer signals (PR 1-0 review).
 */
import { isRetryableStatus, withYahooRetry, DEFAULT_RETRIES } from "@/lib/yahoo-retry";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export type ChartFetchResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number | null; rateLimited: boolean };

export interface ChartFetchOptions {
  /** First backoff before a retry; doubles each retry (PLAN.md 1e). */
  retryDelayMs?: number;
  /** Retries after the first attempt. */
  retries?: number;
  timeoutMs?: number;
}

export const DEFAULT_RETRY_DELAY_MS = 3_000;

class RetryableHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export async function fetchYahooChart(url: string, opts: ChartFetchOptions = {}): Promise<ChartFetchResult> {
  const { retryDelayMs = DEFAULT_RETRY_DELAY_MS, retries = DEFAULT_RETRIES, timeoutMs = 10_000 } = opts;
  try {
    return await withYahooRetry(
      async (): Promise<ChartFetchResult> => {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
        if (isRetryableStatus(res.status)) throw new RetryableHttpError(res.status);
        if (!res.ok) return { ok: false, status: res.status, rateLimited: false };
        try {
          return { ok: true, json: await res.json() };
        } catch {
          return { ok: false, status: res.status, rateLimited: false };
        }
      },
      { retries, baseDelayMs: retryDelayMs, label: "chart" },
    );
  } catch (err) {
    const status = err instanceof RetryableHttpError ? err.status : null;
    return { ok: false, status, rateLimited: status === 429 };
  }
}

/** Per-run fetch counters. `rateLimited` counts symbols still 429 after the retry. */
export class FetchStats {
  ok = 0;
  failed = 0;
  rateLimited = 0;

  record(result: ChartFetchResult): void {
    if (result.ok) this.ok++;
    else if (result.rateLimited) this.rateLimited++;
    else this.failed++;
  }

  get total(): number {
    return this.ok + this.failed + this.rateLimited;
  }

  summary(): string {
    return `charts ok=${this.ok} failed=${this.failed} rate-limited(429)=${this.rateLimited} of ${this.total}`;
  }
}

/**
 * One 3-month daily chart per symbol per harvest run (PLAN.md 1a). Volume spike,
 * bar metrics and bar features all read from it, so a symbol is fetched once.
 * Only successful responses are cached; a failure is retried by the next caller.
 * The harvester is a one-shot process, so the cache lives for one run.
 */
const chartCache = new Map<string, Promise<ChartFetchResult>>();

export function dailyChartUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
}

export function fetchDailyChart(symbol: string, opts: ChartFetchOptions = {}): Promise<ChartFetchResult> {
  const hit = chartCache.get(symbol);
  if (hit) return hit;
  const p = fetchYahooChart(dailyChartUrl(symbol), opts).then((res) => {
    if (!res.ok) chartCache.delete(symbol);
    return res;
  });
  chartCache.set(symbol, p);
  return p;
}

/**
 * The cached chart for `symbol` if this run already fetched it, else undefined.
 * Never makes a request (P3-0c snapshots must add no network calls).
 */
export function peekDailyChart(symbol: string): Promise<ChartFetchResult> | undefined {
  return chartCache.get(symbol);
}

export function clearChartCache(): void {
  chartCache.clear();
}
