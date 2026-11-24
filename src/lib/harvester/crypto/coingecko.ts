/**
 * CoinGecko /coins/markets for the weekly crypto universe (docs/PHASE3-PREP.md P3-0e).
 * LOG ONLY. Free tier: top 500 by market cap in two pages of 250, about 3 s apart,
 * with the shared retry. An optional COINGECKO_API_KEY (demo key) is sent as
 * x-cg-demo-api-key.
 *
 * The markets response has no categories (checked against the saved NAS fixture), so
 * CoinGecko listings have empty tags and rely on the denylist and name patterns
 * (listing.ts).
 */
import { withRetry, HttpError, throwIfRetryable } from "@/lib/yahoo-retry";
import type { CryptoListing } from "./listing";


export const COINGECKO_PAGES = 2;
export const COINGECKO_PER_PAGE = 250;
export const COINGECKO_PAGE_DELAY_MS = 3_000;

export function parseMarkets(json: unknown): CryptoListing[] {
  if (!Array.isArray(json)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return json.flatMap((r: Record<string, unknown>) =>
    typeof r?.id === "string" && typeof r?.symbol === "string"
      ? [{
          id: r.id,
          symbol: r.symbol,
          name: typeof r.name === "string" ? r.name : r.id,
          marketCap: num(r.market_cap),
          price: num(r.current_price),
          tags: Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === "string") : [],
        }]
      : [],
  );
}

export function marketsUrl(page: number): string {
  return `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${COINGECKO_PER_PAGE}&page=${page}`;
}

export async function fetchCoinGeckoMarkets(
  opts: { apiKey?: string; fetchImpl?: typeof fetch; delayMs?: number } = {},
): Promise<CryptoListing[]> {
  const { apiKey = process.env.COINGECKO_API_KEY, fetchImpl = fetch, delayMs = COINGECKO_PAGE_DELAY_MS } = opts;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  const out: CryptoListing[] = [];
  for (let page = 1; page <= COINGECKO_PAGES; page++) {
    if (page > 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const json = await withRetry(
      async () => {
        const res = await fetchImpl(marketsUrl(page), { headers, signal: AbortSignal.timeout(20_000) });
        throwIfRetryable(res);
        if (!res.ok) throw new HttpError(res.status);
        return res.json();
      },
      { label: "coingecko" },
    );
    out.push(...parseMarkets(json));
  }
  return out;
}
