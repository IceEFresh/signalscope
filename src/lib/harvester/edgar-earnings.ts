/**
 * P3-0i3: historical earnings dates from SEC EDGAR (docs/PHASE3-PREP.md §P3-0i3).
 *
 * A US company furnishes its earnings release on Form 8-K, Item 2.02 ("Results of
 * Operations"). The submissions JSON (`data.sec.gov/submissions/CIK##########.json`) lists
 * every filing with its items and `acceptanceDateTime` (UTC). The release's trading session:
 * - accepted before 09:30 ET: that day's session (the gap is at that open);
 * - at or after 16:00 ET: the next session;
 * - in between: during the session, flagged; mapped to that day's session (8-Ks are often
 *   accepted an hour or two after a pre-open press release).
 * Weekends and holidays roll to the next session in the given session list.
 *
 * Foreign filers (20-F / 6-K) and most ADRs don't file 8-K 2.02: they get no dates, never a
 * guess. Pure except EdgarEarningsClient, which takes an injectable getter.
 */
import { etParts } from "./universe/bar-metrics";
import { withRetry } from "@/lib/yahoo-retry";

export const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
export const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
/** SEC asks for at most 10 requests per second; stay at 8. */
export const EDGAR_EARNINGS_MIN_INTERVAL_MS = 125;
export const EARNINGS_ITEM = "2.02";
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

export type EarningsTiming = "pre" | "post" | "during";

export interface EarningsFiling {
  accession: string;
  filingDate: string;
  /** ISO UTC, as EDGAR gives it. */
  acceptance: string;
  items: string[];
}

export interface EarningsEvent {
  /** The trading session whose open first reflects the release (YYYY-MM-DD). */
  session: string;
  timing: EarningsTiming;
  acceptance: string;
  filingDate: string;
  accession: string;
}

/** Yahoo and SEC spell share classes differently (BRK.B / BRK-B): compare upper case with dashes. */
export const normTicker = (t: string) => t.trim().toUpperCase().replace(/[./]/g, "-");

export const cik10 = (cik: number | string) => String(cik).replace(/^0+/, "").padStart(10, "0");

/** company_tickers.json ({"0": {cik_str, ticker, title}, …}) → normalized ticker → 10-digit CIK. */
export function parseTickerMap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!json || typeof json !== "object") return out;
  for (const row of Object.values(json as Record<string, unknown>)) {
    const r = row as { cik_str?: unknown; ticker?: unknown };
    if (typeof r?.ticker !== "string" || (typeof r.cik_str !== "number" && typeof r.cik_str !== "string")) continue;
    const t = normTicker(r.ticker);
    if (!out.has(t)) out.set(t, cik10(r.cik_str)); // the first listing wins (SEC lists the primary class first)
  }
  return out;
}

/** "2.02,9.01" → ["2.02", "9.01"]. */
export const parseItems = (items: unknown): string[] =>
  typeof items === "string" ? items.split(",").map((s) => s.trim()).filter(Boolean) : [];

type Columns = Record<string, unknown[]>;

/**
 * 8-K filings with Item 2.02 from a columnar block (`filings.recent` or an older page).
 * Amendments (8-K/A) are left out: they re-file a release already counted.
 */
export function earningsFilings(cols: unknown): EarningsFiling[] {
  const c = cols as Columns | null;
  if (!c || !Array.isArray(c.form)) return [];
  const out: EarningsFiling[] = [];
  for (let i = 0; i < c.form.length; i++) {
    if (c.form[i] !== "8-K") continue;
    const items = parseItems(c.items?.[i]);
    if (!items.includes(EARNINGS_ITEM)) continue;
    const acceptance = c.acceptanceDateTime?.[i];
    const filingDate = c.filingDate?.[i];
    if (typeof acceptance !== "string" || Number.isNaN(Date.parse(acceptance)) || typeof filingDate !== "string") continue;
    out.push({ accession: String(c.accessionNumber?.[i] ?? ""), filingDate, acceptance, items });
  }
  return out;
}

export interface SubmissionPage {
  name: string;
  filingFrom: string;
  filingTo: string;
}

/** Older pages that may hold filings on or after `from` (pages are listed newest first). */
export function pagesNeeded(submissions: unknown, from: string): SubmissionPage[] {
  const files = (submissions as { filings?: { files?: unknown } } | null)?.filings?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is SubmissionPage => typeof f?.name === "string" && typeof f?.filingTo === "string" && f.filingTo >= from);
}

/** First index in sorted `sessions` with value ≥ d (strict: > d); −1 if none. */
function firstSession(sessions: readonly string[], d: string, strict: boolean): number {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sessions[mid] <= d : sessions[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo < sessions.length ? lo : -1;
}

/** The session a release accepted at `acceptance` (ISO UTC) first trades on, against sorted `sessions`. */
export function earningsSession(acceptance: string, sessions: readonly string[]): { session: string; timing: EarningsTiming } | null {
  const { date, minutes } = etParts(new Date(acceptance));
  const timing: EarningsTiming = minutes < OPEN_MIN ? "pre" : minutes >= CLOSE_MIN ? "post" : "during";
  const i = firstSession(sessions, date, timing === "post");
  return i < 0 ? null : { session: sessions[i], timing };
}

/** One event per session (the earliest acceptance), oldest first, sessions ≥ `from`. */
export function earningsEvents(filings: readonly EarningsFiling[], sessions: readonly string[], from = ""): EarningsEvent[] {
  const bySession = new Map<string, EarningsEvent>();
  for (const f of [...filings].sort((a, b) => a.acceptance.localeCompare(b.acceptance))) {
    const s = earningsSession(f.acceptance, sessions);
    if (!s || s.session < from || bySession.has(s.session)) continue;
    bySession.set(s.session, { session: s.session, timing: s.timing, acceptance: f.acceptance, filingDate: f.filingDate, accession: f.accession });
  }
  return [...bySession.values()].sort((a, b) => a.session.localeCompare(b.session));
}

export type EdgarText = (url: string) => Promise<string>;

/**
 * Rate-limited (≤ 8/s) EDGAR fetcher with the shared retry (429 and 5xx back off; a 404 fails at once).
 * `get` throws an Error whose message carries the HTTP status, e.g. "edgar 404".
 */
export class EdgarEarningsClient {
  requests = 0;
  private last = 0;

  constructor(
    private readonly get: EdgarText,
    private readonly minIntervalMs = EDGAR_EARNINGS_MIN_INTERVAL_MS,
    private readonly retries = 3,
  ) {}

  async json(url: string): Promise<unknown> {
    const text = await withRetry(
      async () => {
        const wait = this.last + this.minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.last = Date.now();
        this.requests++;
        return this.get(url);
      },
      { label: "edgar", retries: this.retries },
    );
    return JSON.parse(text) as unknown;
  }
}

/** A fetch-based getter with the SEC user agent. */
export const edgarGetter =
  (userAgent: string): EdgarText =>
  async (url) => {
    const res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`edgar ${res.status}`);
    return res.text();
  };

/** Disk cache for the raw submissions JSON, keyed by file name; `null` = not cached. */
export interface EarningsCache {
  read: (name: string) => unknown | null;
  write: (name: string, json: unknown) => void;
}

/**
 * All 8-K 2.02 filings for one CIK from `from` on: `recent` plus the older pages that
 * reach back to `from`. Each JSON is read from the cache or fetched and cached.
 */
export async function fetchEarningsFilings(cik: string, from: string, client: EdgarEarningsClient, cache: EarningsCache): Promise<EarningsFiling[]> {
  const load = async (name: string) => {
    const hit = cache.read(name);
    if (hit != null) return hit;
    const json = await client.json(`${SUBMISSIONS_URL}/${name}`);
    cache.write(name, json);
    return json;
  };
  const main = (await load(`CIK${cik}.json`)) as { filings?: { recent?: unknown } };
  const out = earningsFilings(main?.filings?.recent);
  for (const page of pagesNeeded(main, from)) out.push(...earningsFilings(await load(page.name)));
  return out; // earningsEvents drops sessions before `from`
}

export interface EarningsCoverage {
  symbols: number;
  withDates: number;
  /** No CIK in the SEC ticker map (ETFs, some ADRs, renamed tickers). */
  noCik: number;
  /** A CIK but no 8-K Item 2.02 in range (foreign filers on 20-F / 6-K). */
  noFilings: number;
  failed: number;
  events: number;
  during: number;
}

export function earningsCoverageLine(c: EarningsCoverage): string {
  const pct = c.symbols ? ((100 * c.withDates) / c.symbols).toFixed(1) : "0.0";
  return (
    `[earnings] ${c.withDates}/${c.symbols} symbols (${pct}%) with EDGAR earnings dates; ${c.noCik} without a CIK, ` +
    `${c.noFilings} with no 8-K 2.02 in range, ${c.failed} failed; ${c.events} sessions, ${c.during} accepted during the session (flagged)`
  );
}

/**
 * Earnings events for each symbol: ticker → CIK, that CIK's 8-K 2.02 filings, mapped to
 * sessions ≥ `from`. A symbol with no CIK or no filings gets no entry (null downstream).
 * One fetch per CIK (share classes of one company share it).
 */
export async function buildEarnings(
  symbols: readonly string[],
  tickerMap: ReadonlyMap<string, string>,
  sessions: readonly string[],
  from: string,
  fetchFilings: (cik: string) => Promise<EarningsFiling[]>,
  onError: (symbol: string, err: unknown) => void = () => {},
): Promise<{ bySymbol: Map<string, { cik: string; events: EarningsEvent[] }>; coverage: EarningsCoverage }> {
  const bySymbol = new Map<string, { cik: string; events: EarningsEvent[] }>();
  const coverage: EarningsCoverage = { symbols: symbols.length, withDates: 0, noCik: 0, noFilings: 0, failed: 0, events: 0, during: 0 };
  const perCik = new Map<string, EarningsFiling[] | null>();
  for (const sym of symbols) {
    const cik = tickerMap.get(normTicker(sym));
    if (!cik) {
      coverage.noCik++;
      continue;
    }
    if (!perCik.has(cik)) {
      try {
        perCik.set(cik, await fetchFilings(cik));
      } catch (err) {
        perCik.set(cik, null);
        onError(sym, err);
      }
    }
    const filings = perCik.get(cik);
    if (filings == null) {
      coverage.failed++;
      continue;
    }
    const events = earningsEvents(filings, sessions, from);
    if (!events.length) {
      coverage.noFilings++;
      continue;
    }
    bySymbol.set(sym, { cik, events });
    coverage.withDates++;
    coverage.events += events.length;
    coverage.during += events.filter((e) => e.timing === "during").length;
  }
  return { bySymbol, coverage };
}

/** The per-ticker output file (scripts/output/backfill-earnings/<SYMBOL>.json) → earnings sessions. */
export function earningsSessionsFromFile(json: unknown): Set<string> {
  const ev = (json as { events?: unknown } | null)?.events;
  return new Set(Array.isArray(ev) ? ev.map((e) => (e as { session?: unknown })?.session).filter((s): s is string => typeof s === "string") : []);
}
