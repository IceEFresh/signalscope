/**
 * Alpaca options chain snapshots and trades, PLAN.md PR 2e. LOG ONLY: per-ticker
 * keys merge into the 1h option features (ValidatedTicker.features); no score,
 * stage or label reads them. Yahoo's OPTIONS_FLOW signal is unchanged.
 *
 * Per signal ticker:
 *   1. Chain snapshots for expiries within 60 days (feed=indicative, paged, capped).
 *      Volume, premium (volume x VWAP x 100) and trade count per expiry bucket, from
 *      daily bars dated the last completed session only. A snapshot's dailyBar is the
 *      contract's last traded day, which can be days old.
 *   2. Trades for the top contracts by session premium, inside that session's regular
 *      hours (09:30-16:00 ET), paged and capped. Counts prints of $100K premium or more.
 *      Large prints are a lower bound: only the top contracts are read.
 *
 * Never infers buy or sell side. Needs ALPACA_API_KEY / ALPACA_SECRET_KEY; without them
 * the step is skipped with one warning. A failed ticker never stops the harvest.
 */
import { alpacaCredentialsFromEnv, type AlpacaCredentials } from "@/lib/brokers/alpaca/client";
import { withYahooRetry } from "@/lib/yahoo-retry";
import { etParts } from "./universe/bar-metrics";

/** Basis version stored as alp_version (features must be numeric). 1 = snapshots(indicative) + trades, top-N contracts. */
export const ALPACA_OPTIONS_VERSION = 1;
export const MAX_EXPIRY_DAYS = 60;
export const BUCKETS = [
  { key: "0_7", maxDays: 7 },
  { key: "8_30", maxDays: 30 },
  { key: "31_60", maxDays: MAX_EXPIRY_DAYS },
] as const;
export const LARGE_PRINT_PREMIUM = 100_000;
export const TOP_CONTRACTS_FOR_TRADES = 10;
export const MAX_SNAPSHOT_PAGES = 4;
export const MAX_TRADE_PAGES = 3;
/** ~176 requests/minute, under Alpaca's free-tier 200/min. */
export const ALPACA_MIN_INTERVAL_MS = 340;

const DATA_URL = "https://data.alpaca.markets";
const DAY_MS = 86_400_000;

export interface OccContract {
  root: string;
  expiry: string; // YYYY-MM-DD
  type: "C" | "P";
  strike: number;
}

/** Parse an OCC option symbol from the right (roots vary in length). Null if malformed. */
export function parseOcc(symbol: string): OccContract | null {
  const m = symbol.match(/^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] as "C" | "P", strike: Number(m[6]) / 1000 };
}

/** UTC instant of an ET wall-clock time on an ET date (DST-aware). */
export function etToUtc(date: string, hh: number, mm: number): Date {
  const [y, mo, d] = date.split("-").map(Number);
  for (const off of [4, 5]) {
    const c = new Date(Date.UTC(y, mo - 1, d, hh + off, mm));
    const p = etParts(c);
    if (p.date === date && p.minutes === hh * 60 + mm) return c;
  }
  throw new Error(`no ET instant for ${date} ${hh}:${mm}`);
}

/** Regular-session window for `sessionDate`, clipped so it never ends after `now` (no look-ahead). */
export function sessionWindow(sessionDate: string, now: Date): { start: Date; end: Date } | null {
  const start = etToUtc(sessionDate, 9, 30);
  const close = etToUtc(sessionDate, 16, 0);
  const end = close < now ? close : now;
  return end > start ? { start, end } : null;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

interface Bar { t?: string; v?: number; vw?: number; n?: number }
export interface Snapshot { dailyBar?: Bar }
export interface Trade { p?: number; s?: number; t?: string }

export interface ChainStats {
  features: Record<string, number | null>;
  /** Contracts ranked by session premium, highest first. */
  topContracts: string[];
}

/** Bucket stats from snapshots, counting only daily bars dated `sessionDate`. Pure. */
export function computeChainStats(snapshots: Record<string, Snapshot>, sessionDate: string): ChainStats {
  const f: Record<string, number | null> = {};
  for (const b of BUCKETS) for (const k of ["call_volume", "put_volume", "call_premium", "put_premium", "trades"]) f[`alp_${k}_${b.key}`] = 0;
  const ranked: Array<[string, number]> = [];
  let contracts = 0;
  for (const [sym, snap] of Object.entries(snapshots)) {
    const c = parseOcc(sym);
    if (!c) continue;
    const dte = daysBetween(sessionDate, c.expiry);
    const bucket = BUCKETS.find((b) => dte >= 0 && dte <= b.maxDays);
    if (!bucket) continue;
    contracts++;
    const bar = snap.dailyBar;
    if (!bar?.t || bar.t.slice(0, 10) !== sessionDate) continue; // stale bar: no volume this session
    const v = typeof bar.v === "number" ? bar.v : 0;
    const prem = typeof bar.vw === "number" ? v * bar.vw * 100 : 0;
    const side = c.type === "C" ? "call" : "put";
    f[`alp_${side}_volume_${bucket.key}`]! += v;
    f[`alp_${side}_premium_${bucket.key}`]! += prem;
    f[`alp_trades_${bucket.key}`]! += typeof bar.n === "number" ? bar.n : 0;
    if (prem > 0) ranked.push([sym, prem]);
  }
  for (const k of Object.keys(f)) if (f[k] != null) f[k] = Math.round(f[k]!);
  f.alp_contracts = contracts;
  ranked.sort((a, b) => b[1] - a[1]);
  return { features: f, topContracts: ranked.map(([s]) => s) };
}

/** Prints of at least `min` premium inside [start, end]. Pure. Side is never inferred. */
export function countLargePrints(
  trades: Record<string, Trade[]>,
  window: { start: Date; end: Date },
  min = LARGE_PRINT_PREMIUM,
): { count: number; premium: number; callCount: number } {
  let count = 0;
  let premium = 0;
  let callCount = 0;
  const s = window.start.getTime();
  const e = window.end.getTime();
  for (const [sym, list] of Object.entries(trades)) {
    const c = parseOcc(sym);
    for (const t of list ?? []) {
      const ts = t.t ? Date.parse(t.t) : NaN;
      if (!(ts >= s && ts <= e) || typeof t.p !== "number" || typeof t.s !== "number") continue;
      const prem = t.p * t.s * 100;
      if (prem < min) continue;
      count++;
      premium += prem;
      if (c?.type === "C") callCount++;
    }
  }
  return { count, premium: Math.round(premium), callCount };
}

export type AlpacaGet = (url: string, headers: Record<string, string>) => Promise<unknown>;

const defaultGet: AlpacaGet = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`alpaca ${res.status}`), { status: res.status });
  return res.json();
};

/** Paced Alpaca market-data client; counts requests for the run log. */
export class AlpacaDataClient {
  requests = 0;
  private last = 0;
  private readonly headers: Record<string, string>;

  constructor(
    creds: AlpacaCredentials,
    private readonly get: AlpacaGet = defaultGet,
    private readonly minIntervalMs: number = ALPACA_MIN_INTERVAL_MS,
  ) {
    this.headers = { "APCA-API-KEY-ID": creds.apiKey, "APCA-API-SECRET-KEY": creds.apiSecret };
  }

  async fetch(path: string, params: Record<string, string>): Promise<unknown> {
    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    this.requests++;
    const url = `${DATA_URL}${path}?${new URLSearchParams(params)}`;
    return withYahooRetry(() => this.get(url, this.headers), { label: "alpaca" });
  }
}

/** Paged fetch of a keyed map (`snapshots` or `trades`). Returns the merged map and whether the page cap cut it short. */
async function fetchPaged<T>(
  client: AlpacaDataClient,
  path: string,
  key: "snapshots" | "trades",
  params: Record<string, string>,
  maxPages: number,
): Promise<{ data: Record<string, T>; capped: boolean }> {
  const data: Record<string, T> = {};
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const json = (await client.fetch(path, token ? { ...params, page_token: token } : params)) as Record<string, unknown> | null;
    const chunk = (json?.[key] ?? {}) as Record<string, T>;
    for (const [k, v] of Object.entries(chunk)) {
      if (key === "trades" && Array.isArray(data[k]) && Array.isArray(v)) (data[k] as unknown as unknown[]).push(...(v as unknown[]));
      else data[k] = v;
    }
    token = typeof json?.next_page_token === "string" && json.next_page_token ? json.next_page_token : undefined;
    if (!token) return { data, capped: false };
  }
  return { data, capped: true };
}

/** Per-ticker Alpaca features for one ticker. Throws on request failure (caller isolates). */
export async function alpacaFeaturesFor(
  client: AlpacaDataClient,
  symbol: string,
  sessionDate: string,
  now: Date,
): Promise<Record<string, number | null>> {
  const scanDate = etParts(now).date;
  const lte = new Date(Date.parse(`${scanDate}T00:00:00Z`) + MAX_EXPIRY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const snaps = await fetchPaged<Snapshot>(
    client,
    `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`,
    "snapshots",
    { feed: "indicative", limit: "1000", expiration_date_gte: scanDate, expiration_date_lte: lte },
    MAX_SNAPSHOT_PAGES,
  );
  const stats = computeChainStats(snaps.data, sessionDate);
  const out: Record<string, number | null> = {
    alp_version: ALPACA_OPTIONS_VERSION,
    ...stats.features,
    alp_snapshots_capped: snaps.capped ? 1 : 0,
    alp_large_prints: null,
    alp_large_print_premium: null,
    alp_large_print_calls: null,
    alp_trades_capped: null,
  };
  const window = sessionWindow(sessionDate, now);
  const top = stats.topContracts.slice(0, TOP_CONTRACTS_FOR_TRADES);
  if (!window || top.length === 0) return out;
  const trades = await fetchPaged<Trade[]>(
    client,
    "/v1beta1/options/trades",
    "trades",
    { symbols: top.join(","), start: window.start.toISOString(), end: window.end.toISOString(), limit: "1000", sort: "asc" },
    MAX_TRADE_PAGES,
  );
  const lp = countLargePrints(trades.data, window);
  out.alp_large_prints = lp.count;
  out.alp_large_print_premium = lp.premium;
  out.alp_large_print_calls = lp.callCount;
  out.alp_trades_capped = trades.capped ? 1 : 0;
  return out;
}

/**
 * Alpaca option features for the signal tickers (harvester side). `sessionDate` is the
 * last completed session (1c's spy_bar_date); without it, or without credentials, skip.
 */
export async function computeAlpacaOptionsExtras(
  symbols: readonly string[],
  sessionDate: string | null,
  { creds = alpacaCredentialsFromEnv(), get, minIntervalMs, now = new Date() }:
    { creds?: AlpacaCredentials | null; get?: AlpacaGet; minIntervalMs?: number; now?: Date } = {},
): Promise<Record<string, Record<string, number | null>>> {
  const out: Record<string, Record<string, number | null>> = {};
  const list = [...new Set(symbols)];
  if (list.length === 0) return out;
  if (!creds) {
    console.warn("[alpaca-options] ALPACA_API_KEY / ALPACA_SECRET_KEY not set: Alpaca option features skipped");
    return out;
  }
  if (!sessionDate) {
    console.warn("[alpaca-options] no session date (SPY bars missing): Alpaca option features skipped");
    return out;
  }
  const client = new AlpacaDataClient(creds, get, minIntervalMs);
  let failed = 0;
  for (const s of list) {
    try {
      out[s] = await alpacaFeaturesFor(client, s, sessionDate, now);
    } catch {
      failed++;
    }
  }
  console.log(`[alpaca-options] ${Object.keys(out).length}/${list.length} tickers, ${failed} failed, ${client.requests} requests, session ${sessionDate}`);
  return out;
}
