/**
 * Weekly universe build (PLAN.md PR 1-0, change 1). Network only, no DB:
 * runs on the harvester host and the result is posted to /api/harvest/universe.
 *
 * Request budget: ~1 directory fetch, ~N/50 quote batches (~170 for ~8,500
 * listings), one chart per pre-filter survivor, one options call per final
 * survivor. Expect roughly 10 to 15 minutes, once a week.
 */
import { yahooFinance, withYahooTimeout } from "@/lib/yahoo-finance";
import { fetchSymbolDirectory } from "./symbol-directory";
import { fetchBarMetricsMany, type BarMetrics } from "./bar-metrics";
import { evaluateUniverseRule, UNIVERSE_RULE, type UniverseRuleResult } from "./rule";

export interface QuoteInfo {
  quoteType: string | null;
  price: number | null;
  marketCap: number | null;
  /** 3-month average share volume, used only for the cheap pre-filter. */
  avgVolume3m: number | null;
  /** Latest earnings release, unix seconds (Yahoo earningsTimestamp), for STP EGOP (1g). */
  earningsTs?: number | null;
}

/** yahoo-finance2 may return earningsTimestamp as a Date or as unix seconds. */
export function toUnixSeconds(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : Math.floor(v.getTime() / 1000);
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : v;
  return null;
}

export interface UniverseMemberData {
  symbol: string;
  price: number | null;
  marketCap: number | null;
  dollarVolume20d: number | null;
  atrPct: number | null;
  hv20: number | null;
  hasOptions: boolean;
}

export interface UniverseBuildResult {
  rule: typeof UNIVERSE_RULE;
  directoryCount: number;
  prefilterCount: number;
  members: UniverseMemberData[];
}

export interface UniverseBuildDeps {
  fetchDirectory: () => Promise<string[]>;
  fetchQuotes: (symbols: string[]) => Promise<Map<string, QuoteInfo>>;
  fetchMetrics: (symbols: string[]) => Promise<Map<string, BarMetrics>>;
  hasListedOptions: (symbol: string) => Promise<boolean | null>;
}

/** Loose pre-filter on quote data, so bars are fetched only for plausible names. */
export function passesPrefilter(q: QuoteInfo | undefined): boolean {
  if (!q) return false;
  if (q.quoteType?.toUpperCase() !== "EQUITY") return false;
  if (q.price == null || q.price < UNIVERSE_RULE.minPrice) return false;
  if (q.marketCap == null || q.marketCap < UNIVERSE_RULE.minMarketCap) return false;
  // Half the dollar-volume bar: the 3-month average lags a recent pickup in volume.
  if (q.avgVolume3m == null || q.price * q.avgVolume3m < UNIVERSE_RULE.minDollarVolume20d / 2) return false;
  return true;
}

export async function buildUniverse(deps: UniverseBuildDeps = defaultDeps()): Promise<UniverseBuildResult> {
  const directory = await deps.fetchDirectory();
  const quotes = await deps.fetchQuotes(directory);
  const pre = directory.filter((s) => passesPrefilter(quotes.get(s)));
  console.log(`[universe] directory=${directory.length} quoted=${quotes.size} prefilter=${pre.length}`);

  const metrics = await deps.fetchMetrics(pre);
  const afterBars = pre.filter((s) => {
    const q = quotes.get(s)!;
    // Options not checked yet: evaluate everything else.
    const r = evaluateUniverseRule({ quoteType: q.quoteType, price: q.price, marketCap: q.marketCap, metrics: metrics.get(s) ?? null, hasOptions: true });
    return r.passes;
  });
  console.log(`[universe] after bar filters=${afterBars.length}`);

  const members: UniverseMemberData[] = [];
  for (let i = 0; i < afterBars.length; i += 5) {
    const batch = afterBars.slice(i, i + 5);
    const opts = await Promise.all(batch.map((s) => deps.hasListedOptions(s)));
    batch.forEach((s, j) => {
      if (opts[j] !== true) return;
      const q = quotes.get(s)!;
      const m = metrics.get(s)!;
      members.push({
        symbol: s,
        price: q.price,
        marketCap: q.marketCap,
        dollarVolume20d: m.dollarVolume20d,
        atrPct: m.atrPct,
        hv20: m.hv20,
        hasOptions: true,
      });
    });
  }
  console.log(`[universe] members=${members.length}`);
  return { rule: UNIVERSE_RULE, directoryCount: directory.length, prefilterCount: pre.length, members };
}

/** Evaluate the full rule (options included) for a short list, e.g. the graduation watch. */
export async function evaluateSymbols(
  symbols: string[],
  deps: Pick<UniverseBuildDeps, "fetchQuotes" | "fetchMetrics" | "hasListedOptions"> = defaultDeps(),
): Promise<Map<string, UniverseRuleResult & { metrics: BarMetrics | null }>> {
  const out = new Map<string, UniverseRuleResult & { metrics: BarMetrics | null }>();
  if (symbols.length === 0) return out;
  const [quotes, metrics] = await Promise.all([deps.fetchQuotes(symbols), deps.fetchMetrics(symbols)]);
  for (const s of symbols) {
    const q = quotes.get(s);
    const m = metrics.get(s) ?? null;
    const hasOptions = await deps.hasListedOptions(s);
    const r = evaluateUniverseRule({
      quoteType: q?.quoteType ?? null,
      price: q?.price ?? null,
      marketCap: q?.marketCap ?? null,
      metrics: m,
      hasOptions,
    });
    out.set(s, { ...r, metrics: m });
  }
  return out;
}

async function fetchQuotesYahoo(symbols: string[]): Promise<Map<string, QuoteInfo>> {
  const out = new Map<string, QuoteInfo>();
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    try {
      const res = await withYahooTimeout(yahooFinance.quote(batch));
      const list = Array.isArray(res) ? res : [res];
      for (const q of list) {
        if (!q?.symbol) continue;
        const rec = q as Record<string, unknown>;
        out.set(q.symbol, {
          quoteType: typeof rec.quoteType === "string" ? rec.quoteType : null,
          price: q.regularMarketPrice ?? null,
          marketCap: q.marketCap ?? null,
          avgVolume3m: typeof rec.averageDailyVolume3Month === "number" ? rec.averageDailyVolume3Month : null,
          earningsTs: toUnixSeconds(rec.earningsTimestamp),
        });
      }
    } catch (err) {
      console.warn(`[universe] quote batch failed (${batch.length} symbols):`, err instanceof Error ? err.message : err);
    }
    if (i + 50 < symbols.length) await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

async function hasListedOptionsYahoo(symbol: string): Promise<boolean | null> {
  try {
    const res = (await withYahooTimeout(yahooFinance.options(symbol))) as { expirationDates?: unknown[] };
    return Array.isArray(res.expirationDates) && res.expirationDates.length > 0;
  } catch {
    return null;
  }
}

export function defaultDeps(): UniverseBuildDeps {
  return {
    fetchDirectory: async () => (await fetchSymbolDirectory()).map((d) => d.symbol),
    fetchQuotes: fetchQuotesYahoo,
    fetchMetrics: (symbols) => fetchBarMetricsMany(symbols, { label: "universe bars" }),
    hasListedOptions: hasListedOptionsYahoo,
  };
}
