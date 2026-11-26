/**
 * P3-0m: options-flow results as log-only features on the stock's snapshot row
 * (docs/PHASE3-PREP.md §P3-0m, re-scoped by Chris 2026-11-26).
 *
 * The options-flow source already scans the universe (plus the static SCAN_SYMBOLS), so
 * universe rows read this run's cached chains: no new requests. The watched names outside the
 * universe (`watch_only` rows, capped by WATCH_ONLY_CAP) are fetched here with the source's own
 * batching. Neither creates OPTIONS_FLOW Signal rows. Null keys mean not scanned or failed,
 * never 0.
 */
import { analyzeChain, callSweep, computeNetPremium, type OptionsChainResult } from "./sources/options-flow";

export const OPTIONS_EXT_BATCH = 5;
export const OPTIONS_EXT_DELAY_MS = 2_000;
/** Warn when more than this share of the targets fails. */
export const OPTIONS_EXT_FAIL_WARN = 0.2;

export interface OptFeatures {
  opt_scanned: true;
  /** Contracts meeting the options-flow thresholds (vol/OI ≥ 3, volume ≥ 1,000, OI ≥ 100), calls and puts. */
  opt_unusual_n: number;
  /** Unusual calls on 3+ strikes of one expiry. */
  opt_sweep: boolean;
  /** Call − put premium (volume × mid × 100), USD; null when no contract traded. */
  opt_net_premium: number | null;
  opt_call_premium_ratio: number | null;
  /** The larger premium side; null when equal or none. */
  opt_top_type: "Call" | "Put" | null;
}

export const OPT_EXT_KEYS = ["opt_scanned", "opt_unusual_n", "opt_sweep", "opt_net_premium", "opt_call_premium_ratio", "opt_top_type"] as const;

/** Features from one nearest-expiry chain; null when it can't be read (no price or no expiry). */
export function optFeaturesFromChain(symbol: string, raw: unknown): OptFeatures | null {
  const chain = raw as OptionsChainResult | null;
  if (!chain?.quote?.regularMarketPrice || !chain.options?.[0]) return null;
  const unusual = analyzeChain(symbol, chain);
  const prem = computeNetPremium(chain);
  return {
    opt_scanned: true,
    opt_unusual_n: unusual.length,
    opt_sweep: callSweep(unusual) != null,
    opt_net_premium: prem?.netPremium ?? null,
    opt_call_premium_ratio: prem?.callPremiumRatio ?? null,
    opt_top_type: prem == null || prem.netPremium === 0 ? null : prem.netPremium > 0 ? "Call" : "Put",
  };
}

export interface OptionsExtStats {
  targets: number;
  scanned: number;
  /** Scanned symbols with opt_unusual_n ≥ 1. */
  unusual: number;
  failed: number;
}

export interface OptionsExtDeps {
  /** This run's cached chain request, without fetching (undefined if none). */
  peek: (symbol: string) => Promise<unknown> | undefined;
  /** A new (retried) chain fetch. */
  fetch: (symbol: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `cached`: symbols read from the run's cache only (the universe). `fetched`: symbols fetched in
 * batches of 5 with a 2 s delay (the watch_only names). A failed symbol gets no features and
 * never throws.
 */
export async function scanOptionsExt(
  cached: readonly string[],
  fetched: readonly string[],
  deps: OptionsExtDeps,
): Promise<{ features: Record<string, OptFeatures>; stats: OptionsExtStats }> {
  const features: Record<string, OptFeatures> = {};
  const fetchSet = [...new Set(fetched)];
  const cacheSet = [...new Set(cached)].filter((s) => !fetchSet.includes(s));
  const stats: OptionsExtStats = { targets: cacheSet.length + fetchSet.length, scanned: 0, unusual: 0, failed: 0 };
  const take = (sym: string, raw: unknown) => {
    const f = raw == null ? null : optFeaturesFromChain(sym, raw);
    if (!f) {
      stats.failed++;
      return;
    }
    features[sym] = f;
    stats.scanned++;
    if (f.opt_unusual_n >= 1) stats.unusual++;
  };
  for (const sym of cacheSet) {
    const p = deps.peek(sym);
    take(sym, p ? await p.catch(() => null) : null);
  }
  const sleep = deps.sleep ?? sleepMs;
  for (let i = 0; i < fetchSet.length; i += OPTIONS_EXT_BATCH) {
    const batch = fetchSet.slice(i, i + OPTIONS_EXT_BATCH);
    const res = await Promise.allSettled(batch.map((s) => deps.fetch(s)));
    res.forEach((r, j) => take(batch[j], r.status === "fulfilled" ? r.value : null));
    if (i + OPTIONS_EXT_BATCH < fetchSet.length) await sleep(OPTIONS_EXT_DELAY_MS);
  }
  return { features, stats };
}

/** `[options-ext] scanned n/m, unusual hits h, failed f, 429s r`; warn above 20% failed. */
export function optionsExtLine(s: OptionsExtStats, r429: number): { line: string; warn: boolean } {
  const line = `[options-ext] scanned ${s.scanned}/${s.targets}, unusual hits ${s.unusual}, failed ${s.failed}, 429s ${r429}`;
  const warn = s.targets > 0 && s.failed / s.targets > OPTIONS_EXT_FAIL_WARN;
  return { line: warn ? `${line}; WARNING: over ${OPTIONS_EXT_FAIL_WARN * 100}% failed` : line, warn };
}

/** The opt_* keys onto each row whose symbol was scanned; other rows are unchanged (no keys). */
export function withOptFeatures<R extends { symbol: string; features: Record<string, unknown> }>(rows: readonly R[], features: Readonly<Record<string, OptFeatures>>): R[] {
  return rows.map((r) => (features[r.symbol] ? { ...r, features: { ...r.features, ...features[r.symbol] } } : r));
}
