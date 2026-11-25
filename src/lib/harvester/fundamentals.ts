import { yahooFinance, withYahooTimeout } from "@/lib/yahoo-finance";
import { withYahooRetry } from "@/lib/yahoo-retry";
import type { FundamentalData } from "./types";
import { toUnixSeconds } from "./yahoo-time";

async function fetchQuoteSummaryData(
  symbols: string[]
): Promise<Map<string, { sector?: string; industry?: string; floatShares?: number | null; shortFloat?: number | null }>> {
  const result = new Map<string, { sector?: string; industry?: string; floatShares?: number | null; shortFloat?: number | null }>();
  const CONCURRENCY = 5;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (sym) => {
        try {
          const summary = await withYahooRetry(
            () => withYahooTimeout(yahooFinance.quoteSummary(sym, { modules: ["assetProfile", "defaultKeyStatistics"] })),
            { label: "quoteSummary" },
          );
          result.set(sym, {
            sector: (summary.assetProfile as Record<string, unknown> | null | undefined)?.sector as string | undefined,
            // PR 1f: keep the industry (upstream discarded it)
            industry: (summary.assetProfile as Record<string, unknown> | null | undefined)?.industry as string | undefined,
            floatShares:
              typeof (summary.defaultKeyStatistics as Record<string, unknown> | null | undefined)?.floatShares === "number"
                ? (summary.defaultKeyStatistics as Record<string, unknown>).floatShares as number
                : null,
            shortFloat:
              typeof (summary.defaultKeyStatistics as Record<string, unknown> | null | undefined)?.shortPercentOfFloat === "number"
                ? (summary.defaultKeyStatistics as Record<string, unknown>).shortPercentOfFloat as number
                : null,
          });
        } catch {
          // non-fatal — sector/floatShares/shortFloat stay null for this symbol
        }
      })
    );
  }
  return result;
}

export interface Profile {
  sector: string | null;
  industry: string | null;
}

export interface ProfileFetchStats {
  total: number;
  /** Symbols with a sector or an industry. */
  fetched: number;
  /** The request succeeded but assetProfile had neither field (funds, some ADRs). */
  empty: number;
  /** The request failed after retries. */
  failed: number;
  /** The first PROFILE_ERROR_SAMPLES failure messages, "SYM: message". */
  errors: string[];
}

export const PROFILE_CONCURRENCY = 5;
/** P3-0i4: pause between batches of 5, so ~1,500 profiles don't hit Yahoo in one burst. */
export const PROFILE_BATCH_PAUSE_MS = 500;
/** P3-0i4: retries per profile (429s and 5xx back off through withYahooRetry, honouring Retry-After). */
export const PROFILE_RETRIES = 4;
export const PROFILE_ERROR_SAMPLES = 3;
export const PROFILE_WARN_SHARE = 0.8;

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * P3-0i4: sector and industry for `symbols`, PROFILE_CONCURRENCY at a time with a pause
 * between batches. Each request goes through withYahooRetry (429 → backoff and Retry-After).
 * A failure leaves that symbol out of the map; failures are counted and the first messages
 * kept, so the log shows why profiles are missing (they were swallowed before P3-0i4).
 */
export async function fetchProfilesWith(
  symbols: readonly string[],
  fetchSummary: (symbol: string) => Promise<unknown>,
  opts: { pauseMs?: number; sleep?: (ms: number) => Promise<void>; retries?: number } = {},
): Promise<{ profiles: Map<string, Profile>; stats: ProfileFetchStats }> {
  const { pauseMs = PROFILE_BATCH_PAUSE_MS, sleep = sleepMs, retries = PROFILE_RETRIES } = opts;
  const profiles = new Map<string, Profile>();
  const stats: ProfileFetchStats = { total: symbols.length, fetched: 0, empty: 0, failed: 0, errors: [] };
  for (let i = 0; i < symbols.length; i += PROFILE_CONCURRENCY) {
    if (i > 0 && pauseMs > 0) await sleep(pauseMs);
    await Promise.all(
      symbols.slice(i, i + PROFILE_CONCURRENCY).map(async (sym) => {
        try {
          const summary = (await withYahooRetry(() => fetchSummary(sym), { label: "profile", retries })) as { assetProfile?: unknown } | null;
          const p = summary?.assetProfile as Record<string, unknown> | null | undefined;
          const sector = typeof p?.sector === "string" && p.sector ? p.sector : null;
          const industry = typeof p?.industry === "string" && p.industry ? p.industry : null;
          if (sector == null && industry == null) {
            stats.empty++;
            return;
          }
          profiles.set(sym, { sector, industry });
          stats.fetched++;
        } catch (err) {
          stats.failed++;
          if (stats.errors.length < PROFILE_ERROR_SAMPLES) stats.errors.push(`${sym}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }
  return { profiles, stats };
}

/** `[universe] profiles: n/m fetched, e empty, f failed`; warn under 80%. */
export function profilesLine(s: ProfileFetchStats): { line: string; warn: boolean } {
  return {
    line: `[universe] profiles: ${s.fetched}/${s.total} fetched, ${s.empty} empty, ${s.failed} failed`,
    warn: s.total > 0 && s.fetched / s.total < PROFILE_WARN_SHARE,
  };
}

/** Log the profiles line (a warning under 80%) and the first failure messages. */
export function logProfileStats(s: ProfileFetchStats, log: Pick<Console, "log" | "warn"> = console): void {
  const { line, warn } = profilesLine(s);
  (warn ? log.warn : log.log)(warn ? `${line} (under ${PROFILE_WARN_SHARE * 100}%)` : line);
  for (const e of s.errors) log.warn(`[universe] profile error: ${e}`);
}

/** Yahoo quoteSummary assetProfile for one symbol (the live fetcher). */
export const fetchAssetProfile = (sym: string): Promise<unknown> => withYahooTimeout(yahooFinance.quoteSummary(sym, { modules: ["assetProfile"] }));

/**
 * P3-0d: Yahoo sector and industry only (assetProfile), for the weekly universe build.
 * P3-0i4: counted and logged, paced between batches; a failure leaves that symbol out.
 */
export async function fetchSectorIndustry(symbols: string[]): Promise<Map<string, Profile>> {
  const { profiles, stats } = await fetchProfilesWith(symbols, fetchAssetProfile);
  logProfileStats(stats);
  return profiles;
}

export async function fetchFundamentals(
  symbols: string[]
): Promise<Map<string, FundamentalData>> {
  const result = new Map<string, FundamentalData>();
  if (symbols.length === 0) return result;

  // Fetch quotes (batched) and quoteSummary data (sector/floatShares/shortFloat) in parallel
  const quoteRows: Awaited<ReturnType<typeof yahooFinance.quote>>[] = [];
  const [quoteSummaryData] = await Promise.all([
    fetchQuoteSummaryData(symbols),
    (async () => {
      for (let i = 0; i < symbols.length; i += 50) {
        const batch = symbols.slice(i, i + 50);
        try {
          const quotes = await withYahooRetry(() => withYahooTimeout(yahooFinance.quote(batch)), { label: "quote" });
          const list = Array.isArray(quotes) ? quotes : [quotes];
          quoteRows.push(...list);
        } catch (err) {
          console.warn(
            `[fundamentals] Batch fetch failed for ${batch.length} symbols:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    })(),
  ]);

  for (const q of quoteRows) {
    if (!q.symbol) continue;

    const fiftyTwoLow = q.fiftyTwoWeekLow;
    const fiftyTwoHigh = q.fiftyTwoWeekHigh;
    const fiftyTwoWeekRange =
      fiftyTwoLow != null && fiftyTwoHigh != null
        ? `${Number(fiftyTwoLow).toFixed(2)} - ${Number(fiftyTwoHigh).toFixed(2)}`
        : undefined;

    // Extract earnings date if available. yahoo-finance2 returns a Date here; the old
    // `typeof === "number"` check never matched it, so earningsDate was always empty (fixed in 1b).
    const rec = q as Record<string, unknown>;
    const earningsTs = toUnixSeconds(rec.earningsTimestamp);
    const earningsDate = earningsTs != null
      ? new Date(earningsTs * 1000).toISOString().split("T")[0]
      : undefined;

    // Extract float and shares outstanding
    const floatShares = typeof (q as Record<string, unknown>).floatShares === "number"
      ? (q as Record<string, unknown>).floatShares as number
      : null;
    const sharesOutstanding = typeof (q as Record<string, unknown>).sharesOutstanding === "number"
      ? (q as Record<string, unknown>).sharesOutstanding as number
      : null;

    const extra = quoteSummaryData.get(q.symbol);
    result.set(q.symbol, {
      price: q.regularMarketPrice ?? null,
      marketCap: q.marketCap ?? null,
      shortFloat: extra?.shortFloat ?? null,
      fiftyTwoWeekRange,
      wk52Lo: fiftyTwoLow ?? null,
      wk52Hi: fiftyTwoHigh ?? null,
      name: q.longName ?? q.shortName,
      sector: extra?.sector ?? ((q as Record<string, unknown>).sector as string | undefined),
      industry: extra?.industry,
      exchange: q.fullExchangeName ?? q.exchange,
      earningsDate,
      earningsTs,
      earningsTsStart: toUnixSeconds(rec.earningsTimestampStart),
      earningsTsEnd: toUnixSeconds(rec.earningsTimestampEnd),
      isEarningsDateEstimate: typeof rec.isEarningsDateEstimate === "boolean" ? rec.isEarningsDateEstimate : null,
      floatShares: extra?.floatShares ?? floatShares,
      sharesOutstanding,
    });
  }

  const withMarketCap = [...result.values()].filter((d) => d.marketCap != null).length;
  const withShortFloat = [...result.values()].filter((d) => d.shortFloat != null).length;
  console.log(
    `[fundamentals] Fetched ${result.size}/${symbols.length} symbols (${withMarketCap} with marketCap, ${withShortFloat} with shortFloat)`
  );

  return result;
}

export async function fetchCurrentPrices(
  symbols: string[]
): Promise<Map<string, number | null>> {
  const priceMap = new Map<string, number | null>();
  if (symbols.length === 0) return priceMap;

  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    try {
      const quotes = await withYahooRetry(() => withYahooTimeout(yahooFinance.quote(batch)), { label: "quote" });
      const list = Array.isArray(quotes) ? quotes : [quotes];
      for (const q of list) {
        if (q.symbol) priceMap.set(q.symbol, q.regularMarketPrice ?? null);
      }
    } catch (err) {
      console.warn(
        `[fundamentals] Batch price fetch failed for ${batch.length} symbols:`,
        err instanceof Error ? err.message : err
      );
      for (const sym of batch) priceMap.set(sym, null);
    }
  }

  return priceMap;
}

export async function fetchCurrentPrice(
  symbol: string
): Promise<number | null> {
  try {
    const q = await withYahooRetry(() => withYahooTimeout(yahooFinance.quote(symbol)), { label: "quote" });
    return q.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}
