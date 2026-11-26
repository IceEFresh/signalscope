/**
 * P3-0q: Reddit (and 4chan) mention counts from ApeWisdom's free public API (docs/PHASE3-PREP.md
 * §P3-0q). Live-only and log-only.
 *
 * `https://apewisdom.io/api/v1.0/filter/<filter>/page/<n>` (no key, verified 2026-11-26) returns
 * `{count, pages, current_page, results: [{rank, ticker, name, mentions, upvotes, rank_24h_ago,
 * mentions_24h_ago}]}`, 100 per page. `mentions_24h_ago` is null when the ticker wasn't ranked a
 * day earlier (about 1 in 6); `rank_24h_ago` is 0 then. Crypto tickers carry ".X" (BTC.X).
 *
 * aw_spike: mentions ≥ 3 × mentions 24 h ago and ≥ 20 mentions. A ticker that wasn't ranked a day
 * earlier counts as 0 then, so a new name with ≥ 20 mentions is a spike; its
 * aw_mentions_24h_ago stays null. A ticker not on the list gets null keys (the source ran but it
 * had no mentions in the window); a failed fetch leaves the keys off the rows.
 */
import { throwIfRetryable, withRetry } from "@/lib/yahoo-retry";

export const APEWISDOM_URL = "https://apewisdom.io/api/v1.0/filter";
export const AW_FILTERS = ["all-stocks", "wallstreetbets", "all-crypto"] as const;
export type AwFilter = (typeof AW_FILTERS)[number];
export const AW_SPIKE_RATIO = 3;
export const AW_SPIKE_MIN = 20;
/** Page cap per filter (all-stocks has about 9). */
export const AW_MAX_PAGES = 20;
export const AW_MIN_INTERVAL_MS = 1_000;

export interface AwRow {
  rank: number;
  ticker: string;
  mentions: number;
  upvotes: number | null;
  rankAgo: number | null;
  mentionsAgo: number | null;
}

export interface AwPage {
  pages: number;
  rows: AwRow[];
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One API page; null when the shape is wrong. */
export function parseAwPage(json: unknown): AwPage | null {
  const j = json as { pages?: unknown; results?: unknown } | null;
  if (!j || !Array.isArray(j.results)) return null;
  const rows: AwRow[] = [];
  for (const r of j.results as Array<Record<string, unknown>>) {
    const ticker = typeof r?.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
    const rank = int(r?.rank);
    const mentions = int(r?.mentions);
    if (!ticker || rank == null || mentions == null) continue;
    const rankAgo = int(r.rank_24h_ago);
    rows.push({ rank, ticker, mentions, upvotes: int(r.upvotes), rankAgo: rankAgo && rankAgo > 0 ? rankAgo : null, mentionsAgo: int(r.mentions_24h_ago) });
  }
  return { pages: int(j.pages) ?? 1, rows };
}

/** ApeWisdom ticker → our symbol: share classes with a dash (BRK.B → BRK-B), crypto BTC.X → BTC-USD. */
export function awSymbol(ticker: string, filter: AwFilter): string {
  const t = ticker.toUpperCase();
  return filter === "all-crypto" ? `${t.replace(/\.X$/, "")}-USD` : t.replace(/\./g, "-");
}

export const awSpike = (r: Pick<AwRow, "mentions" | "mentionsAgo">): boolean => r.mentions >= AW_SPIKE_MIN && r.mentions >= AW_SPIKE_RATIO * (r.mentionsAgo ?? 0);

export interface AwFeatures {
  aw_mentions: number | null;
  aw_mentions_24h_ago: number | null;
  aw_rank: number | null;
  aw_spike: boolean | null;
}

export const AW_KEYS = ["aw_mentions", "aw_mentions_24h_ago", "aw_rank", "aw_spike"] as const;
const NONE: AwFeatures = { aw_mentions: null, aw_mentions_24h_ago: null, aw_rank: null, aw_spike: null };

export const awFeatures = (r: AwRow | undefined): AwFeatures =>
  r ? { aw_mentions: r.mentions, aw_mentions_24h_ago: r.mentionsAgo, aw_rank: r.rank, aw_spike: awSpike(r) } : { ...NONE };

/** GET JSON; throws an HttpError on 429/5xx so the shared backoff retries it. */
export type AwGet = (url: string) => Promise<unknown>;

export function awGetter(minIntervalMs = AW_MIN_INTERVAL_MS): AwGet & { requests: () => number } {
  let last = 0;
  let n = 0;
  const get = (url: string) =>
    withRetry(
      async () => {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        n++;
        const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        throwIfRetryable(res);
        if (!res.ok) throw Object.assign(new Error(`apewisdom ${res.status}`), { status: res.status });
        return res.json() as Promise<unknown>;
      },
      { label: "apewisdom" },
    );
  return Object.assign(get, { requests: () => n });
}

/** Every page of one filter, keyed by our symbol. Throws when page 1 fails; a later page that fails ends the list. */
export async function fetchAwFilter(filter: AwFilter, get: AwGet, maxPages = AW_MAX_PAGES): Promise<{ bySymbol: Map<string, AwRow>; pages: number; complete: boolean }> {
  const bySymbol = new Map<string, AwRow>();
  const first = parseAwPage(await get(`${APEWISDOM_URL}/${filter}/page/1`));
  if (!first) throw new Error(`apewisdom ${filter}: unexpected response`);
  const add = (rows: AwRow[]) => {
    for (const r of rows) {
      const s = awSymbol(r.ticker, filter);
      if (!bySymbol.has(s)) bySymbol.set(s, r);
    }
  };
  add(first.rows);
  const total = Math.min(first.pages, maxPages);
  let pages = 1;
  for (let p = 2; p <= total; p++) {
    let page: AwPage | null = null;
    try {
      page = parseAwPage(await get(`${APEWISDOM_URL}/${filter}/page/${p}`));
    } catch {
      page = null;
    }
    if (!page) return { bySymbol, pages, complete: false };
    add(page.rows);
    pages++;
  }
  return { bySymbol, pages, complete: pages === first.pages };
}

export interface AwLive {
  stocks: Map<string, AwRow> | null;
  wsb: Map<string, AwRow> | null;
  crypto: Map<string, AwRow> | null;
  pages: Record<AwFilter, number>;
  failed: AwFilter[];
}

/** All three filters; each one fails on its own. */
export async function awLive(get: AwGet): Promise<AwLive> {
  const out: AwLive = { stocks: null, wsb: null, crypto: null, pages: { "all-stocks": 0, wallstreetbets: 0, "all-crypto": 0 }, failed: [] };
  for (const f of AW_FILTERS) {
    try {
      const r = await fetchAwFilter(f, get);
      out.pages[f] = r.pages;
      if (f === "all-stocks") out.stocks = r.bySymbol;
      else if (f === "wallstreetbets") out.wsb = r.bySymbol;
      else out.crypto = r.bySymbol;
    } catch {
      out.failed.push(f);
    }
  }
  return out;
}

/** aw_* for a stock row (all-stocks; plus aw_wsb_mentions from r/wallstreetbets) or a crypto row (all-crypto). Empty when the filter failed. */
export function awRowFeatures(aw: AwLive, symbol: string, crypto = false): Record<string, unknown> {
  const s = symbol.toUpperCase();
  if (crypto) return aw.crypto ? { ...awFeatures(aw.crypto.get(s)) } : {};
  if (!aw.stocks) return {};
  return { ...awFeatures(aw.stocks.get(s)), ...(aw.wsb ? { aw_wsb_mentions: aw.wsb.get(s)?.mentions ?? null } : {}) };
}

/** Stock tickers spiking today (all-stocks): the P3-0l Reddit hits. */
export function awSpikes(aw: AwLive): Set<string> {
  return new Set([...(aw.stocks ?? new Map<string, AwRow>()).entries()].filter(([, r]) => awSpike(r)).map(([s]) => s));
}

export function awLine(aw: AwLive, spikes: ReadonlySet<string>, redditScraper: ReadonlySet<string>): { line: string; warn: boolean } {
  const both = [...spikes].filter((s) => redditScraper.has(s)).length;
  const n = (m: Map<string, AwRow> | null, f: AwFilter) => (m ? `${m.size} (${aw.pages[f]} pages)` : "failed");
  const line =
    `[apewisdom] all-stocks ${n(aw.stocks, "all-stocks")}, wallstreetbets ${n(aw.wsb, "wallstreetbets")}, all-crypto ${n(aw.crypto, "all-crypto")}; ` +
    `spikes ${spikes.size}; Reddit scraper tickers ${redditScraper.size}, both ${both}`;
  const warn = aw.failed.length > 0;
  return { line: warn ? `${line}; WARNING: ${aw.failed.join(", ")} failed${aw.stocks ? "" : ", Reddit hits fall back to the scraper"}` : line, warn };
}
