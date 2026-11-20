/**
 * Liquidity and volatility metrics from Yahoo daily bars (PLAN.md, PR 1-0).
 *
 * One chart call per symbol (range=3mo). Every metric uses only completed bars
 * returned at fetch time, so nothing looks past the scan. Missing or short data
 * gives null, never 0.
 */

export interface DailyBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarMetrics {
  lastClose: number | null;
  /** Mean of close × volume over the last 20 bars, in dollars. */
  dollarVolume20d: number | null;
  /** Simple mean of true range over the last 14 bars, divided by the last close. */
  atrPct: number | null;
  /** Annualized stdev of the last 20 daily log returns (×√252). */
  hv20: number | null;
  barCount: number;
}

export const EMPTY_BAR_METRICS: BarMetrics = {
  lastClose: null,
  dollarVolume20d: null,
  atrPct: null,
  hv20: null,
  barCount: 0,
};

const ATR_PERIOD = 14;
const WINDOW = 20;

/** Parse a Yahoo v8 chart response into complete daily bars, dropping any bar with a null field. */
export function parseChartBars(json: unknown): DailyBar[] {
  const result = (json as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
    | { indicators?: { quote?: Array<Record<string, (number | null)[] | undefined>> } }
    | undefined;
  const q = result?.indicators?.quote?.[0];
  if (!q) return [];
  const highs = q.high ?? [];
  const lows = q.low ?? [];
  const closes = q.close ?? [];
  const volumes = q.volume ?? [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const [h, l, c, v] = [highs[i], lows[i], closes[i], volumes[i]];
    if (h == null || l == null || c == null || v == null) continue;
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || c <= 0) continue;
    bars.push({ high: h, low: l, close: c, volume: v });
  }
  return bars;
}

export function computeBarMetrics(bars: DailyBar[]): BarMetrics {
  const n = bars.length;
  if (n === 0) return { ...EMPTY_BAR_METRICS };
  const lastClose = bars[n - 1].close;

  let dollarVolume20d: number | null = null;
  if (n >= WINDOW) {
    const recent = bars.slice(-WINDOW);
    dollarVolume20d = recent.reduce((s, b) => s + b.close * b.volume, 0) / WINDOW;
  }

  let atrPct: number | null = null;
  if (n >= ATR_PERIOD + 1) {
    let sum = 0;
    for (let i = n - ATR_PERIOD; i < n; i++) {
      const prevClose = bars[i - 1].close;
      const b = bars[i];
      sum += Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    }
    atrPct = sum / ATR_PERIOD / lastClose;
  }

  let hv20: number | null = null;
  if (n >= WINDOW + 1) {
    const rets: number[] = [];
    for (let i = n - WINDOW; i < n; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    hv20 = Math.sqrt(variance) * Math.sqrt(252);
  }

  return { lastClose, dollarVolume20d, atrPct, hv20, barCount: n };
}

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/** Fetch 3 months of daily bars and compute metrics. Any failure returns null. */
export async function fetchBarMetrics(symbol: string): Promise<BarMetrics | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return computeBarMetrics(parseChartBars(await res.json()));
  } catch {
    return null;
  }
}

/**
 * Fetch metrics for many symbols, `concurrency` at a time with `delayMs` between batches.
 * Symbols whose fetch fails are absent from the returned map.
 */
export async function fetchBarMetricsMany(
  symbols: readonly string[],
  { concurrency = 5, delayMs = 300 }: { concurrency?: number; delayMs?: number } = {},
): Promise<Map<string, BarMetrics>> {
  const out = new Map<string, BarMetrics>();
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((s) => fetchBarMetrics(s)));
    results.forEach((m, j) => {
      if (m) out.set(batch[j], m);
    });
    if (delayMs > 0 && i + concurrency < symbols.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}
