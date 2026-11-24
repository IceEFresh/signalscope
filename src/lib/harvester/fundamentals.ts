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

/**
 * P3-0d: Yahoo sector and industry only (assetProfile), for the weekly universe build.
 * Five at a time with the shared retry; a failure leaves that symbol out.
 */
export async function fetchSectorIndustry(symbols: string[]): Promise<Map<string, { sector: string | null; industry: string | null }>> {
  const out = new Map<string, { sector: string | null; industry: string | null }>();
  const CONCURRENCY = 5;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    await Promise.all(
      symbols.slice(i, i + CONCURRENCY).map(async (sym) => {
        try {
          const summary = await withYahooRetry(() => withYahooTimeout(yahooFinance.quoteSummary(sym, { modules: ["assetProfile"] })), {
            label: "profile",
          });
          const p = summary.assetProfile as Record<string, unknown> | null | undefined;
          out.set(sym, {
            sector: typeof p?.sector === "string" ? p.sector : null,
            industry: typeof p?.industry === "string" ? p.industry : null,
          });
        } catch {
          // non-fatal: sector and industry stay null for this member
        }
      }),
    );
  }
  return out;
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
