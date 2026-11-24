/**
 * CoinMarketCap /v1/cryptocurrency/listings/latest for the weekly crypto universe
 * (docs/PHASE3-PREP.md P3-0e step 1b). LOG ONLY. One call for the top 500 by market
 * cap (2 credits on the saved NAS response), with the shared retry. COINMARKETCAP_API_KEY
 * is sent as X-CMC_PRO_API_KEY. CMC `tags` feed the exclusions; the id is stored as
 * `cmc:<id>` in UniverseMember.coingeckoId (no extra column).
 */
import { withRetry, HttpError, throwIfRetryable } from "@/lib/yahoo-retry";
import type { CryptoListing } from "./listing";

export const CMC_LIMIT = 500;
export const CMC_URL = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${CMC_LIMIT}&convert=USD`;

export function parseCmcListings(json: unknown): CryptoListing[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return data.flatMap((r: Record<string, unknown>) => {
    if (typeof r?.id !== "number" || typeof r?.symbol !== "string") return [];
    const usd = (r.quote as { USD?: Record<string, unknown> } | undefined)?.USD;
    return [{
      id: `cmc:${r.id}`,
      symbol: r.symbol,
      name: typeof r.name === "string" ? r.name : r.symbol,
      marketCap: num(usd?.market_cap),
      price: num(usd?.price),
      tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    }];
  });
}

export async function fetchCmcListings(opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}): Promise<CryptoListing[]> {
  const { apiKey = process.env.COINMARKETCAP_API_KEY, fetchImpl = fetch } = opts;
  if (!apiKey) throw new Error("COINMARKETCAP_API_KEY is not set");
  const json = await withRetry(
    async () => {
      const res = await fetchImpl(CMC_URL, { headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": apiKey }, signal: AbortSignal.timeout(20_000) });
      throwIfRetryable(res);
      if (!res.ok) throw new HttpError(res.status);
      return res.json();
    },
    { label: "coinmarketcap" },
  );
  const code = (json as { status?: { error_code?: unknown } } | null)?.status?.error_code;
  if (code != null && code !== 0 && code !== "0") throw new Error(`coinmarketcap error_code ${String(code)}`);
  const out = parseCmcListings(json);
  if (out.length === 0) throw new Error("coinmarketcap returned no listings");
  return out;
}
