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
import { fetchDailyChart } from "../yahoo-chart";
import { buildUniverse, defaultDeps, evaluateSymbols, type UniverseBuildResult } from "./build";
import { applyWatchResults, type ActiveWatchRow } from "./watch";

export const UNIVERSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface UniverseState {
  universe: { id: string; refreshedAt: string; symbols: string[] } | null;
  watch: ActiveWatchRow[];
}

export interface HarvestPrep {
  universeId: string | null;
  scanSymbols: readonly string[];
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
      universe = { id, refreshedAt: now.toISOString(), symbols: build.members.map((m) => m.symbol) };
    } catch (err) {
      console.warn("[universe] rebuild failed, keeping the previous universe:", err instanceof Error ? err.message : err);
    }
  }

  if (!universe || universe.symbols.length === 0) {
    console.warn(`[universe] none available, falling back to static SCAN_SYMBOLS (${SCAN_SYMBOLS.length})`);
    return { universeId: null, scanSymbols: SCAN_SYMBOLS, watch: state.watch };
  }
  return { universeId: universe.id, scanSymbols: universe.symbols, watch: state.watch };
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
    build: () => buildUniverse(),
    postBuild: async (build) => {
      const res = await fetch(universeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          directoryCount: build.directoryCount,
          prefilterCount: build.prefilterCount,
          members: build.members,
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
