import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMarkets } from "@/lib/harvester/crypto/coingecko";
import { fetchCmcListings, parseCmcListings, CMC_URL } from "@/lib/harvester/crypto/coinmarketcap";
import { exclusionReason, tagReason, type CryptoListing } from "@/lib/harvester/crypto/listing";
import { chosenProvider, fetchCryptoListings } from "@/lib/harvester/crypto/provider";
import { evaluateCryptoCandidate } from "@/lib/harvester/crypto/universe";

const raw = (f: string) => readFileSync(join(__dirname, "fixtures", f), "utf8");
const cmcJson = JSON.parse(raw("coinmarketcap/listings-latest.json")) as unknown;
const cmc = parseCmcListings(cmcJson);
const cg = [1, 2].flatMap((p) => parseMarkets(JSON.parse(raw(`coingecko/markets-page${p}.json`))));
const bySym = (l: CryptoListing[], s: string) => l.find((c) => c.symbol.toUpperCase() === s)!;

describe("CoinMarketCap parser (saved NAS response)", () => {
  it("normalizes 500 listings: cmc:<id>, symbol, name, USD market cap and price, tags", () => {
    expect(cmc).toHaveLength(500);
    expect(cmc[0]).toMatchObject({ id: "cmc:1", symbol: "BTC", name: "Bitcoin" });
    expect(cmc[0].marketCap).toBeGreaterThan(1e12);
    expect(cmc[0].price).toBeGreaterThan(50_000);
    expect(cmc[0].tags).toContain("layer-1");
  });

  it("CoinGecko normalizes to the same shape (no categories in /coins/markets, so empty tags)", () => {
    expect(cg[0]).toMatchObject({ id: "bitcoin", symbol: "btc", name: "Bitcoin", tags: [] });
    expect(Object.keys(cg[0]).sort()).toEqual(Object.keys(cmc[0]).sort());
  });

  it("sends the key as X-CMC_PRO_API_KEY and refuses a non-zero error_code or a missing key", async () => {
    const fetchImpl = vi.fn(async () => new Response(raw("coinmarketcap/listings-latest.json"), { status: 200 }));
    expect(await fetchCmcListings({ apiKey: "k", fetchImpl })).toHaveLength(500);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(CMC_URL);
    expect(init.headers["X-CMC_PRO_API_KEY"]).toBe("k");
    const bad = vi.fn(async () => new Response(JSON.stringify({ status: { error_code: 1002, error_message: "API key missing." }, data: [] }), { status: 200 }));
    await expect(fetchCmcListings({ apiKey: "k", fetchImpl: bad })).rejects.toThrow(/error_code 1002/);
    await expect(fetchCmcListings({ apiKey: "", fetchImpl })).rejects.toThrow(/COINMARKETCAP_API_KEY/);
  });
});

describe("exclusions from CMC tags", () => {
  it("stablecoin, tokenized gold and treasury tags exclude; plain staking and RWA-protocol tags don't", () => {
    expect(exclusionReason(bySym(cmc, "USDT"))).toMatch(/stablecoin \(tag/);
    expect(exclusionReason(bySym(cmc, "XAUT"))).toMatch(/gold/);
    expect(exclusionReason(bySym(cmc, "RWUSD"))).toMatch(/fund or credit \(tag tokenized-treasury-bonds\)/);
    for (const s of ["ADA", "NEAR", "LINK", "ONDO", "BTC", "ETH"]) expect(exclusionReason(bySym(cmc, s))).toBeNull();
    expect(tagReason("stablecoin-protocol")).toBeNull();
    expect(tagReason("liquid-staking-derivatives")).toMatch(/staked/);
    expect(tagReason("restaking")).toBeNull();
  });

  it("work the same on both fixtures: every $500M+ coin in both is excluded by both or by neither", () => {
    const big = (l: CryptoListing[]) => new Map(l.filter((c) => (c.marketCap ?? 0) >= 5e8).map((c) => [c.symbol.toUpperCase(), c]));
    const a = big(cg);
    const b = big(cmc);
    const common = [...a.keys()].filter((s) => b.has(s));
    expect(common.length).toBeGreaterThan(70);
    const differ = common.filter((s) => (exclusionReason(a.get(s)!) == null) !== (exclusionReason(b.get(s)!) == null));
    expect(differ).toEqual([]);
    // and both catch every $1-pegged coin of their own
    for (const l of [cg, cmc]) {
      const pegged = l.filter((c) => (c.marketCap ?? 0) >= 5e8 && c.price != null && Math.abs(c.price - 1) < 0.02);
      expect(pegged.filter((c) => exclusionReason(c) == null).map((c) => c.symbol)).toEqual([]);
    }
  });

  it("a CMC member stores cmc:<id> in coingeckoId", () => {
    const btcChart = JSON.parse(raw("crypto/chart-BTC-USD-3mo.json")) as unknown;
    const r = evaluateCryptoCandidate(bySym(cmc, "BTC"), btcChart, new Date("2026-11-24T21:20:00Z"));
    expect(r).toMatchObject({ kind: "member", member: { symbol: "BTC-USD", coingeckoId: "cmc:1" } });
  });
});

describe("provider choice and fallback", () => {
  const ok = (n: number) => vi.fn(async () => Array.from({ length: n }, (_, i) => ({ ...cmc[i] })));
  const fail = () => vi.fn(async (): Promise<CryptoListing[]> => { throw new Error("HTTP 503"); });

  it("defaults to coingecko; accepts coinmarketcap; unknown values fall back to coingecko", () => {
    expect(chosenProvider({})).toBe("coingecko");
    expect(chosenProvider({ CRYPTO_UNIVERSE_PROVIDER: " CoinMarketCap " })).toBe("coinmarketcap");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(chosenProvider({ CRYPTO_UNIVERSE_PROVIDER: "kraken" })).toBe("coingecko");
    warn.mockRestore();
  });

  it("coingecko → coinmarketcap when CoinGecko fails and the CMC key is set, logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = { coingecko: fail(), coinmarketcap: ok(3) };
    const r = await fetchCryptoListings({ COINMARKETCAP_API_KEY: "k" }, f);
    expect(r.provider).toBe("coinmarketcap");
    expect(r.listings).toHaveLength(3);
    expect(log.mock.calls.flat().join("\n")).toMatch(/\[crypto-universe\] provider=coinmarketcap \(fallback from coingecko\)/);
    log.mockRestore();
    warn.mockRestore();
  });

  it("coinmarketcap → coingecko when CMC fails and the CoinGecko key is set, logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = { coingecko: ok(2), coinmarketcap: fail() };
    const r = await fetchCryptoListings({ CRYPTO_UNIVERSE_PROVIDER: "coinmarketcap", COINMARKETCAP_API_KEY: "k", COINGECKO_API_KEY: "d" }, f);
    expect(r.provider).toBe("coingecko");
    expect(log.mock.calls.flat().join("\n")).toMatch(/provider=coingecko \(fallback from coinmarketcap\)/);
    log.mockRestore();
    warn.mockRestore();
  });

  it("no fallback without the other key; the chosen provider is used when it works", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(fetchCryptoListings({}, { coingecko: fail(), coinmarketcap: ok(1) })).rejects.toThrow(/COINMARKETCAP_API_KEY is not set/);
    const f = { coingecko: ok(4), coinmarketcap: ok(1) };
    expect((await fetchCryptoListings({ COINMARKETCAP_API_KEY: "k" }, f)).provider).toBe("coingecko");
    expect(f.coinmarketcap).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
