/**
 * Yahoo option chains, shared per harvest run (PLAN.md 1h). Options-flow and
 * the 1h option features read the same cached responses, so the nearest-expiry
 * chain for a universe ticker is fetched once per run.
 *
 * Cboe's free delayed-quote JSON (the plan's first choice) is blocked by a
 * Cloudflare bot check from both the cloud sandbox and the NAS (HTTP 403), so
 * 1h uses Yahoo, which the harvester already reaches.
 */
import { yahooFinance, withYahooTimeout } from "@/lib/yahoo-finance";
import { withYahooRetry } from "@/lib/yahoo-retry";
import { toUnixSeconds } from "./yahoo-time";

export interface OptionContract {
  strike: number;
  iv: number | null;
  volume: number;
  openInterest: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface NormalizedChain {
  spot: number | null;
  /** Expiry date as Yahoo sends it: midnight UTC of the expiry day, unix seconds. */
  expiry: number;
  /** All listed expiries for the underlying, unix seconds. */
  expirations: number[];
  calls: OptionContract[];
  puts: OptionContract[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function contract(c: Record<string, unknown>): OptionContract | null {
  const strike = num(c.strike);
  if (strike == null) return null;
  return {
    strike,
    iv: num(c.impliedVolatility),
    volume: num(c.volume) ?? 0,
    openInterest: num(c.openInterest) ?? 0,
    bid: num(c.bid),
    ask: num(c.ask),
    last: num(c.lastPrice),
  };
}

/**
 * Normalize either a raw Yahoo v7 response (`optionChain.result[0]`, unix-second
 * dates) or the yahoo-finance2 `options()` object (Date objects). Null if malformed.
 */
export function normalizeChain(raw: unknown): NormalizedChain | null {
  const r = ((raw as { optionChain?: { result?: unknown[] } })?.optionChain?.result?.[0] ?? raw) as
    | { quote?: { regularMarketPrice?: unknown }; expirationDates?: unknown[]; options?: Array<Record<string, unknown>> }
    | null
    | undefined;
  const o = r?.options?.[0];
  if (!r || !o) return null;
  const expiry = toUnixSeconds(o.expirationDate);
  if (expiry == null) return null;
  const list = (k: string) =>
    (Array.isArray(o[k]) ? (o[k] as Record<string, unknown>[]) : []).map(contract).filter((c): c is OptionContract => c !== null);
  return {
    spot: num(r.quote?.regularMarketPrice),
    expiry,
    expirations: (r.expirationDates ?? []).map(toUnixSeconds).filter((x): x is number => x != null),
    calls: list("calls"),
    puts: list("puts"),
  };
}

const rawCache = new Map<string, Promise<unknown>>();

/**
 * yahoo-finance2 `options()` for one expiry (nearest when `expiry` is omitted),
 * cached for the run. Failures are not cached and reject, so callers keep their
 * own error handling (options-flow logs and skips the symbol).
 */
export function fetchOptionsRaw(symbol: string, expiry?: number): Promise<unknown> {
  const key = `${symbol}|${expiry ?? "near"}`;
  const hit = rawCache.get(key);
  if (hit) return hit;
  const p = withYahooRetry(
    () =>
      withYahooTimeout(
        expiry == null ? yahooFinance.options(symbol) : yahooFinance.options(symbol, { date: new Date(expiry * 1000) }),
      ),
    { label: "options" },
  ).catch((err) => {
    rawCache.delete(key);
    throw err;
  });
  rawCache.set(key, p);
  return p;
}

/** This run's cached nearest-expiry request for `symbol`, without fetching (P3-0m); undefined if none. */
export function peekOptionsRaw(symbol: string): Promise<unknown> | undefined {
  return rawCache.get(`${symbol}|near`);
}

export function clearOptionsCache(): void {
  rawCache.clear();
}
