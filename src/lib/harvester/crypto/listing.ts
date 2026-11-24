/**
 * One normalized crypto listing for the weekly crypto universe (docs/PHASE3-PREP.md
 * P3-0e step 1b), whichever provider supplied it, plus the exclusion rules that run on
 * it. Exclusions come from provider tags (CoinMarketCap `tags`; CoinGecko categories
 * when a response has them, which /coins/markets does not), then an explicit denylist,
 * then name patterns. Every exclusion carries its reason so the build can log it.
 */
export type CryptoProvider = "coingecko" | "coinmarketcap";

export interface CryptoListing {
  /** Provider id: the CoinGecko id, or `cmc:<id>` for CoinMarketCap. Stored in UniverseMember.coingeckoId. */
  id: string;
  symbol: string;
  name: string;
  marketCap: number | null;
  price: number | null;
  tags: string[];
}

/**
 * Provider tags that mark a non-member: any `*stablecoin` tag (not `stablecoin-protocol`),
 * wrapped tokens, liquid staking (not plain `staking`, which proof-of-stake chains such
 * as ADA carry), tokenized gold, commodities, treasuries, stocks and ETFs.
 */
const TAG_REASONS: ReadonlyArray<[RegExp, string]> = [
  [/^(.+-)?stablecoins?$/, "stablecoin"],
  [/^wrapped(-tokens)?$/, "wrapped"],
  [/^(liquid-staking(-derivatives|-tokens)?|liquid-restaking(-tokens)?|liquid-staked-.+)$/, "staked or liquid-staking"],
  [/^tokenized-(gold|commodities)$/, "tokenized gold"],
  [/^tokenized-(treasury-bonds|treasury-bills|stock|etfs|funds)$/, "tokenized fund or credit"],
];

export function tagReason(tag: string): string | null {
  const t = tag.toLowerCase();
  for (const [re, why] of TAG_REASONS) if (re.test(t)) return why;
  return null;
}

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
export function exclusionReason(c: Pick<CryptoListing, "symbol" | "name"> & { tags?: readonly string[] }): string | null {
  for (const t of c.tags ?? []) {
    const why = tagReason(t);
    if (why) return `${why} (tag ${t})`;
  }
  const sym = c.symbol.toUpperCase();
  if (CRYPTO_DENYLIST[sym]) return `${CRYPTO_DENYLIST[sym]} (denylist)`;
  for (const [re, why] of NAME_PATTERNS) if (re.test(c.name)) return `${why} (name "${c.name}")`;
  return null;
}

