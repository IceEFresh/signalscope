import "dotenv/config";
import { fetchSignals } from "../src/lib/harvester/index.js";
import type { HarvestIngestPayload } from "../src/lib/harvester/types.js";
import { yahoo429s, yahooHealthSummary } from "../src/lib/yahoo-retry.js";
import { fetchOptionsRaw, peekOptionsRaw } from "../src/lib/harvester/options-chain.js";
import { optionsExtLine, scanOptionsExt, withOptFeatures, type OptFeatures } from "../src/lib/harvester/options-ext.js";
import { EdgarEarningsClient, edgarGetter, normTicker, parseTickerMap, TICKER_MAP_URL } from "../src/lib/harvester/edgar-earnings.js";
import { finraGetter } from "../src/lib/harvester/finra.js";
import { finraLive, form4Live, form4LiveLine } from "../src/lib/harvester/history-live.js";
import { fsFinraCache, fsForm4Cache, fsHouseCache, readFloats } from "../src/lib/harvester/history-fs.js";
import {
  congressCoverageLine,
  congressFeaturesAt,
  houseGetter,
  houseLive,
  houseVsCapitolLine,
  newCongressBuys,
  type CongressEvent,
} from "../src/lib/harvester/house-ptr.js";
import { computeAlpacaOptionsExtras } from "../src/lib/harvester/alpaca-options.js";
import { chunk, computeSnapshotRows, type SnapshotRow } from "../src/lib/harvester/universe/snapshot.js";
import { computeCryptoSnapshotRows } from "../src/lib/harvester/crypto/universe.js";
import { fetchDailyChart, peekDailyChart } from "../src/lib/harvester/yahoo-chart.js";
import { parseChartBars } from "../src/lib/harvester/universe/bar-metrics.js";
import { applyFunnelRanks, liveStpKeys } from "../src/lib/harvester/universe/stp-live.js";
import { calendarExpiry, macroCalendar } from "../src/lib/harvester/macro-calendar.js";
import { barStoreLine, swingHistory, updateBarStore } from "../src/lib/harvester/universe/bar-store.js";
import { barDateOf } from "../src/lib/harvester/universe/backfill.js";
import { etParts } from "../src/lib/harvester/universe/bar-metrics.js";
import { optionsFeatureHits, parseWatchStore, updateWatchStore, watchHits, watchKeys, watchOnlySymbols, watchRunLine, WATCH_ONLY_CAP, type WatchStore } from "../src/lib/harvester/watchlist.js";
import { BENCHMARK_SYMBOL } from "../src/lib/harvester/universe/snapshot.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { alignmentSeries, type Alignment } from "../src/lib/eval/aligned.js";
import { fsBarStoreIO } from "../src/lib/harvester/universe/bar-store-fs.js";
import { PYRAMID_SECTOR_MIN_SHARE, pyramidCoverage, pyramidCoverageLine } from "../src/lib/health/harvest-health.js";
import {
  computeIngestExtras,
  computeStpExtras,
  computeRegimeExtras,
  computeSectorExtras,
  computeMacroExtras,
  alignLayersFor,
  LAYER_ETFS,
  liveContextFor,
  loadLiveEtfStates,
  computeOptionsExtras,
  httpPrepDeps,
  prepareHarvest,
  universeUrlFrom,
} from "../src/lib/harvester/universe/harvest-prep.js";

const ENDPOINT_URL = process.env.HARVEST_ENDPOINT_URL;
const API_KEY = process.env.HARVEST_API_KEY;
const FETCH_TIMEOUT = 5 * 60 * 1000; // 5 minutes (processing takes 1-3 min)

/**
 * P3-0c: post snapshot rows in batches to /api/harvest/snapshot after the scan exists.
 * Never throws: a lost snapshot must not fail the harvest or trigger an ingest retry.
 */
async function postSnapshot(scanId: string, rows: readonly SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  const url = ENDPOINT_URL!.replace(/\/ingest\/?$/, "/snapshot");
  const t0 = Date.now();
  let bytes = 0;
  let inserted = 0;
  let failed = 0;
  for (const part of chunk(rows)) {
    const body = JSON.stringify({ scanId, rows: part });
    bytes += body.length;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-harvest-key": API_KEY! },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      inserted += ((await res.json()) as { inserted?: number }).inserted ?? 0;
    } catch (err) {
      failed += part.length;
      console.warn(`[snapshot] batch failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[snapshot] posted ${rows.length} rows (${(bytes / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${inserted} inserted, ${failed} failed`);
}

async function postSignals(payload: HarvestIngestPayload): Promise<{ status: string; scanId: string }> {
  const payloadSize = JSON.stringify(payload).length;
  console.log(`[trace] POST ${ENDPOINT_URL} — ${payload.signals.length} signals, ${(payloadSize / 1024).toFixed(1)}KB payload`);
  const t0 = Date.now();

  const res = await fetch(ENDPOINT_URL!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-harvest-key": API_KEY!,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[trace] Response: HTTP ${res.status} after ${elapsed}s`);
    throw new Error(`Ingest endpoint returned ${res.status}: ${text}`);
  }

  const result = await res.json();
  console.log(`[trace] Response: HTTP ${res.status} after ${elapsed}s — scanId=${result.scanId}`);
  return result;
}

async function main() {
  console.log("=== SignalScope Slim Harvester (Remote Processing) ===");
  console.log(`Started at: ${new Date().toISOString()}`);

  if (!ENDPOINT_URL || !API_KEY) {
    console.error("Missing HARVEST_ENDPOINT_URL or HARVEST_API_KEY");
    process.exit(1);
  }

  // 0. Universe and graduation watch (PR 1-0). Falls back to SCAN_SYMBOLS on any failure.
  const universeUrl = universeUrlFrom(ENDPOINT_URL, process.env.HARVEST_UNIVERSE_URL);
  const prep = await prepareHarvest(httpPrepDeps(universeUrl, API_KEY));
  console.log(`[trace] Universe: ${prep.universeId ?? "static fallback"} (${prep.scanSymbols.length} symbols), watch: ${prep.watch.length}`);

  // 1. Fetch signals locally
  console.log(`[trace] Endpoint: ${ENDPOINT_URL}`);
  console.log(`[trace] Starting local signal fetch...`);
  const fetchStart = Date.now();
  const signals = await fetchSignals({ scanSymbols: prep.scanSymbols });

  // 1b. Bar metrics for every symbol, and the daily watch re-check
  const extras = await computeIngestExtras(signals, prep.watch);
  signals.push(...extras.graduationSignals);

  // 1c. STP daily states and triggers for the universe plus signal symbols (PLAN.md 1g, log only)
  const stp = await computeStpExtras([...prep.scanSymbols, ...Object.keys(extras.barMetrics)]);

  // 1d. Market regime fields for this scan (PLAN.md 1c, log only)
  const regime = await computeRegimeExtras();

  // 1e. Sector and industry rotation (PLAN.md 1f, log only)
  const sectorRotation = await computeSectorExtras();

  // 1e*. Macro context (P3-0f, log only): after sectors, so GLD and DBB come from the chart cache
  const macro = await computeMacroExtras();

  // 1e'. Universe-wide snapshot rows from the chart cache, STP states and the weekly sector profiles
  // (P3-0c / P3-0d, log only, no new requests)
  // P3-0i2: live log-only STP keys (rolling opens, size factors, Power Pyramid, Finviz screens, swings)
  const liveEtfStates = await loadLiveEtfStates();
  // P3-0i2b: persistent bar store for the swing keys (append this run's charts; never stops the harvest)
  let storeHistories = new Map<string, ReturnType<typeof parseChartBars>>();
  try {
    // P3-0k: the layer ETFs too, so their sma200 and its slope are computable live
    const store = await updateBarStore(
      [...new Set([...prep.scanSymbols, ...LAYER_ETFS])],
      async (sym) => {
        const p = peekDailyChart(sym);
        const res = p ? await p.catch(() => null) : null;
        return res?.ok ? parseChartBars(res.json) : null;
      },
      fsBarStoreIO(),
    );
    storeHistories = store.histories;
    const { line, warn } = barStoreLine(store.stats);
    if (warn) console.warn(`${line}; WARNING: under 80% of members have 250 sessions, swing keys will often be null`);
    else console.log(line);
  } catch (err) {
    console.warn(`[bar-store] update failed, swing keys use the chart only: ${err instanceof Error ? err.message : err}`);
  }
  // P3-0k: layer ETF alignment from the store plus this run's chart
  const liveAlign = new Map<string, Map<string, Alignment>>();
  for (const etf of LAYER_ETFS) {
    const p = peekDailyChart(etf);
    const res = p ? await p.catch(() => null) : null;
    if (!res?.ok) continue;
    liveAlign.set(etf, alignmentSeries(swingHistory(storeHistories.get(etf), parseChartBars(res.json)), barDateOf));
  }
  // P3-0l: smart-money watchlist (log only): today's hits from the harvested signals, kept for 10 sessions
  const today = etParts(new Date()).date;
  // Session list from the bar store plus this run's SPY chart (P3-0n / P3-0p timing)
  const histSessions = await (async () => {
    const spyP = peekDailyChart(BENCHMARK_SYMBOL);
    const spyRes = spyP ? await spyP.catch(() => null) : null;
    const spyBars = swingHistory(storeHistories.get(BENCHMARK_SYMBOL), spyRes?.ok ? parseChartBars(spyRes.json) : []);
    return [...new Set(spyBars.map(barDateOf).filter((d): d is string => d != null))].sort();
  })();
  // P3-0p: congress trades from the House Clerk's PTRs (log only). Its new purchases are the P3-0l
  // congress hits; Capitol Trades' are the fallback when this fails.
  let houseEvents: CongressEvent[] | null = null;
  try {
    const houseGet = houseGetter();
    const house = await houseLive(today, histSessions, houseGet, fsHouseCache());
    houseEvents = house.events;
    console.log(`${congressCoverageLine(house.coverage)}; ${houseGet.requests()} House Clerk requests`);
  } catch (err) {
    console.warn(`[house-ptr] failed, congress hits fall back to Capitol Trades and cong_* keys are missing: ${err instanceof Error ? err.message : err}`);
  }
  const WATCH_FILE = process.env.WATCHLIST_FILE || "data/watchlist/watchlist.json";
  let watch: WatchStore = parseWatchStore(null);
  let hits: ReturnType<typeof watchHits> = [];
  let prevWatch: WatchStore | null = null;
  let watchOk = true;
  try {
    const moves = new Map<string, number | null>();
    for (const sym of new Set(signals.filter((x) => x.source === "VOLUME_SPIKE").map((x) => x.symbol))) {
      const p = peekDailyChart(sym);
      const res = p ? await p.catch(() => null) : null;
      const b = res?.ok ? parseChartBars(res.json) : [];
      moves.set(sym, b.length >= 2 ? b[b.length - 1].close - b[b.length - 2].close : null);
    }
    hits = watchHits(signals, (sym) => moves.get(sym) ?? null);
    if (houseEvents) {
      const sale = /\b(sell|sells|sold|sale)\b/i;
      const capitol = new Set(signals.filter((x) => x.source === "CONGRESS" && !sale.test(x.title ?? "")).map((x) => x.symbol.toUpperCase()));
      const house = newCongressBuys(houseEvents, histSessions.at(-1) ?? today);
      console.log(houseVsCapitolLine(house, capitol));
      hits = [...hits.filter((h) => h.source !== "congress"), ...[...house].map((symbol) => ({ symbol, source: "congress" as const, direction: "bullish" as const }))];
    }
    prevWatch = existsSync(WATCH_FILE) ? parseWatchStore(JSON.parse(readFileSync(WATCH_FILE, "utf8"))) : null;
  } catch (err) {
    watchOk = false;
    console.warn(`[watch] watchlist update failed, watch keys are null this run: ${err instanceof Error ? err.message : err}`);
  }
  // P3-0m: options-flow results as log-only opt_* keys on the snapshot rows. Universe members read
  // this run's cached chains (no requests); watched names outside the universe are fetched (capped).
  // No OPTIONS_FLOW signals from these. Never stops the harvest.
  let optExt: Record<string, OptFeatures> = {};
  try {
    const watchOnly = watchOk ? watchOnlySymbols(updateWatchStore(prevWatch, hits, today), prep.scanSymbols).symbols : [];
    const r0 = yahoo429s("options");
    const ext = await scanOptionsExt(prep.scanSymbols, watchOnly, { peek: peekOptionsRaw, fetch: (s) => fetchOptionsRaw(s) });
    optExt = ext.features;
    const { line, warn } = optionsExtLine(ext.stats, yahoo429s("options") - r0);
    (warn ? console.warn : console.log)(line);
  } catch (err) {
    console.warn(`[options-ext] failed, opt_* keys are null this run: ${err instanceof Error ? err.message : err}`);
  }
  if (watchOk) {
    try {
      hits.push(...optionsFeatureHits(optExt));
      watch = updateWatchStore(prevWatch, hits, today);
      mkdirSync(WATCH_FILE.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(WATCH_FILE, JSON.stringify(watch));
      console.log(watchRunLine(hits, watch));
    } catch (err) {
      watch = parseWatchStore(null);
      console.warn(`[watch] watchlist update failed, watch keys are null this run: ${err instanceof Error ? err.message : err}`);
    }
  }
  const liveKeys = (s: string, bars: Parameters<typeof liveStpKeys>[0], r: Parameters<typeof liveStpKeys>[1]) =>
    liveStpKeys(bars, r, {
      ...liveContextFor(s, prep.profiles, liveEtfStates),
      history: storeHistories.get(s),
      alignLayers: alignLayersFor(s, prep.profiles, liveAlign),
      watch: watchKeys(watch.entries[s.toUpperCase()], today),
    });
  const snapshot = await computeSnapshotRows(prep.scanSymbols, stp, undefined, { profiles: prep.profiles, rotation: sectorRotation }, liveKeys);
  snapshot.rows = withOptFeatures(snapshot.rows, optExt);
  // The same keys on the signal tickers' features (no new requests: their charts are cached)
  let liveTickers = 0;
  for (const sym of Object.keys(extras.barFeatures)) {
    const p = peekDailyChart(sym);
    const res = p ? await p.catch(() => null) : null;
    if (!res?.ok) continue;
    try {
      Object.assign(extras.barFeatures[sym] as unknown as Record<string, unknown>, liveKeys(sym, parseChartBars(res.json), stp[sym]));
      liveTickers++;
    } catch (err) {
      console.warn(`[stp-live] ${sym}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[stp-live] layer ETFs cached: ${liveEtfStates.size}; live keys on ${liveTickers} signal tickers`);
  // P3-0j: rank today's funnel candidates across the universe; warn when the macro calendar runs short
  const funnelCandidates = applyFunnelRanks(snapshot.rows);
  const cal = calendarExpiry(macroCalendar(), new Date().toISOString().slice(0, 10));
  console.log(`[funnel] ${funnelCandidates} candidates passed the gates today`);
  (cal.warn ? console.warn : console.log)(cal.line);
  const pyr = pyramidCoverage(
    snapshot.rows.map((r) => r.features),
    Object.values(prep.profiles).filter((p) => p.sector).length,
    prep.scanSymbols.length,
  );
  if (pyr) {
    const line = pyramidCoverageLine(pyr);
    if (pyr.warn) console.warn(`${line}; WARNING: sector layer under ${PYRAMID_SECTOR_MIN_SHARE * 100}%, pyramid sizes reflect the market layer only`);
    else console.log(line);
  }
  console.log(
    `[snapshot] ${snapshot.rows.length} rows built, ${snapshot.missing} symbols without a cached chart, ${Object.keys(prep.profiles).length} members with a sector profile`,
  );

  // P3-0l2: watched names outside the universe get a chart (one request each, capped) and a
  // snapshot row marked watch_only, so their entry readiness is logged every session they're
  // watched. Added after the funnel ranks and coverage lines, which are universe-only; the
  // P3-0c/P3-0d harness and the health report filter these rows out.
  try {
    const wo = watchOnlySymbols(watch, prep.scanSymbols);
    if (wo.symbols.length) {
      const stpW = await computeStpExtras(wo.symbols);
      const built = await computeSnapshotRows(wo.symbols, stpW, undefined, { profiles: prep.profiles, rotation: sectorRotation }, liveKeys);
      const rows = withOptFeatures(built.rows.filter((r) => r.symbol !== BENCHMARK_SYMBOL), optExt).map((r) => ({ ...r, features: { ...r.features, watch_only: true } }));
      snapshot.rows.push(...rows);
      console.log(`[watch] ${rows.length}/${wo.symbols.length} watched names outside the universe logged as watch_only rows${wo.skipped ? `; ${wo.skipped} over the cap of ${WATCH_ONLY_CAP} skipped` : ""}`);
    }
  } catch (err) {
    console.warn(`[watch] watch_only rows failed: ${err instanceof Error ? err.message : err}`);
  }

  // P3-0n: insider (EDGAR Form 4) and short interest / short volume (FINRA) keys on every stock
  // snapshot row, log-only; the same code and caches as scripts/backfill-form4.ts and
  // backfill-finra.ts. Each part never stops the harvest.
  {
    const sessions = histSessions;
    const rows = snapshot.rows.map((r) => ({ symbol: r.symbol, sessionDate: r.sessionDate }));
    const extra = new Map<string, Record<string, unknown>>();
    const add = (f: Record<string, Record<string, unknown>>) => {
      for (const [sym, v] of Object.entries(f)) extra.set(sym, { ...(extra.get(sym) ?? {}), ...v });
    };
    const ua = process.env.SEC_USER_AGENT;
    if (!ua) console.warn("[form4] SEC_USER_AGENT not set: ins_* keys skipped this run");
    else
      try {
        const client = new EdgarEarningsClient(edgarGetter(ua));
        const tickerMap = parseTickerMap(await client.json(TICKER_MAP_URL));
        const f4 = await form4Live(rows, sessions, today, (sym) => tickerMap.get(normTicker(sym)), client, fsForm4Cache());
        add(f4.features);
        const liveInsider = new Set(
          signals.filter((x) => x.source === "SEC_INSIDER" && !/\b(sell|sells|sold|sale)\b/i.test(x.title ?? "")).map((x) => x.symbol.toUpperCase()),
        );
        const now = new Date();
        const { line, warn } = form4LiveLine(f4, liveInsider, new Date(now.getTime() - 86_400_000).toISOString(), now.toISOString());
        (warn ? console.warn : console.log)(`${line}; ${client.requests} EDGAR requests`);
      } catch (err) {
        console.warn(`[form4] live keys failed, ins_* keys are missing this run: ${err instanceof Error ? err.message : err}`);
      }
    try {
      const fin = await finraLive(rows, sessions, today, readFloats()?.floats ?? null, finraGetter(), fsFinraCache());
      add(fin.features);
      (fin.warn ? console.warn : console.log)(fin.line);
    } catch (err) {
      console.warn(`[finra] live keys failed, si_*/sv_* keys are missing this run: ${err instanceof Error ? err.message : err}`);
    }
    if (houseEvents) {
      const ev = houseEvents;
      add(Object.fromEntries(rows.map((r) => [r.symbol, { ...congressFeaturesAt(ev, r.symbol, r.sessionDate) }])));
    }
    snapshot.rows = snapshot.rows.map((r) => (extra.has(r.symbol) ? { ...r, features: { ...r.features, ...extra.get(r.symbol) } } : r));
  }

  // 1e''. Crypto snapshot rows for the weekly crypto universe (P3-0e, log only): one 3-month chart each,
  // complete UTC days only, BTC as the benchmark. Never enters the signal payload or ValidatedTicker.
  const cryptoSnapshot = await computeCryptoSnapshotRows(prep.cryptoSymbols, async (s) => {
    const r = await fetchDailyChart(s);
    return r.ok ? r.json : null;
  });
  if (prep.cryptoSymbols.length) console.log(`[snapshot] crypto: ${cryptoSnapshot.rows.length} rows built, ${cryptoSnapshot.missing} without a chart`);

  // 1f. Option-chain features for signal symbols (PLAN.md 1h, log only)
  const optionSymbols = Object.keys(extras.barMetrics).filter((s) => signals.some((sig) => sig.symbol === s));
  const optionsFeatures = await computeOptionsExtras(
    optionSymbols,
    Object.fromEntries(Object.entries(extras.barMetrics).map(([s, m]) => [s, m.hv20])),
  );

  // 1g. Alpaca option snapshots and large prints for the same symbols (PLAN.md 2e, log only),
  // for the last completed session; merged into the 1h option features
  const alpacaOptions = await computeAlpacaOptionsExtras(optionSymbols, regime.spy_bar_date);
  const mergedOptions = optionsFeatures as unknown as Record<string, Record<string, number | null>>;
  for (const [s, f] of Object.entries(alpacaOptions)) mergedOptions[s] = { ...(mergedOptions[s] ?? {}), ...f };
  const fetchElapsed = ((Date.now() - fetchStart) / 1000).toFixed(1);
  console.log(`[trace] Fetch completed in ${fetchElapsed}s — ${signals.length} signals`);

  // Log source breakdown
  const sourceCounts = signals.reduce((acc, s) => {
    acc[s.source] = (acc[s.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`[trace] Source breakdown:`, JSON.stringify(sourceCounts));

  if (signals.length === 0) {
    console.log("No signals fetched — skipping remote processing");
    process.exit(0);
  }

  console.log(yahooHealthSummary()); // PLAN.md 1e: per-endpoint calls / retries / failures this run

  const payload: HarvestIngestPayload = {
    signals,
    harvestedAt: new Date().toISOString(),
    universeId: prep.universeId,
    barMetrics: extras.barMetrics,
    barFeatures: extras.barFeatures as unknown as HarvestIngestPayload["barFeatures"],
    stp,
    regime: regime as unknown as HarvestIngestPayload["regime"],
    macro: macro as unknown as HarvestIngestPayload["macro"],
    sectorRotation,
    optionsFeatures: optionsFeatures as unknown as HarvestIngestPayload["optionsFeatures"],
    watchChecks: extras.watchChecks,
  };

  // 2. POST to the web app for processing
  try {
    const result = await postSignals(payload);
    console.log(`Scan completed remotely: ${result.scanId}`);
    await postSnapshot(result.scanId, [...snapshot.rows, ...cryptoSnapshot.rows]);
  } catch (err) {
    console.warn(`First attempt failed: ${err instanceof Error ? err.message : err}`);
    console.log("Retrying in 5 seconds...");
    await new Promise((r) => setTimeout(r, 5000));

    try {
      const result = await postSignals(payload);
      console.log(`Scan completed remotely (retry): ${result.scanId}`);
      await postSnapshot(result.scanId, [...snapshot.rows, ...cryptoSnapshot.rows]);
    } catch (retryErr) {
      console.error(`Retry failed: ${retryErr instanceof Error ? retryErr.message : retryErr}`);

      // Save signals to disk for manual replay
      const dumpPath = `/tmp/signalscope-harvest-${Date.now()}.json`;
      writeFileSync(dumpPath, JSON.stringify(payload, null, 2));
      console.error(`Signals saved to ${dumpPath} for manual replay`);
      process.exit(1);
    }
  }

  console.log(`Finished at: ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Slim harvester failed:", err);
  process.exit(1);
});
