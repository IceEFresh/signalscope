/**
 * Weekly liquid-crypto universe (docs/PHASE3-PREP.md P3-0e). LOG ONLY: no score,
 * stage, label or recommendation reads crypto, and crypto never enters ValidatedTicker.
 *
 * CoinGecko or CoinMarketCap top 500 (provider.ts) → exclusions (stablecoins, wrapped, staked, IOUs, tokenized
 * gold/funds) → Yahoo `<SYMBOL>-USD` chart → drop missing, stale or wrong-asset
 * charts → the stock rule's market cap, dollar-volume and volatility bars. No price
 * floor and no options rule.
 *
 * Yahoo crypto daily bars run 00:00–24:00 UTC, 7 days a week, and their volume is
 * already in USD (BTC-USD's volume matches CoinGecko's total_volume), so dollar
 * volume is the bar's volume, not close × volume.
 */
import { computeBarMetrics, parseChartBars, type DailyBar } from "../universe/bar-metrics";
import { computeStp } from "../universe/stp";
import { snapshotRow, type SnapshotRow } from "../universe/snapshot";
import { liveStpKeys } from "../universe/stp-live";
import { exclusionReason, type CryptoListing } from "./listing";

export const CRYPTO_RULE = {
  minMarketCap: 500_000_000,
  /** Median of the last 20 daily USD volumes, from Yahoo bars. */
  minMedianDollarVolume20d: 25_000_000,
  minAtrPct: 0.03,
  minHv20: 0.4,
  /** The last complete bar must be at most this many UTC days old. */
  maxStaleDays: 2,
  /** Yahoo price within ±5% of the provider's, else it's a different asset. */
  maxPriceMismatch: 0.05,
} as const;

export const BTC_SYMBOL = "BTC-USD";
/**
 * Crypto trades every day, so its HV20 annualizes with √365 (Chris, PR #45). The shared
 * stock code uses √252; crypto rows rescale it by √(365/252). Stocks are unchanged.
 */
export const CRYPTO_HV_SCALE = Math.sqrt(365 / 252);
const DAY_S = 86_400;

/** First-choice Yahoo symbol for a listing; see searchAlternatives for Yahoo's numbered tickers. */
export function yahooSymbolFor(c: Pick<CryptoListing, "symbol">): string {
  return `${c.symbol.toUpperCase()}-USD`;
}

export const utcDate = (unixS: number): string => new Date(unixS * 1000).toISOString().slice(0, 10);

/**
 * Complete crypto daily bars: a bar counts only once its UTC day has ended at `now`.
 * Each bar's time is moved to 12:00 UTC of its own day, so the shared bar-feature and
 * STP code (which dates bars in ET) dates it on its UTC day, and the weekly and
 * monthly opens are the UTC Monday and first-of-month bars.
 */
export function parseCryptoBars(json: unknown, now: Date): DailyBar[] {
  const nowS = now.getTime() / 1000;
  // Date(0): keep every bar here; UTC-day completion is decided below.
  return parseChartBars(json, new Date(0)).flatMap((b) => {
    if (b.time == null) return [];
    const dayStart = Math.floor(b.time / DAY_S) * DAY_S;
    if (dayStart + DAY_S > nowS) return [];
    return [{ ...b, time: dayStart + DAY_S / 2 }];
  });
}

export function medianDollarVolume20d(bars: readonly DailyBar[]): number | null {
  if (bars.length < 20) return null;
  const v = bars.slice(-20).map((b) => b.volume).sort((a, b) => a - b);
  return (v[9] + v[10]) / 2;
}

export interface CryptoMemberData {
  symbol: string;
  coingeckoId: string;
  price: number | null;
  marketCap: number | null;
  dollarVolume20d: number | null;
  atrPct: number | null;
  hv20: number | null;
}

export type CryptoOutcome =
  | { kind: "member"; member: CryptoMemberData }
  | { kind: "excluded" | "dropped" | "filtered"; reason: string };

function regularMarketPrice(json: unknown): number | null {
  const p = (json as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: unknown } }> } } | null)?.chart?.result?.[0]?.meta?.regularMarketPrice;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

/** Decide one candidate from its provider listing and Yahoo chart (null = chart missing). Pure. */
export function evaluateCryptoCandidate(coin: CryptoListing, chart: unknown | null, now: Date, yahooSymbol = yahooSymbolFor(coin)): CryptoOutcome {
  const why = exclusionReason(coin);
  if (why) return { kind: "excluded", reason: why };
  const r = CRYPTO_RULE;
  if (coin.marketCap == null || coin.marketCap < r.minMarketCap) return { kind: "filtered", reason: "market cap under $500M" };
  const sym = yahooSymbol;
  if (chart == null) return { kind: "dropped", reason: `no Yahoo chart for ${sym}` };
  const bars = parseCryptoBars(chart, now);
  const last = bars.at(-1);
  if (!last?.time) return { kind: "dropped", reason: `Yahoo chart for ${sym} has no complete bars` };
  // Days between the bar's UTC date and today's (yesterday's bar = 1).
  const ageDays = Math.floor(now.getTime() / 1000 / DAY_S) - Math.floor(last.time / DAY_S);
  if (ageDays > r.maxStaleDays) return { kind: "dropped", reason: `Yahoo chart for ${sym} is stale (last bar ${utcDate(last.time)})` };
  const yPrice = regularMarketPrice(chart) ?? last.close;
  if (coin.price == null || coin.price <= 0) return { kind: "dropped", reason: "no provider price to match against" };
  const gap = Math.abs(yPrice / coin.price - 1);
  if (gap > r.maxPriceMismatch) {
    return { kind: "dropped", reason: `price mismatch: Yahoo ${sym} ${yPrice} vs ${coin.id} ${coin.price} (${(gap * 100).toFixed(1)}%), likely a different asset` };
  }
  const m = computeBarMetrics(bars);
  const hv20 = m.hv20 == null ? null : m.hv20 * CRYPTO_HV_SCALE;
  const dv = medianDollarVolume20d(bars);
  if (dv == null || dv < r.minMedianDollarVolume20d) return { kind: "filtered", reason: "20-day median dollar volume under $25M" };
  const volOk = (m.atrPct != null && m.atrPct >= r.minAtrPct) || (hv20 != null && hv20 >= r.minHv20);
  if (!volOk) return { kind: "filtered", reason: "ATR% under 3% and HV20 under 40%" };
  return {
    kind: "member",
    member: { symbol: sym, coingeckoId: coin.id, price: yPrice, marketCap: coin.marketCap, dollarVolume20d: dv, atrPct: m.atrPct, hv20 },
  };
}

/**
 * Yahoo suffixes colliding crypto tickers with a number (Uniswap is UNI7083-USD).
 * From a Yahoo search response, the CRYPTOCURRENCY quotes `<SYMBOL><digits>-USD` for
 * this coin's own symbol. Each one still has to pass the price check.
 */
export function searchAlternatives(coin: Pick<CryptoListing, "symbol">, searchJson: unknown): string[] {
  const quotes = (searchJson as { quotes?: Array<{ symbol?: unknown; quoteType?: unknown }> } | null)?.quotes ?? [];
  const sym = coin.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const re = new RegExp(`^${sym}\\d+-USD$`);
  return quotes
    .filter((q) => q.quoteType === "CRYPTOCURRENCY" && typeof q.symbol === "string" && re.test(q.symbol))
    .map((q) => q.symbol as string);
}

export interface CryptoBuildDeps {
  fetchMarkets: () => Promise<CryptoListing[]>;
  /** Yahoo chart JSON for a symbol, or null when it's missing. */
  fetchChart: (symbol: string) => Promise<unknown | null>;
  /** Yahoo search JSON for a coin name; used only when `<SYMBOL>-USD` fails. */
  searchYahoo?: (query: string) => Promise<unknown | null>;
  now?: () => Date;
}

export interface CryptoBuildResult {
  candidates: number;
  members: CryptoMemberData[];
  excluded: Array<{ id: string; symbol: string; reason: string }>;
  dropped: Array<{ id: string; symbol: string; reason: string }>;
}

/** Build the crypto universe. Every exclusion and drop is logged with its reason. */
export async function buildCryptoUniverse(deps: CryptoBuildDeps): Promise<CryptoBuildResult> {
  const now = deps.now?.() ?? new Date();
  const coins = await deps.fetchMarkets();
  const out: CryptoBuildResult = { candidates: coins.length, members: [], excluded: [], dropped: [] };
  let filtered = 0;
  const seen = new Set<string>();
  for (const c of coins) {
    // Charts only for coins that pass the cheap checks first.
    const cheapFail = exclusionReason(c) != null || c.marketCap == null || c.marketCap < CRYPTO_RULE.minMarketCap;
    let res = cheapFail ? evaluateCryptoCandidate(c, null, now) : null;
    if (!res) {
      const sym = yahooSymbolFor(c);
      if (seen.has(sym)) {
        out.dropped.push({ id: c.id, symbol: sym, reason: `duplicate Yahoo symbol ${sym} (a larger coin already took it)` });
        console.log(`[crypto-universe] dropped ${c.id}: duplicate Yahoo symbol ${sym}`);
        continue;
      }
      seen.add(sym);
      res = evaluateCryptoCandidate(c, await deps.fetchChart(sym).catch(() => null), now);
      if (res.kind === "dropped" && deps.searchYahoo) {
        const alts = searchAlternatives(c, await deps.searchYahoo(c.name).catch(() => null)).filter((a) => !seen.has(a));
        for (const alt of alts) {
          const r2 = evaluateCryptoCandidate(c, await deps.fetchChart(alt).catch(() => null), now, alt);
          if (r2.kind === "dropped") continue;
          seen.add(alt);
          console.log(`[crypto-universe] ${c.id}: ${sym} failed (${res.reason}), using ${alt} from Yahoo search`);
          res = r2;
          break;
        }
      }
    }
    if (res.kind === "member") out.members.push(res.member);
    else if (res.kind === "excluded") {
      out.excluded.push({ id: c.id, symbol: c.symbol.toUpperCase(), reason: res.reason });
      console.log(`[crypto-universe] excluded ${c.id} (${c.symbol.toUpperCase()}): ${res.reason}`);
    } else if (res.kind === "dropped") {
      out.dropped.push({ id: c.id, symbol: yahooSymbolFor(c), reason: res.reason });
      console.log(`[crypto-universe] dropped ${c.id}: ${res.reason}`);
    } else filtered++;
  }
  console.log(
    `[crypto-universe] candidates=${out.candidates} excluded=${out.excluded.length} dropped=${out.dropped.length} filtered=${filtered} members=${out.members.length}`,
  );
  return out;
}

/** Keys renamed on crypto rows: no SPY comparison is computed on crypto; BTC is the benchmark. */
export const CRYPTO_KEY_RENAMES: Readonly<Record<string, string>> = { spy_return_20d: "btc_return_20d", rs_vs_spy_20d: "rs_vs_btc_20d" };

/**
 * One crypto snapshot row from complete UTC-day bars (parseCryptoBars) and BTC's bars:
 * the shared 1a bar features and 1g STP states, with spy_* → btc_* and sessionDate =
 * the UTC date of the last complete bar. No sector or regime (stock-only). Pure.
 */
export function cryptoSnapshotRow(symbol: string, bars: readonly DailyBar[], btcBars: readonly DailyBar[] | null): SnapshotRow | null {
  const stp = computeStp(bars);
  const row = snapshotRow(symbol, bars, btcBars, stp);
  if (!row) return null;
  const last = bars.at(-1);
  if (last?.time == null || row.sessionDate !== utcDate(last.time)) return null; // dating guard: must be the bar's UTC day
  const features: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(row.features).map(([k, v]) => [CRYPTO_KEY_RENAMES[k] ?? k, v])),
    // P3-0i2: rolling opens at 7/30 bars, the fixed-rule size factors and swing scores (no pyramid or Finviz on crypto)
    ...liveStpKeys(bars, stp, { assetClass: "crypto" }),
  };
  if (typeof features.hv20 === "number") features.hv20 *= CRYPTO_HV_SCALE;
  return { ...row, features, assetClass: "crypto" };
}

/** Crypto snapshot rows for `symbols` (BTC always included), one 3-month chart each. */
export async function computeCryptoSnapshotRows(
  symbols: readonly string[],
  fetchChart: (symbol: string) => Promise<unknown | null>,
  now: Date = new Date(),
): Promise<{ rows: SnapshotRow[]; missing: number }> {
  if (symbols.length === 0) return { rows: [], missing: 0 }; // no crypto universe: no BTC row either
  const load = async (s: string) => {
    const json = await fetchChart(s).catch(() => null);
    return json ? parseCryptoBars(json, now) : null;
  };
  const btcBars = await load(BTC_SYMBOL);
  const rows: SnapshotRow[] = [];
  let missing = 0;
  for (const s of [...new Set([BTC_SYMBOL, ...symbols])]) {
    const bars = s === BTC_SYMBOL ? btcBars : await load(s);
    const row = bars && bars.length ? cryptoSnapshotRow(s, bars, btcBars) : null;
    if (row) rows.push(row);
    else missing++;
  }
  return { rows, missing };
}
