/**
 * CoinGecko /coins/markets for the weekly crypto universe (docs/PHASE3-PREP.md P3-0e).
 * LOG ONLY. Free tier: top 500 by market cap in two pages of 250, about 3 s apart,
 * with the shared retry. An optional COINGECKO_API_KEY (demo key) is sent as
 * x-cg-demo-api-key.
 *
 * The markets response has no categories (checked against the saved NAS fixture), so
 * exclusions come from an explicit denylist plus name patterns. Every exclusion is
 * returned with its reason so the build can log it.
 */
import { withRetry, HttpError, throwIfRetryable } from "@/lib/yahoo-retry";

export interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
}

export const COINGECKO_PAGES = 2;
export const COINGECKO_PER_PAGE = 250;
export const COINGECKO_PAGE_DELAY_MS = 3_000;

/**
 * Not tradable risk assets for this purpose: stablecoins (USD, EUR and yield-bearing
 * dollars), wrapped/bridged coins, staked and liquid-staking tokens, exchange IOUs,
 * tokenized gold and tokenized funds. Upper-case CoinGecko symbols.
 */
export const CRYPTO_DENYLIST: Readonly<Record<string, string>> = Object.fromEntries([
  ...[
    "USDT", "USDC", "DAI", "FDUSD", "USDE", "TUSD", "PYUSD", "USDS", "USD1", "RLUSD", "USDG", "USDY", "USYC", "USDF",
    "BFUSD", "USDD", "OUSD", "USDGO", "GHO", "USD0", "EURC", "EURS", "EURSAFO", "FRAX", "LUSD", "CRVUSD", "SUSDE",
    "SUSDS", "SDAI", "USDB", "USDX", "USDP", "GUSD", "BUSD", "USDTB", "USDA", "USR", "DOLA", "FXUSD", "AUSD", "USDO",
  ].map((s) => [s, "stablecoin"]),
  ...["WBTC", "WETH", "CBBTC", "WBNB", "WSOL", "WTRX", "WAVAX", "WMATIC", "WPOL", "WEETH", "TBTC", "LBTC", "SOLVBTC", "BTCB", "WHYPE", "WSTUSR"].map((s) => [s, "wrapped"]),
  ...["STETH", "WSTETH", "RETH", "CBETH", "METH", "EZETH", "RSETH", "OSETH", "SFRXETH", "JITOSOL", "MSOL", "BNSOL", "JUPSOL", "STHYPE", "KHYPE", "BBSOL", "LSETH", "SAVAX", "STKAAVE"].map((s) => [s, "staked or liquid-staking"]),
  ...["XAUT", "PAXG", "KAU"].map((s) => [s, "tokenized gold"]),
  ...["BUIDL", "USTB", "JAAA", "FIGR_HELOC", "OUSG", "BENJI", "JTRSY", "STBT", "USCC"].map((s) => [s, "tokenized fund or credit"]),
  ...["BSC-USD"].map((s) => [s, "exchange IOU"]),
]);

const NAME_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(usd|eur|gbp|dollar|euro)\b|stablecoin|\bstables\b|\busd\d?\b/i, "stablecoin"],
  [/\bwrapped\b|\bbridged\b|\(wormhole\)|\(portal\)/i, "wrapped"],
  [/\bstaked\b|liquid staking|\brestaked\b/i, "staked or liquid-staking"],
  [/\btreasur(y|ies)\b|\bfund\b|\bmoney market\b|\bcredit\b/i, "tokenized fund or credit"],
  [/\bgold\b/i, "tokenized gold"],
];

/** Why a coin is excluded, or null if it may be a member. */
export function exclusionReason(c: Pick<CoinMarket, "symbol" | "name">): string | null {
  const sym = c.symbol.toUpperCase();
  if (CRYPTO_DENYLIST[sym]) return `${CRYPTO_DENYLIST[sym]} (denylist)`;
  for (const [re, why] of NAME_PATTERNS) if (re.test(c.name)) return `${why} (name "${c.name}")`;
  return null;
}

export function parseMarkets(json: unknown): CoinMarket[] {
  if (!Array.isArray(json)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return json.flatMap((r: Record<string, unknown>) =>
    typeof r?.id === "string" && typeof r?.symbol === "string"
      ? [{ id: r.id, symbol: r.symbol, name: typeof r.name === "string" ? r.name : r.id, current_price: num(r.current_price), market_cap: num(r.market_cap), total_volume: num(r.total_volume) }]
      : [],
  );
}

export function marketsUrl(page: number): string {
  return `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${COINGECKO_PER_PAGE}&page=${page}`;
}

export async function fetchCoinGeckoMarkets(
  opts: { apiKey?: string; fetchImpl?: typeof fetch; delayMs?: number } = {},
): Promise<CoinMarket[]> {
  const { apiKey = process.env.COINGECKO_API_KEY, fetchImpl = fetch, delayMs = COINGECKO_PAGE_DELAY_MS } = opts;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  const out: CoinMarket[] = [];
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
