import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCoinGeckoMarkets, parseMarkets } from "@/lib/harvester/crypto/coingecko";
import { exclusionReason, type CryptoListing } from "@/lib/harvester/crypto/listing";
import {
  BTC_SYMBOL,
  CRYPTO_HV_SCALE,
  CRYPTO_RULE,
  buildCryptoUniverse,
  computeCryptoSnapshotRows,
  cryptoSnapshotRow,
  evaluateCryptoCandidate,
  medianDollarVolume20d,
  parseCryptoBars,
  searchAlternatives,
  utcDate,
} from "@/lib/harvester/crypto/universe";
import { computeBarFeatures } from "@/lib/harvester/universe/bar-features";
import { buildUniverseRows, type StoredSnapshotRow } from "@/lib/eval/universe-dataset";
import { LookAheadError } from "@/lib/eval/dataset";
import { candidateKeys } from "@/lib/eval/features";
import { markdownReport } from "@/lib/eval/report";
import { analyzeScan, flagsFor, renderText } from "@/lib/health/harvest-health";

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8")) as unknown;
const coins: CryptoListing[] = [1, 2].flatMap((p) => parseMarkets(fx(`coingecko/markets-page${p}.json`)));
const coin = (id: string) => coins.find((c) => c.id === id)!;
const btcChart = fx("crypto/chart-BTC-USD-3mo.json");
const ethChart = fx("crypto/chart-ETH-USD-3mo.json");
// The fixtures were saved 2026-11-24 ~21:16 UTC, so 2026-11-24's bar is still open.
const NOW = new Date("2026-11-24T21:20:00Z");
const btc = parseCryptoBars(btcChart, NOW);
const eth = parseCryptoBars(ethChart, NOW);

describe("CoinGecko markets (saved NAS response)", () => {
  it("parses both pages: 500 coins, BTC first", () => {
    expect(coins).toHaveLength(500);
    expect(coins[0]).toMatchObject({ id: "bitcoin", symbol: "btc" });
  });

  it("sends the demo key header when set, pages ~3 s apart (here 0), and retries a 429", async () => {
    const page = readFileSync(join(__dirname, "fixtures/coingecko/markets-page1.json"), "utf8");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockImplementation(async () => new Response(page, { status: 200 }));
    const out = await fetchCoinGeckoMarkets({ apiKey: "demo", fetchImpl, delayMs: 0 });
    expect(out).toHaveLength(500); // page 2 returns the same fixture here
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][1].headers["x-cg-demo-api-key"]).toBe("demo");
    expect(fetchImpl.mock.calls[2][0]).toMatch(/page=2/);
  });
});

describe("exclusion list", () => {
  it("excludes stablecoins, wrapped, staked, gold and fund tokens, with a reason", () => {
    for (const [symbol, name, why] of [
      ["usdt", "Tether", /stablecoin/],
      ["usdc", "USDC", /stablecoin/],
      ["wbtc", "Wrapped Bitcoin", /wrapped/],
      ["steth", "Lido Staked Ether", /staked/],
      ["xaut", "Tether Gold", /gold/],
      ["buidl", "BlackRock USD Institutional Digital Liquidity Fund", /stablecoin|fund/],
      ["foo", "Wrapped Foo", /wrapped/],
      ["bar", "Some Treasury Token", /fund/],
    ] as const) {
      expect(exclusionReason({ symbol, name })).toMatch(why);
    }
    for (const id of ["bitcoin", "ethereum", "solana", "dogecoin", "chainlink"]) expect(exclusionReason(coin(id))).toBeNull();
  });

  it("every $500M+ coin in the fixture priced within 2% of $1 is excluded (stablecoin catch-all)", () => {
    const pegged = coins.filter((c) => (c.marketCap ?? 0) >= CRYPTO_RULE.minMarketCap && c.price != null && Math.abs(c.price - 1) < 0.02);
    expect(pegged.length).toBeGreaterThan(10);
    expect(pegged.filter((c) => exclusionReason(c) == null).map((c) => c.id)).toEqual([]);
  });
});

describe("UTC day completion", () => {
  it("keeps a bar only once its UTC day has ended, and dates it by UTC", () => {
    expect(utcDate(btc.at(-1)!.time!)).toBe("2026-11-23");
    const after = parseCryptoBars(btcChart, new Date("2026-11-25T00:00:00Z"));
    expect(utcDate(after.at(-1)!.time!)).toBe("2026-11-24");
    // moved to 12:00 UTC of its own day, so ET-based code dates it on the UTC day
    expect(btc.every((b) => b.time! % 86_400 === 43_200)).toBe(true);
    expect(computeBarFeatures(btc).bar_date).toBe("2026-11-23");
  });
});

describe("weekly and monthly opens across a weekend", () => {
  const dateOf = (i: number) => utcDate(btc[i].time!);
  it("week open is the UTC Monday bar's open, even on Saturday and Sunday", () => {
    const sun = btc.map((b, i) => i).filter((i) => new Date(btc[i].time! * 1000).getUTCDay() === 0).at(-1)!;
    const mon = sun - 6;
    expect(new Date(btc[mon].time! * 1000).getUTCDay()).toBe(1);
    for (const end of [sun - 1, sun]) {
      const f = computeBarFeatures(btc.slice(0, end + 1));
      expect(f.bar_date).toBe(dateOf(end));
      expect(f.week_open).toBe(btc[mon].open);
    }
    // the next Monday starts a new week
    expect(computeBarFeatures(btc.slice(0, sun + 2)).week_open).toBe(btc[sun + 1].open);
  });

  it("month open is the first UTC day's bar", () => {
    const first = btc.findIndex((b) => utcDate(b.time!) === "2026-11-01");
    expect(first).toBeGreaterThan(0);
    expect(computeBarFeatures(btc).month_open).toBe(btc[first].open);
  });
});

describe("CoinGecko → Yahoo mapping", () => {
  it("BTC maps to BTC-USD and passes every filter", () => {
    const r = evaluateCryptoCandidate(coin("bitcoin"), btcChart, NOW);
    expect(r).toMatchObject({ kind: "member", member: { symbol: "BTC-USD", coingeckoId: "bitcoin" } });
  });

  it("a chart for a different asset fails the ±5% price check and is dropped with a reason", () => {
    const r = evaluateCryptoCandidate(coin("bitcoin"), ethChart, NOW);
    expect(r.kind).toBe("dropped");
    expect(r.kind !== "member" && r.reason).toMatch(/price mismatch.*different asset/);
  });

  it("missing and stale charts are dropped", () => {
    expect(evaluateCryptoCandidate(coin("bitcoin"), null, NOW)).toMatchObject({ kind: "dropped" });
    const later = new Date("2026-11-28T00:00:00Z"); // last complete bar 2026-11-24 is 4 days old
    expect(evaluateCryptoCandidate(coin("bitcoin"), btcChart, later)).toMatchObject({ kind: "dropped", reason: expect.stringMatching(/stale/) });
  });

  it("Yahoo search alternatives: same symbol with Yahoo's number, USD only, crypto only", () => {
    expect(searchAlternatives({ symbol: "uni" }, fx("crypto/search-uniswap.json"))).toEqual(["UNI7083-USD"]);
    expect(searchAlternatives({ symbol: "aave" }, fx("crypto/search-uniswap.json"))).toEqual([]);
  });

  it("build: tries <SYMBOL>-USD, falls back to search, logs exclusions and drops", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const uni = { ...coin("uniswap") };
    const charts: Record<string, unknown> = { "BTC-USD": btcChart, "ETH-USD": ethChart, "UNI7083-USD": structuredClone(btcChart) };
    // UNI7083-USD stands in with BTC's bars at UNI's price
    (charts["UNI7083-USD"] as { chart: { result: Array<{ meta: { regularMarketPrice: number } }> } }).chart.result[0].meta.regularMarketPrice = uni.price!;
    const res = await buildCryptoUniverse({
      fetchMarkets: async () => [coin("bitcoin"), coin("ethereum"), coin("tether"), uni],
      fetchChart: async (s) => charts[s] ?? null,
      searchYahoo: async () => fx("crypto/search-uniswap.json"),
      now: () => NOW,
    });
    expect(res.members.map((m) => m.symbol)).toEqual(["BTC-USD", "ETH-USD", "UNI7083-USD"]);
    expect(res.excluded).toEqual([expect.objectContaining({ id: "tether", reason: expect.stringMatching(/stablecoin/) })]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/excluded tether.*stablecoin/);
    expect(log.mock.calls.flat().join("\n")).toMatch(/uniswap: UNI-USD failed .*using UNI7083-USD/);
    log.mockRestore();
  });
});

describe("liquidity filters on fixture bars", () => {
  it("dollar volume is the median of the last 20 USD volumes (Yahoo crypto volume is already USD)", () => {
    const v = btc.slice(-20).map((b) => b.volume).sort((a, b) => a - b);
    expect(medianDollarVolume20d(btc)).toBe((v[9] + v[10]) / 2);
    expect(medianDollarVolume20d(btc)!).toBeGreaterThan(1e9);
  });

  it("thin volume or low volatility is filtered out", () => {
    const thin = structuredClone(btcChart) as { chart: { result: Array<{ indicators: { quote: Array<{ volume: number[] }> } }> } };
    const q = thin.chart.result[0].indicators.quote[0];
    q.volume = q.volume.map((v) => (v == null ? v : 1e6));
    expect(evaluateCryptoCandidate(coin("bitcoin"), thin, NOW)).toMatchObject({ kind: "filtered", reason: expect.stringMatching(/dollar volume/) });

    const flat = structuredClone(btcChart) as { chart: { result: Array<{ indicators: { quote: Array<Record<string, number[]>> } }> } };
    const f = flat.chart.result[0].indicators.quote[0];
    for (const k of ["open", "high", "low", "close"]) f[k] = f[k].map((v, i) => (v == null ? v : 60_000 * (1 + 0.0005 * (i % 2))));
    expect(evaluateCryptoCandidate(coin("bitcoin"), flat, NOW)).toMatchObject({ kind: "filtered", reason: expect.stringMatching(/ATR/) });

    expect(evaluateCryptoCandidate({ ...coin("bitcoin"), marketCap: 4e8 }, btcChart, NOW)).toMatchObject({ kind: "filtered" });
  });
});

describe("crypto snapshot rows and the BTC benchmark", () => {
  const ethRow = cryptoSnapshotRow("ETH-USD", eth, btc)!;
  const btcRow = cryptoSnapshotRow(BTC_SYMBOL, btc, btc)!;

  it("uses btc_* keys, never spy_*, with the UTC session date", () => {
    expect(ethRow.assetClass).toBe("crypto");
    expect(ethRow.sessionDate).toBe("2026-11-23");
    expect(Object.keys(ethRow.features).some((k) => k.includes("spy"))).toBe(false);
    expect(ethRow.features.btc_return_20d).toBe(btcRow.features.return_20d);
    expect(ethRow.features.rs_vs_btc_20d).toBeCloseTo((ethRow.features.return_20d as number) - (btcRow.features.return_20d as number), 12);
    expect(ethRow.features).not.toHaveProperty("sector_etf");
    expect(typeof ethRow.features.stp_ma_state).toBe("number");
  });

  it("HV20 annualizes with √365 on crypto rows and in the filter; stocks keep √252", () => {
    const closes = btc.map((b) => b.close);
    const rets = closes.slice(-21).slice(1).map((c, i) => Math.log(c / closes.slice(-21)[i]));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    expect(btcRow.features.hv20).toBeCloseTo(sd * Math.sqrt(365), 12);
    expect(computeBarFeatures(btc).hv20).toBeCloseTo(sd * Math.sqrt(252), 12); // shared stock code unchanged
    const r = evaluateCryptoCandidate(coin("bitcoin"), btcChart, NOW);
    expect(r.kind === "member" && r.member.hv20).toBeCloseTo(sd * Math.sqrt(365), 12);
    expect(CRYPTO_HV_SCALE).toBeCloseTo(Math.sqrt(365 / 252), 15);
  });

  it("computeCryptoSnapshotRows always includes BTC, and nothing at all without a crypto universe", async () => {
    const charts: Record<string, unknown> = { "BTC-USD": btcChart, "ETH-USD": ethChart };
    const { rows, missing } = await computeCryptoSnapshotRows(["ETH-USD", "NOPE-USD"], async (s) => charts[s] ?? null, NOW);
    expect(rows.map((r) => r.symbol)).toEqual(["BTC-USD", "ETH-USD"]);
    expect(missing).toBe(1);
    expect(await computeCryptoSnapshotRows([], async () => btcChart, NOW)).toEqual({ rows: [], missing: 0 });
  });

  // Weekday harvest rows at 8:30 ET: each scan describes the previous UTC day.
  const sessions = btc.slice(-40).map((b) => utcDate(b.time!));
  const stored = (sym: string, bars: typeof btc): StoredSnapshotRow[] =>
    sessions.map((d) => {
      const slice = bars.filter((b) => utcDate(b.time!) <= d);
      const row = cryptoSnapshotRow(sym, slice, btc.filter((b) => utcDate(b.time!) <= d))!;
      const scanStartedAt = new Date(new Date(`${d}T13:30:00Z`).getTime() + 86_400_000);
      return { scanId: `s-${d}`, scanStartedAt, symbol: sym, sessionDate: d, close: row.close, features: row.features, regimeFeatures: null, assetClass: "crypto" };
    });
  const rows = [...stored(BTC_SYMBOL, btc), ...stored("ETH-USD", eth)];
  const btcCloses = rows.filter((r) => r.symbol === BTC_SYMBOL).map((r) => ({ date: r.sessionDate, close: r.close }));

  it("harness: BTC is the benchmark and is left out of the rows; excess = return − BTC return", () => {
    const ev = buildUniverseRows(rows, btcCloses, { crypto: true, benchmark: BTC_SYMBOL });
    expect(new Set(ev.map((r) => r.symbol))).toEqual(new Set(["ETH-USD"]));
    const r = ev[0];
    const i = sessions.indexOf(r.attrs.bar_date as string);
    const c = (sym: string, k: number) => rows.find((x) => x.symbol === sym && x.sessionDate === sessions[k])!.close;
    expect(r.excess["7d"]).toBeCloseTo(c("ETH-USD", i + 7) / c("ETH-USD", i) - 1 - (c(BTC_SYMBOL, i + 7) / c(BTC_SYMBOL, i) - 1), 12);
  });

  it("harness: crypto rows never pool with stock datasets, and stock rows never enter crypto", () => {
    const stock: StoredSnapshotRow = { ...rows[0], scanId: "live", symbol: "AMD", assetClass: "stock", features: { rsi14: 50 } };
    expect(buildUniverseRows([...rows, stock], btcCloses).map((r) => r.symbol)).toEqual(["AMD"]);
    expect(buildUniverseRows([...rows, stock], btcCloses, { crypto: true, benchmark: BTC_SYMBOL }).some((r) => r.symbol === "AMD")).toBe(false);
  });

  it("harness: refuses a crypto row whose session is after its scan date (look-ahead)", () => {
    const bad = rows.map((r, k) => (k === 45 ? { ...r, scanStartedAt: new Date(`${r.sessionDate}T00:00:00Z`) } : r));
    // 00:00 UTC on D is the evening of D−1 in ET, before the session it claims to describe
    expect(() => buildUniverseRows(bad, btcCloses, { crypto: true, benchmark: BTC_SYMBOL })).toThrow(LookAheadError);
  });

  it("pre-registered keys: 22 bar (btc_* in place of spy_*) + 4 STP = 26", () => {
    const keys = candidateKeys(buildUniverseRows(rows, btcCloses, { crypto: true, benchmark: BTC_SYMBOL }));
    expect(keys).toHaveLength(26);
    expect(keys).toContain("rs_vs_btc_20d");
    expect(keys).toContain("btc_return_20d");
    expect(markdownReport([], { date: "d", commit: "c", rows: 0, scans: 0, dataset: "crypto" })).toMatch(/excess return vs BTC/);
  });

  it("health report: crypto line with members, rows and null rates; warns when members have no rows", () => {
    const base = { scanId: "s1", startedAt: NOW, universeSize: 1500, regimeFeatures: { a: 1 }, sectorRotation: { a: 1 }, stpRows: 10, tickers: [], snapshot: [] };
    const ok = analyzeScan({ ...base, cryptoSnapshot: [btcRow.features, ethRow.features], cryptoMembers: 2 });
    expect(renderText([ok], [])).toMatch(/\[crypto\] 2 members, 2 snapshot rows; coverage bar 100%, stp 100%/);
    expect(renderText([ok], [])).toMatch(/rs_vs_btc_20d/);
    const missing = analyzeScan({ ...base, cryptoSnapshot: [], cryptoMembers: 41 });
    expect(flagsFor([missing]).map((f) => f.message)).toContain("crypto snapshot missing (41 crypto members, no rows)");
  });
});
