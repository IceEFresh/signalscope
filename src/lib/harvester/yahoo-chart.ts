/**
 * Yahoo v8 chart fetch with one retry on HTTP 429, plus per-run counters so a
 * source that is being rate-limited shows up in the harvest log instead of
 * silently returning fewer signals (PR 1-0 review).
 */

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export type ChartFetchResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number | null; rateLimited: boolean };

export interface ChartFetchOptions {
  /** Wait before the single retry after a 429. */
  retryDelayMs?: number;
  timeoutMs?: number;
}

export const DEFAULT_RETRY_DELAY_MS = 3_000;

export async function fetchYahooChart(url: string, opts: ChartFetchOptions = {}): Promise<ChartFetchResult> {
  const { retryDelayMs = DEFAULT_RETRY_DELAY_MS, timeoutMs = 10_000 } = opts;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { ok: false, status: null, rateLimited: false };
    }
    if (res.status === 429 && attempt === 1) {
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    if (!res.ok) return { ok: false, status: res.status, rateLimited: res.status === 429 };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, status: res.status, rateLimited: false };
    }
  }
  return { ok: false, status: 429, rateLimited: true };
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

export function clearChartCache(): void {
  chartCache.clear();
}
