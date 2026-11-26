/**
 * P3-0l: smart-money and sentiment watchlist (docs/PHASE3-PREP.md §P3-0l). Live, log only.
 *
 * A ticker joins the watchlist when one of the harvester's own sources fires for it, and stays
 * for WATCH_SESSIONS sessions after its latest hit (the hit's session counts as 0; session 10
 * is the last one on the list, session 11 drops it). Sessions are weekdays (exchange holidays
 * aren't stored live). Pure; the harvester keeps the store in data/watchlist/watchlist.json.
 *
 * Direction per source, as each source reports it:
 * - insider (SEC Form 4) and congress: the sources collect purchases only → bullish; a sale
 *   would never be a buy signal (null);
 * - options: net premium > 0 bullish, < 0 bearish; zero or unknown isn't a hit. P3-0m: also a
 *   hit when the row's opt_unusual_n ≥ 1 (options-ext features), same direction rule. Unreliable:
 *   the side (bought or sold) is unknown;
 * - volume: the spike day's close vs the prior close;
 * - reddit, stocktwits, x: the harvester sees posts before any sentiment scoring → null;
 * - polymarket: no direction → null.
 */
import type { RawSignal, Source } from "./types";

export const WATCH_SESSIONS = 10;
export const WATCH_SOURCES = ["reddit", "stocktwits", "x", "insider", "congress", "volume", "options", "polymarket"] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];
export type WatchDirection = "bullish" | "bearish";

export const SOURCE_MAP: Partial<Record<Source, WatchSource>> = {
  REDDIT: "reddit",
  STOCKTWITS: "stocktwits",
  TWITTER: "x",
  SEC_INSIDER: "insider",
  CONGRESS: "congress",
  VOLUME_SPIKE: "volume",
  OPTIONS_FLOW: "options",
  POLYMARKET: "polymarket",
};

export interface WatchHit {
  symbol: string;
  source: WatchSource;
  direction: WatchDirection | null;
}

/** Spike-day direction for a volume hit: today's close vs the prior close. */
export type DayMove = (symbol: string) => number | null;

/** One run's hits from the harvested signals; a signal that isn't a hit (an insider sale, options with no net premium) is left out. */
export function watchHits(signals: readonly RawSignal[], dayMove: DayMove = () => null): WatchHit[] {
  const out: WatchHit[] = [];
  for (const s of signals) {
    const source = SOURCE_MAP[s.source];
    if (!source || !s.symbol) continue;
    let direction: WatchDirection | null = null;
    if (source === "insider" || source === "congress") {
      // Both sources keep purchases only ("Insider purchase: …", "Congress buy: …"); anything else isn't a buy signal
      if (/\b(sell|sells|sold|sale)\b/i.test(s.title ?? "")) continue;
      direction = "bullish";
    } else if (source === "options") {
      if (s.netPremium == null || s.netPremium === 0) continue;
      direction = s.netPremium > 0 ? "bullish" : "bearish";
    } else if (source === "volume") {
      const m = dayMove(s.symbol);
      direction = m == null || m === 0 ? null : m > 0 ? "bullish" : "bearish";
    }
    out.push({ symbol: s.symbol.toUpperCase(), source, direction });
  }
  return out;
}

/** P3-0m: options hits from the options-ext features (opt_unusual_n ≥ 1, direction from the net premium's sign). */
export function optionsFeatureHits(features: Readonly<Record<string, { opt_unusual_n: number; opt_net_premium: number | null }>>): WatchHit[] {
  const out: WatchHit[] = [];
  for (const [symbol, f] of Object.entries(features)) {
    if (!(f.opt_unusual_n >= 1) || f.opt_net_premium == null || f.opt_net_premium === 0) continue;
    out.push({ symbol: symbol.toUpperCase(), source: "options", direction: f.opt_net_premium > 0 ? "bullish" : "bearish" });
  }
  return out;
}

export interface WatchSourceHit {
  /** Session date (YYYY-MM-DD) of the latest hit from this source. */
  last: string;
  direction: WatchDirection | null;
}

export interface WatchEntry {
  firstSeen: string;
  lastSeen: string;
  sources: Partial<Record<WatchSource, WatchSourceHit>>;
}

export interface WatchStore {
  version: 1;
  entries: Record<string, WatchEntry>;
}

export const emptyWatchStore = (): WatchStore => ({ version: 1, entries: {} });

/** Weekdays from a to b (b after a counts up from 1; same day = 0; b before a is negative). */
export function sessionsBetween(a: string, b: string): number {
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  const [lo, hi] = sign > 0 ? [a, b] : [b, a];
  let n = 0;
  for (let t = Date.parse(`${lo}T12:00:00Z`) + 86_400_000; t <= Date.parse(`${hi}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return sign * n;
}

/** True while a hit on `last` keeps the ticker watched on `today`. */
export const withinWatch = (last: string, today: string) => {
  const n = sessionsBetween(last, today);
  return n >= 0 && n <= WATCH_SESSIONS;
};

/** Add today's hits and drop entries (and per-source hits) older than the window. Returns a new store. */
export function updateWatchStore(store: WatchStore | null | undefined, hits: readonly WatchHit[], today: string): WatchStore {
  const entries: Record<string, WatchEntry> = {};
  for (const [sym, e] of Object.entries(store?.entries ?? {})) {
    const sources = Object.fromEntries(Object.entries(e.sources).filter(([, h]) => h && withinWatch(h.last, today))) as WatchEntry["sources"];
    if (Object.keys(sources).length) entries[sym] = { ...e, sources };
  }
  for (const h of hits) {
    const e = (entries[h.symbol] ??= { firstSeen: today, lastSeen: today, sources: {} });
    e.lastSeen = today;
    const prev = e.sources[h.source];
    // Same day: keep a known direction over a null one
    e.sources[h.source] = { last: today, direction: prev?.last === today && h.direction == null ? prev.direction : h.direction };
  }
  return { version: 1, entries };
}

/** Parse a stored file; anything unreadable starts a fresh store. */
export function parseWatchStore(json: unknown): WatchStore {
  const j = json as { version?: unknown; entries?: unknown } | null;
  return j && j.version === 1 && j.entries && typeof j.entries === "object" ? (j as WatchStore) : emptyWatchStore();
}

export interface WatchKeys {
  watch_sources: string | null;
  watch_first_seen: string | null;
  watch_direction: WatchDirection | null;
  /** P3-0l2: a live hit carries a direction. False = only directionless sources (social, Polymarket): the trigger sets it. */
  directional?: boolean;
}

/**
 * Row keys for a watched ticker; all null when it isn't on the list. Direction: the latest
 * directional hit; two sources disagreeing on the same latest day → null.
 */
export function watchKeys(entry: WatchEntry | undefined, today: string): WatchKeys {
  const live = Object.entries(entry?.sources ?? {}).filter(([, h]) => h && withinWatch(h.last, today)) as Array<[WatchSource, WatchSourceHit]>;
  if (!entry || !live.length) return { watch_sources: null, watch_first_seen: null, watch_direction: null, directional: false };
  const directional = live.filter(([, h]) => h.direction != null);
  const latest = directional.reduce<string | null>((m, [, h]) => (m == null || h.last > m ? h.last : m), null);
  const dirs = new Set(directional.filter(([, h]) => h.last === latest).map(([, h]) => h.direction));
  return {
    watch_sources: live.map(([s]) => s).sort((a, b) => WATCH_SOURCES.indexOf(a) - WATCH_SOURCES.indexOf(b)).join(" "),
    watch_first_seen: entry.firstSeen,
    watch_direction: dirs.size === 1 ? [...dirs][0]! : null,
    directional: directional.length > 0,
  };
}

/** Per-source hit counts for this run (every source listed, zero included). */
export function hitCounts(hits: readonly WatchHit[]): Record<WatchSource, number> {
  const out = Object.fromEntries(WATCH_SOURCES.map((s) => [s, 0])) as Record<WatchSource, number>;
  for (const h of hits) out[h.source]++;
  return out;
}

/** P3-0l2: at most this many watched names outside the universe get a chart and a watch_only row per run. */
export const WATCH_ONLY_CAP = 150;

/** Watched names outside the universe, most recent hit first (then symbol), capped. */
export function watchOnlySymbols(store: WatchStore, universe: Iterable<string>, cap = WATCH_ONLY_CAP): { symbols: string[]; skipped: number } {
  const inUniverse = new Set([...universe].map((s) => s.toUpperCase()));
  const all = Object.entries(store.entries)
    .filter(([s]) => !inUniverse.has(s))
    .sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen) || a[0].localeCompare(b[0]))
    .map(([s]) => s);
  return { symbols: all.slice(0, cap), skipped: Math.max(0, all.length - cap) };
}

/** A watch source with zero hits for this many runs in a row gets a health warning. */
export const ZERO_HIT_RUNS = 3;

/**
 * Health report: per-source signal counts for each of the latest scans (newest first), and a
 * warning per source with zero hits in each of the last ZERO_HIT_RUNS scans. Counts come from
 * the stored signals by source (the direction filters aren't applied here).
 */
export function watchSourceHealth(scans: ReadonlyArray<{ scanId: string; bySource: Partial<Record<string, number>> }>): { lines: string[]; warnings: string[] } {
  const per = scans.map((s) => {
    const c = Object.fromEntries(WATCH_SOURCES.map((w) => [w, 0])) as Record<WatchSource, number>;
    for (const [src, n] of Object.entries(s.bySource)) {
      const w = SOURCE_MAP[src as Source];
      if (w) c[w] += n ?? 0;
    }
    return { scanId: s.scanId, c };
  });
  const lines = per.map((p) => `[watch] ${p.scanId}: ${WATCH_SOURCES.map((w) => `${w} ${p.c[w]}`).join(", ")}`);
  const recent = per.slice(0, ZERO_HIT_RUNS);
  const warnings =
    recent.length < ZERO_HIT_RUNS
      ? []
      : WATCH_SOURCES.filter((w) => recent.every((p) => p.c[w] === 0)).map((w) => `WARNING [watch] ${w}: zero hits in each of the last ${ZERO_HIT_RUNS} runs`);
  return { lines, warnings };
}

export function watchRunLine(hits: readonly WatchHit[], store: WatchStore): string {
  const c = hitCounts(hits);
  return `[watch] hits: ${WATCH_SOURCES.map((s) => `${s} ${c[s]}`).join(", ")}; ${Object.keys(store.entries).length} tickers on the watchlist`;
}
