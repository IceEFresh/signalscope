/**
 * Harvester-side steps for PR 1-0, run by scripts/run-harvest-remote.ts:
 *   1. get the current universe and graduation watch from the web app,
 *   2. rebuild the universe when it is missing or older than 7 days,
 *   3. after signals are fetched, compute bar metrics and re-check the watch.
 *
 * Every step degrades instead of throwing: with no universe the harvest falls
 * back to the static SCAN_SYMBOLS list, exactly as before this PR.
 */
import { SCAN_SYMBOLS } from "../sources/ticker-utils";
import type { IngestBarMetrics, RawSignal, WatchCheck } from "../types";
import { fetchBarMetricsMany, parseChartBars, type BarMetrics } from "./bar-metrics";
import { computeBarFeatures, type BarFeatures } from "./bar-features";
import { computeStp, type StpResult } from "./stp";
import { computeRegime, REGIME_SYMBOLS, type RegimeFeatures } from "./regime";
import { computeMacro, missingMacroSeries, MACRO_SYMBOLS, type MacroFeatures, type MacroInput } from "./macro";
import { parseCryptoBars } from "../crypto/universe";
import { computeSectorRotation, INDUSTRY_ETFS, ROTATION_ETFS, SECTOR_ETFS, industryEtfFor, type SectorRotation } from "./sector-rotation";
import { etParts } from "./bar-metrics";
import { fetchOptionsRaw, normalizeChain, type NormalizedChain } from "../options-chain";
import { computeOptionsFeatures, daysToExpiry, MIN_NEAR_DAYS, pickExpiry, type OptionsFeatures } from "./options-features";
import { fetchDailyChart, fetchYahooChart, peekDailyChart } from "../yahoo-chart";
import { etfStates, MARKET_ETFS, type EtfState } from "./pyramid";
import type { LiveContext } from "./stp-live";
import { fetchCryptoListings } from "../crypto/provider";
import { buildCryptoUniverse } from "../crypto/universe";
import { buildUniverse, defaultDeps, evaluateSymbols, type UniverseBuildResult } from "./build";
import { applyWatchResults, type ActiveWatchRow } from "./watch";

export const UNIVERSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MemberProfiles = Record<string, { sector: string | null; industry: string | null }>;

export interface UniverseState {
  universe: { id: string; refreshedAt: string; symbols: string[]; profiles?: MemberProfiles; crypto?: string[] } | null;
  watch: ActiveWatchRow[];
}

export interface HarvestPrep {
  universeId: string | null;
  scanSymbols: readonly string[];
  /** P3-0d: sector and industry per universe member (empty with the static fallback or an old universe). */
  profiles: MemberProfiles;
  /** P3-0e: crypto members for the snapshot (log only, never scanned). */
  cryptoSymbols: string[];
  watch: ActiveWatchRow[];
}

export interface HarvestPrepDeps {
  getState: () => Promise<UniverseState>;
  build: () => Promise<UniverseBuildResult>;
  postBuild: (build: UniverseBuildResult) => Promise<string>;
  now?: () => Date;
}

/** /api/harvest/ingest → /api/harvest/universe, unless HARVEST_UNIVERSE_URL is set. */
export function universeUrlFrom(ingestUrl: string, override?: string): string {
  if (override) return override;
  return ingestUrl.replace(/\/ingest\/?$/, "/universe");
}

export function isStale(refreshedAt: string | undefined, now: Date): boolean {
  if (!refreshedAt) return true;
  const t = new Date(refreshedAt).getTime();
  return Number.isNaN(t) || now.getTime() - t > UNIVERSE_MAX_AGE_MS;
}

export async function prepareHarvest(deps: HarvestPrepDeps): Promise<HarvestPrep> {
  const now = deps.now?.() ?? new Date();
  let state: UniverseState = { universe: null, watch: [] };
  let stateLoaded = false;
  try {
    state = await deps.getState();
    stateLoaded = true;
  } catch (err) {
    console.warn("[universe] could not load universe state:", err instanceof Error ? err.message : err);
  }

  let universe = state.universe;
  if (!stateLoaded) {
    // The web app is unreachable, so the build could not be stored either: skip ~2k Yahoo calls.
    console.warn("[universe] skipping rebuild because the web app is unreachable");
  } else if (isStale(universe?.refreshedAt, now)) {
    console.log(`[universe] ${universe ? "stale" : "missing"}, rebuilding (weekly job)...`);
    try {
      const build = await deps.build();
      const id = await deps.postBuild(build);
      universe = {
        id,
        refreshedAt: now.toISOString(),
        symbols: build.members.map((m) => m.symbol),
        profiles: Object.fromEntries(
          build.members.filter((m) => m.sector || m.industry).map((m) => [m.symbol, { sector: m.sector ?? null, industry: m.industry ?? null }]),
        ),
        crypto: build.crypto?.map((c) => c.symbol) ?? [],
      };
    } catch (err) {
      console.warn("[universe] rebuild failed, keeping the previous universe:", err instanceof Error ? err.message : err);
    }
  }

  if (!universe || universe.symbols.length === 0) {
    console.warn(`[universe] none available, falling back to static SCAN_SYMBOLS (${SCAN_SYMBOLS.length})`);
    return { universeId: null, scanSymbols: SCAN_SYMBOLS, profiles: {}, cryptoSymbols: universe?.crypto ?? [], watch: state.watch };
  }
  return { universeId: universe.id, scanSymbols: universe.symbols, profiles: universe.profiles ?? {}, cryptoSymbols: universe.crypto ?? [], watch: state.watch };
}

export interface IngestExtras {
  barMetrics: Record<string, IngestBarMetrics>;
  /** PLAN.md 1a, log only. */
  barFeatures: Record<string, BarFeatures>;
  watchChecks: WatchCheck[];
  graduationSignals: RawSignal[];
}

/**
 * Bar metrics for every signal symbol and watched symbol (one chart call each),
 * then the full universe rule for watched symbols. Failures leave a symbol out.
 */
export async function computeIngestExtras(
  signals: readonly RawSignal[],
  watch: readonly ActiveWatchRow[],
  fetchMetrics: (symbols: string[]) => Promise<Map<string, BarMetrics>> = (s) => fetchBarMetricsMany(s, { label: "bars" }),
  evaluate: typeof evaluateSymbols = evaluateSymbols,
  now: Date = new Date(),
  fetchFeatures: (symbols: string[]) => Promise<Record<string, BarFeatures>> = featuresFromCachedCharts,
): Promise<IngestExtras> {
  const watchSymbols = [...new Set(watch.map((w) => w.symbol))];
  const symbols = [...new Set([...signals.map((s) => s.symbol), ...watchSymbols])];
  let metrics = new Map<string, BarMetrics>();
  try {
    metrics = await fetchMetrics(symbols);
  } catch (err) {
    console.warn("[bars] metrics fetch failed:", err instanceof Error ? err.message : err);
  }

  const barMetrics: Record<string, IngestBarMetrics> = {};
  for (const [sym, m] of metrics) {
    barMetrics[sym] = { dollarVolume20d: m.dollarVolume20d, atrPct: m.atrPct, hv20: m.hv20 };
  }

  // Bar features (1a) for signal symbols whose chart loaded: cache hits, plus one SPY chart.
  let barFeatures: Record<string, BarFeatures> = {};
  const signalSymbols = [...new Set(signals.map((s) => s.symbol))].filter((s) => metrics.has(s));
  try {
    barFeatures = await fetchFeatures(signalSymbols);
  } catch (err) {
    console.warn("[features] failed:", err instanceof Error ? err.message : err);
  }

  let watchChecks: WatchCheck[] = [];
  let graduationSignals: RawSignal[] = [];
  if (watchSymbols.length > 0) {
    try {
      const base = defaultDeps();
      const results = await evaluate(watchSymbols, {
        fetchQuotes: base.fetchQuotes,
        // Reuse the bars fetched above instead of a second chart call per symbol.
        fetchMetrics: async (s) => new Map(s.filter((x) => metrics.has(x)).map((x) => [x, metrics.get(x)!])),
        hasListedOptions: base.hasListedOptions,
      });
      ({ checks: watchChecks, signals: graduationSignals } = applyWatchResults(watch, results, now));
    } catch (err) {
      console.warn("[watch] re-check failed:", err instanceof Error ? err.message : err);
    }
  }
  console.log(
    `[bars] metrics for ${metrics.size}/${symbols.length} symbols, features for ${Object.keys(barFeatures).length}; [watch] ${watchChecks.length} checked, ${graduationSignals.length} graduated`,
  );
  return { barMetrics, barFeatures, watchChecks, graduationSignals };
}

/**
 * Compute 1a bar features from the per-run chart cache (no new requests for
 * symbols already fetched) plus SPY for relative strength.
 */
export async function featuresFromCachedCharts(symbols: string[]): Promise<Record<string, BarFeatures>> {
  const out: Record<string, BarFeatures> = {};
  if (symbols.length === 0) return out;
  const spy = await fetchDailyChart("SPY");
  const spyBars = spy.ok ? parseChartBars(spy.json) : null;
  if (!spyBars || spyBars.length === 0) console.warn("[features] SPY bars unavailable: rs_vs_spy_20d will be null");
  for (const s of symbols) {
    const res = await fetchDailyChart(s);
    if (res.ok) out[s] = computeBarFeatures(parseChartBars(res.json), spyBars);
  }
  return out;
}

/** Default prep deps that talk to the web app over HTTP with the harvest key. */
export function httpPrepDeps(universeUrl: string, apiKey: string): HarvestPrepDeps {
  const headers = { "Content-Type": "application/json", "x-harvest-key": apiKey };
  return {
    getState: async () => {
      const res = await fetch(universeUrl, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`GET ${universeUrl} returned ${res.status}`);
      return (await res.json()) as UniverseState;
    },
    build: async () => {
      const stock = await buildUniverse();
      // P3-0e: the crypto build never blocks the stock universe
      try {
        const crypto = await buildCryptoUniverse({
          fetchMarkets: async () => (await fetchCryptoListings()).listings,
          fetchChart: async (s) => {
            const r = await fetchDailyChart(s);
            return r.ok ? r.json : null;
          },
          searchYahoo: async (q) => {
            const r = await fetchYahooChart(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
            return r.ok ? r.json : null;
          },
        });
        return { ...stock, crypto: crypto.members };
      } catch (err) {
        console.warn("[crypto-universe] build failed, stock universe stored without crypto:", err instanceof Error ? err.message : err);
        return stock;
      }
    },
    postBuild: async (build) => {
      const res = await fetch(universeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          directoryCount: build.directoryCount,
          prefilterCount: build.prefilterCount,
          members: build.members,
          crypto: build.crypto,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`POST ${universeUrl} returned ${res.status}: ${await res.text().catch(() => "")}`);
      return ((await res.json()) as { id: string }).id;
    },
  };
}

/**
 * STP daily states and triggers (PLAN.md 1g, log only) for every scanned symbol:
 * the universe plus this run's signal symbols. Charts come from the per-run cache
 * (volume spike and bar metrics already fetched them); earnings timestamps come
 * from one quote batch per 50 symbols. A failure leaves a symbol out.
 */
export async function computeStpExtras(
  symbols: readonly string[],
  fetchQuotes: (s: string[]) => Promise<Map<string, { earningsTs?: number | null }>> = defaultDeps().fetchQuotes,
  getChart: typeof fetchDailyChart = fetchDailyChart,
): Promise<Record<string, StpResult>> {
  const list = [...new Set(symbols)];
  const out: Record<string, StpResult> = {};
  if (list.length === 0) return out;
  let quotes = new Map<string, { earningsTs?: number | null }>();
  try {
    quotes = await fetchQuotes(list);
  } catch (err) {
    console.warn("[stp] earnings quotes failed, EGOP off for this run:", err instanceof Error ? err.message : err);
  }
  let triggers = 0;
  for (const s of list) {
    try {
      const res = await getChart(s);
      if (!res.ok) continue;
      const r = computeStp(parseChartBars(res.json), quotes.get(s)?.earningsTs ?? null);
      out[s] = r;
      if (r.trigger) triggers++;
    } catch (err) {
      console.warn(`[stp] ${s} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[stp] states for ${Object.keys(out).length}/${list.length} symbols, ${triggers} triggers`);
  return out;
}

/**
 * Market regime fields for this scan (PLAN.md 1c, log only): SPY (cached for 1a),
 * ^VIX and TLT daily charts, so at most two new requests per run.
 */
export async function computeRegimeExtras(getChart: typeof fetchDailyChart = fetchDailyChart): Promise<RegimeFeatures> {
  const load = async (sym: string) => {
    try {
      const res = await getChart(sym);
      return res.ok ? parseChartBars(res.json) : null;
    } catch {
      return null;
    }
  };
  const [spy, vix, tlt] = await Promise.all([load(REGIME_SYMBOLS.spy), load(REGIME_SYMBOLS.vix), load(REGIME_SYMBOLS.tlt)]);
  if (!spy || !vix || !tlt) {
    console.warn(`[regime] missing bars: ${[!spy && "SPY", !vix && "^VIX", !tlt && "TLT"].filter(Boolean).join(", ")}`);
  }
  const r = computeRegime(spy, vix, tlt);
  console.log(`[regime] SPY vs SMA20 ${r.spy_close_vs_sma20?.toFixed(4) ?? "null"}, distribution days ${r.spy_distribution_days_25 ?? "null"}, VIX ${r.vix_close ?? "null"}`);
  return r;
}

/**
 * P3-0i2: ETF state maps for the live Power Pyramid keys, from this run's chart cache (the
 * sector-rotation fetch already loaded SPY, QQQ, DIA, the SPDRs and the industry ETFs).
 * Never makes a request; an ETF that isn't cached has no states (its layer logs null).
 */
export async function loadLiveEtfStates(peek: (s: string) => ReturnType<typeof peekDailyChart> = peekDailyChart): Promise<Map<string, Map<string, EtfState>>> {
  const out = new Map<string, Map<string, EtfState>>();
  const etfs = [...new Set([...MARKET_ETFS, ...Object.values(SECTOR_ETFS), ...Object.values(INDUSTRY_ETFS)])];
  for (const etf of etfs) {
    const p = peek(etf);
    if (!p) continue;
    try {
      const res = await p;
      if (res.ok) out.set(etf, etfStates(parseChartBars(res.json)));
    } catch {
      // not cached usefully: the layer logs null
    }
  }
  return out;
}

/** P3-0i2 live context for a stock: market ETFs plus its sector and industry ETF states. */
export function liveContextFor(symbol: string, profiles: MemberProfiles, states: ReadonlyMap<string, ReadonlyMap<string, EtfState>>): LiveContext {
  const p = profiles[symbol];
  const sectorEtf = p?.sector ? SECTOR_ETFS[p.sector] ?? null : null;
  const industryEtf = industryEtfFor(p?.industry);
  return {
    assetClass: "stock",
    market: MARKET_ETFS.map((e) => states.get(e) ?? null),
    sectorEtf,
    sectorStates: sectorEtf ? states.get(sectorEtf) ?? null : null,
    industryEtf,
    industryStates: industryEtf ? states.get(industryEtf) ?? null : null,
  };
}

/**
 * Macro context for this scan (P3-0f, log only). One cached 3-month chart per macro
 * series; GLD and DBB come from the sector-rotation fetch when it ran first, BTC-USD
 * from the crypto snapshot. A missing series gives null fields and a warning.
 */
export async function computeMacroExtras(getChart: typeof fetchDailyChart = fetchDailyChart, now: Date = new Date()): Promise<MacroFeatures> {
  const load = async (sym: string, crypto = false) => {
    try {
      const res = await getChart(sym);
      return res.ok ? (crypto ? parseCryptoBars(res.json, now) : parseChartBars(res.json, now)) : null;
    } catch {
      return null;
    }
  };
  const s = MACRO_SYMBOLS;
  const dxy = await load(s.dxy);
  const input: MacroInput = {
    dxy,
    uup: dxy && dxy.length > 0 ? null : await load(s.dxyFallback),
    hyg: await load(s.hyg),
    lqd: await load(s.lqd),
    tnx: await load(s.tnx),
    irx: await load(s.irx),
    gld: await load(s.gld),
    dbb: await load(s.dbb),
    btc: await load(s.btc, true),
  };
  const missing = missingMacroSeries(input);
  if (missing.length) console.warn(`[macro] missing series: ${missing.join(", ")}; their fields are null`);
  const m = computeMacro(input);
  console.log(`[macro] ${m.macro_bar_date ?? "no date"}: dxy ${m.dxy_close ?? "null"}, 10y ${m.yield_10y ?? "null"}%, curve ${m.curve_10y_3m?.toFixed(2) ?? "null"} pp, HYG/LQD ${m.credit_ratio?.toFixed(4) ?? "null"}`);
  return m;
}

/**
 * Sector and industry rotation for this scan (PLAN.md 1f, log only): one cached
 * 3-month chart per sector and industry ETF (~40 requests per run, paced), with
 * SPY from the cache. Failed ETFs are left out; their fields are null.
 */
export async function computeSectorExtras(
  getChart: typeof fetchDailyChart = fetchDailyChart,
  { delayMs = 300 }: { delayMs?: number } = {},
): Promise<SectorRotation | null> {
  try {
    const spyRes = await getChart("SPY");
    const spy = spyRes.ok ? parseChartBars(spyRes.json) : null;
    const etfBars: Record<string, ReturnType<typeof parseChartBars> | null> = {};
    let ok = 0;
    for (let i = 0; i < ROTATION_ETFS.length; i++) {
      const etf = ROTATION_ETFS[i];
      const res = await getChart(etf);
      etfBars[etf] = res.ok ? parseChartBars(res.json) : null;
      if (res.ok) ok++;
      if (delayMs > 0 && i + 1 < ROTATION_ETFS.length) await new Promise((r) => setTimeout(r, delayMs));
    }
    const last = spy && spy.length > 0 ? spy[spy.length - 1] : undefined;
    const barDate = last?.time != null ? etParts(new Date(last.time * 1000)).date : null;
    const rotation = computeSectorRotation(etfBars, spy, barDate);
    const top = rotation.sectors.filter((s) => s.rank_wtd === 1).map((s) => s.etf)[0] ?? "n/a";
    const line = `[sectors] ETF charts ok=${ok}/${ROTATION_ETFS.length}; strongest week-to-date: ${top}`;
    if (ok < ROTATION_ETFS.length) console.warn(line);
    else console.log(line);
    return rotation;
  } catch (err) {
    console.warn("[sectors] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Option-chain features (PLAN.md 1h, log only) for this run's signal symbols.
 * The default (nearest) chain gives the expiry list and is cached when
 * options-flow already scanned the ticker; then the first expiry at least
 * MIN_NEAR_DAYS out and the one closest to 30 days are fetched (reused when the
 * same), so at most two new requests per ticker. Paced like options-flow (5 per 2 s). Symbols
 * with no listed options, or whose fetch fails, are left out.
 */
export async function computeOptionsExtras(
  symbols: readonly string[],
  hv20: Record<string, number | null | undefined>,
  {
    fetchRaw = fetchOptionsRaw,
    now = new Date(),
    batchSize = 5,
    batchDelayMs = 2_000,
  }: { fetchRaw?: (s: string, expiry?: number) => Promise<unknown>; now?: Date; batchSize?: number; batchDelayMs?: number } = {},
): Promise<Record<string, OptionsFeatures>> {
  const nowS = now.getTime() / 1000;
  const out: Record<string, OptionsFeatures> = {};
  let failed = 0;
  let noOptions = 0;
  const load = async (s: string, expiry?: number): Promise<NormalizedChain | null> => normalizeChain(await fetchRaw(s, expiry));
  const one = async (s: string) => {
    try {
      const base = await load(s);
      if (!base) {
        noOptions++;
        return;
      }
      const byExpiry = new Map<number, NormalizedChain | null>([[base.expiry, base]]);
      const get = async (e: number | null | undefined) => {
        if (e == null) return null;
        if (!byExpiry.has(e)) byExpiry.set(e, await load(s, e));
        return byExpiry.get(e) ?? null;
      };
      // Skip 0DTE / expiring chains (also handles an already-expired default chain after the close).
      const near = await get(base.expirations.find((e) => daysToExpiry(e, nowS) >= MIN_NEAR_DAYS));
      const far = await get(pickExpiry(base.expirations, nowS));
      out[s] = computeOptionsFeatures(near, far, hv20[s] ?? null, nowS);
    } catch {
      failed++;
    }
  };
  const list = [...new Set(symbols)];
  for (let i = 0; i < list.length; i += batchSize) {
    await Promise.all(list.slice(i, i + batchSize).map(one));
    if (batchDelayMs > 0 && i + batchSize < list.length) await new Promise((r) => setTimeout(r, batchDelayMs));
  }
  const line = `[options] features for ${Object.keys(out).length}/${list.length} symbols (no options ${noOptions}, failed ${failed})`;
  if (failed > 0) console.warn(line);
  else console.log(line);
  return out;
}
