/**
 * Liquidity and volatility metrics from Yahoo daily bars (PLAN.md, PR 1-0).
 *
 * One chart call per symbol (range=3mo). Every metric uses only completed daily
 * bars: while a regular session is open its partial bar is dropped (see
 * parseChartBars). Missing or short data gives null, never 0.
 *
 * Shared parser for PR 1a and 1g, which also need completed bars only.
 */
import { FetchStats, fetchDailyChart, type ChartFetchResult } from "../yahoo-chart";

export interface DailyBar {
  /** Session open; absent when Yahoo returned null for it. */
  open?: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Bar start, unix seconds (from the chart's `timestamp` array), when present. */
  time?: number;
}

export interface BarMetrics {
  lastClose: number | null;
  /** Mean of close × volume over the last 20 bars, in dollars. */
  dollarVolume20d: number | null;
  /** Simple mean of true range over the last 14 bars, divided by the last close. Universe filter only:
   *  1a/1g must use Wilder-smoothed ATR to match docs/STP-SIGNALS.md. */
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

interface ChartResult {
  timestamp?: (number | null)[];
  meta?: { currentTradingPeriod?: { regular?: { start?: number; end?: number } } };
  indicators?: { quote?: Array<Record<string, (number | null)[] | undefined>> };
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Intl formatting dominates the P3-0g backfill (every bar re-dated for every session), so
// results are memoized per minute. Bounded so a long-running web process can't grow it.
const ET_MEMO = new Map<number, { date: string; minutes: number }>();
const ET_MEMO_MAX = 100_000;

export function etParts(d: Date): { date: string; minutes: number } {
  const key = Math.floor(d.getTime() / 60_000);
  const hit = ET_MEMO.get(key);
  if (hit) return { ...hit };
  const p = Object.fromEntries(ET_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  const out = { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  if (ET_MEMO.size >= ET_MEMO_MAX) ET_MEMO.clear();
  ET_MEMO.set(key, out);
  return { ...out };
}

/**
 * True when the bar starting at `barTime` (unix s) belongs to a regular session
 * still open at `now`. Uses `meta.currentTradingPeriod.regular` when Yahoo sends
 * it; otherwise falls back to US equity hours (9:30–16:00 ET, same ET date).
 */
export function isOpenSessionBar(barTime: number, now: Date, regular?: { start?: number; end?: number }): boolean {
  const nowS = now.getTime() / 1000;
  if (regular?.start != null && regular?.end != null) {
    return barTime >= regular.start && nowS >= regular.start && nowS < regular.end;
  }
  const bar = etParts(new Date(barTime * 1000));
  const cur = etParts(now);
  return bar.date === cur.date && cur.minutes >= 9 * 60 + 30 && cur.minutes < 16 * 60;
}

/**
 * Parse a Yahoo v8 chart response into complete daily bars. Drops any bar with
 * a null field, and drops the current session's partial bar while that session
 * is open at `now` (so intraday re-runs see the same bars as the 8:30 AM run).
 */
export function parseChartBars(json: unknown, now: Date = new Date()): DailyBar[] {
  const result = (json as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as ChartResult | undefined;
  const q = result?.indicators?.quote?.[0];
  if (!q) return [];
  const highs = q.high ?? [];
  const lows = q.low ?? [];
  const closes = q.close ?? [];
  const volumes = q.volume ?? [];
  const opens = q.open ?? [];
  const times = result?.timestamp ?? [];
  const regular = result?.meta?.currentTradingPeriod?.regular;
  const bars: DailyBar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const [h, l, c, v] = [highs[i], lows[i], closes[i], volumes[i]];
    if (h == null || l == null || c == null || v == null) continue;
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || c <= 0) continue;
    const t = times[i];
    if (t != null && isOpenSessionBar(t, now, regular)) continue;
    const bar: DailyBar = { high: h, low: l, close: c, volume: v };
    const o = opens[i];
    if (o != null && Number.isFinite(o) && o > 0) bar.open = o;
    if (t != null) bar.time = t;
    bars.push(bar);
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

async function fetchBarMetricsDetailed(
  symbol: string,
  retryDelayMs?: number,
): Promise<{ metrics: BarMetrics | null; fetch: ChartFetchResult }> {
  // Shared per-run chart (PLAN.md 1a): volume spike and bar features read the same response.
  const res = await fetchDailyChart(symbol, { retryDelayMs });
  return { metrics: res.ok ? computeBarMetrics(parseChartBars(res.json)) : null, fetch: res };
}

/** Fetch 3 months of daily bars and compute metrics. Any failure returns null. */
export async function fetchBarMetrics(symbol: string): Promise<BarMetrics | null> {
  return (await fetchBarMetricsDetailed(symbol)).metrics;
}

/**
 * Fetch metrics for many symbols, `concurrency` at a time with `delayMs` between
 * batches, retrying once on 429. Symbols whose fetch fails are absent from the
 * returned map. Logs ok / failed / 429 counts for the run.
 */
export async function fetchBarMetricsMany(
  symbols: readonly string[],
  {
    concurrency = 5,
    delayMs = 300,
    retryDelayMs,
    label = "bars",
  }: { concurrency?: number; delayMs?: number; retryDelayMs?: number; label?: string } = {},
): Promise<Map<string, BarMetrics>> {
  const out = new Map<string, BarMetrics>();
  const stats = new FetchStats();
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((s) => fetchBarMetricsDetailed(s, retryDelayMs)));
    results.forEach((r, j) => {
      stats.record(r.fetch);
      if (r.metrics) out.set(batch[j], r.metrics);
    });
    if (delayMs > 0 && i + concurrency < symbols.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const line = `[${label}] ${stats.summary()}`;
  if (stats.rateLimited > 0 || stats.failed > 0) console.warn(line);
  else console.log(line);
  return out;
}
