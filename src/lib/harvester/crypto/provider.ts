/**
 * Crypto-universe provider choice (docs/PHASE3-PREP.md P3-0e step 1b, Chris 2026-11-24).
 * CRYPTO_UNIVERSE_PROVIDER = coingecko (default) or coinmarketcap. If the chosen provider
 * fails after its retries, the other one is used when its key is set, and the switch is
 * logged as `[crypto-universe] provider=<x> (fallback from <y>)`.
 */
import { fetchCoinGeckoMarkets } from "./coingecko";
import { fetchCmcListings } from "./coinmarketcap";
import type { CryptoListing, CryptoProvider } from "./listing";

export interface ProviderEnv {
  CRYPTO_UNIVERSE_PROVIDER?: string;
  COINGECKO_API_KEY?: string;
  COINMARKETCAP_API_KEY?: string;
}

export type ProviderFetchers = Record<CryptoProvider, () => Promise<CryptoListing[]>>;

export function chosenProvider(env: ProviderEnv): CryptoProvider {
  const v = env.CRYPTO_UNIVERSE_PROVIDER?.trim().toLowerCase();
  if (v && v !== "coingecko" && v !== "coinmarketcap") console.warn(`[crypto-universe] unknown CRYPTO_UNIVERSE_PROVIDER "${v}", using coingecko`);
  return v === "coinmarketcap" ? "coinmarketcap" : "coingecko";
}

const KEY: Record<CryptoProvider, keyof ProviderEnv> = { coingecko: "COINGECKO_API_KEY", coinmarketcap: "COINMARKETCAP_API_KEY" };

export async function fetchCryptoListings(
  env: ProviderEnv = process.env as ProviderEnv,
  fetchers: ProviderFetchers = {
    coingecko: () => fetchCoinGeckoMarkets({ apiKey: env.COINGECKO_API_KEY }),
    coinmarketcap: () => fetchCmcListings({ apiKey: env.COINMARKETCAP_API_KEY }),
  },
): Promise<{ provider: CryptoProvider; listings: CryptoListing[] }> {
  const first = chosenProvider(env);
  const other: CryptoProvider = first === "coingecko" ? "coinmarketcap" : "coingecko";
  try {
    const listings = await fetchers[first]();
    console.log(`[crypto-universe] provider=${first}, ${listings.length} listings`);
    return { provider: first, listings };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!env[KEY[other]]) throw new Error(`${first} failed (${why}) and ${KEY[other]} is not set for a fallback`);
    console.warn(`[crypto-universe] ${first} failed: ${why}`);
    const listings = await fetchers[other]();
    console.log(`[crypto-universe] provider=${other} (fallback from ${first}), ${listings.length} listings`);
    return { provider: other, listings };
  }
}
