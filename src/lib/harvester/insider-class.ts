/**
 * Routine vs opportunistic insiders, PLAN.md PR 2a (Cohen, Malloy & Pomorski
 * 2012). LOG ONLY: the class is stored in ValidatedTicker.features and on
 * graduation-watch rows; no score, stage or label reads it until Phase 3.
 *
 * Rule, on open-market trades only (Form 4 non-derivative transaction codes P
 * and S): an insider with an open-market trade in each of the 3 calendar years
 * before the current trade is classifiable. They are "routine" if each of those
 * years has an open-market trade in the current trade's calendar month,
 * otherwise "opportunistic". Anyone without 3 such years is "unclassified".
 * Grants (A), exercises (M), tax withholding (F) and gifts (G) never count.
 *
 * History: EDGAR full-text search lists the insider's Form 4s at the issuer
 * (efts.sec.gov), then each prior-year filing's XML is read for its P/S rows.
 * Filings in the trade's month are read first and a year stops as soon as it
 * is settled, so most insiders need far fewer than the cap. Hitting the cap
 * before every year is settled gives "unclassified", never a guess.
 */
import type { RawSignal } from "./types";

export type InsiderClass = "routine" | "opportunistic" | "unclassified";

export const PRIOR_YEARS = 3;
export const INSIDER_CLASS_BASIS = "form4_open_market_ps";
/** Most Form 4 XMLs read per insider-trade before giving up as unclassified. */
export const MAX_XML_PER_INSIDER = 40;
/** Spacing between EDGAR requests: 150 ms is under 7 per second (SEC allows 10; review asked for <= 8). */
export const EDGAR_MIN_INTERVAL_MS = 150;

const OPEN_MARKET_CODES = new Set(["P", "S"]);

export interface InsiderClassResult {
  insiderClass: InsiderClass;
  /** How many of the 3 prior years have an open-market trade. */
  priorYearsWithTrades: number;
  /** How many of the 3 prior years have an open-market trade in the current trade's month. */
  priorYearsSameMonth: number;
}

/** A Form 4 listed by EDGAR full-text search. */
export interface Form4Filing {
  /** `period_ending`: earliest transaction date of any type, YYYY-MM-DD. */
  periodEnding: string;
  xmlUrl: string;
}

/** This issuer's Form 4 filings in an efts response, with each filing's XML URL. */
export function parseEftsForm4Filings(json: unknown, ticker: string): Form4Filing[] {
  const hits = (json as { hits?: { hits?: Array<{ _id?: unknown; _source?: Record<string, unknown> }> } })?.hits?.hits ?? [];
  const tag = `(${ticker.toUpperCase()})`;
  const out: Form4Filing[] = [];
  for (const h of hits) {
    const s = h._source ?? {};
    if (s.form !== "4" && s.file_type !== "4") continue;
    const names = Array.isArray(s.display_names) ? (s.display_names as string[]) : [];
    const issuer = names.find((n) => n.toUpperCase().includes(tag));
    const cik = issuer?.match(/\(CIK (\d+)\)/)?.[1];
    const [adsh, file] = typeof h._id === "string" ? h._id.split(":") : [];
    const date = typeof s.period_ending === "string" ? s.period_ending : typeof s.file_date === "string" ? s.file_date : null;
    if (!cik || !adsh || !file || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      periodEnding: date,
      xmlUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${file}`,
    });
  }
  return out;
}

export function eftsTotal(json: unknown): number {
  const v = (json as { hits?: { total?: { value?: unknown } } })?.hits?.total?.value;
  return typeof v === "number" ? v : 0;
}

/** Dates (YYYY-MM-DD) of the open-market (P or S) non-derivative rows in a Form 4 XML. */
export function parseForm4OpenMarketDates(xml: string): string[] {
  const out: string[] = [];
  for (const block of xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? []) {
    const code = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/)?.[1];
    const date = block.match(/<transactionDate>\s*<value>\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    if (code && date && OPEN_MARKET_CODES.has(code)) out.push(date);
  }
  return out;
}

/** Classify the trade on `tradeDate` (YYYY-MM-DD) from the insider's prior open-market trade dates. */
export function classifyInsider(history: readonly string[], tradeDate: string): InsiderClassResult {
  const year = Number(tradeDate.slice(0, 4));
  const month = tradeDate.slice(5, 7);
  let priorYearsWithTrades = 0;
  let priorYearsSameMonth = 0;
  for (let y = year - 1; y >= year - PRIOR_YEARS; y--) {
    const inYear = history.filter((d) => d.startsWith(`${y}-`));
    if (inYear.length > 0) priorYearsWithTrades++;
    if (inYear.some((d) => d.slice(5, 7) === month)) priorYearsSameMonth++;
  }
  const insiderClass: InsiderClass =
    priorYearsWithTrades < PRIOR_YEARS ? "unclassified" : priorYearsSameMonth === PRIOR_YEARS ? "routine" : "opportunistic";
  return { insiderClass, priorYearsWithTrades, priorYearsSameMonth };
}

/** GET as text with the SEC user agent. */
export type EdgarGet = (url: string, userAgent: string) => Promise<string>;

const defaultEdgarGet: EdgarGet = async (url, userAgent) => {
  const res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`edgar ${res.status}`);
  return res.text();
};

/** Paces every EDGAR request in a run and counts them for the log. */
export class EdgarClient {
  requests = 0;
  private last = 0;

  constructor(
    private readonly userAgent: string,
    private readonly get: EdgarGet = defaultEdgarGet,
    private readonly minIntervalMs: number = EDGAR_MIN_INTERVAL_MS,
  ) {}

  async fetch(url: string): Promise<string> {
    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    this.requests++;
    return this.get(url, this.userAgent);
  }
}

const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/** This insider's Form 4 filings at this issuer in the 3 calendar years before `tradeDate`. */
export async function fetchInsiderForm4Filings(
  insiderName: string,
  ticker: string,
  tradeDate: string,
  client: EdgarClient,
): Promise<Form4Filing[]> {
  const year = Number(tradeDate.slice(0, 4));
  const params = (from: number) =>
    new URLSearchParams({
      q: `"${insiderName}"`,
      forms: "4",
      dateRange: "custom",
      startdt: `${year - PRIOR_YEARS}-01-01`,
      // Only prior years count; a few weeks of slack catches late filings for December trades.
      enddt: `${year}-02-15` < tradeDate ? `${year}-02-15` : tradeDate,
      from: String(from),
    });
  const out: Form4Filing[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = JSON.parse(await client.fetch(`${EFTS_URL}?${params(page * PAGE_SIZE)}`)) as unknown;
    out.push(...parseEftsForm4Filings(json, ticker));
    if ((page + 1) * PAGE_SIZE >= eftsTotal(json)) break;
  }
  return out;
}

export interface OpenMarketClassResult extends InsiderClassResult {
  xmlFetched: number;
  capHit: boolean;
}

/**
 * Read Form 4 XMLs year by year until each prior year is settled: a P/S in the
 * trade's month settles it fully; a P/S in another month settles "has a trade"
 * but keeps looking for the month; no filings left means no trade that year.
 * A year with no open-market trade makes the insider unclassified, so reading stops.
 */
export async function classifyFromFilings(
  filings: readonly Form4Filing[],
  tradeDate: string,
  client: EdgarClient,
  maxXml: number = MAX_XML_PER_INSIDER,
): Promise<OpenMarketClassResult> {
  const year = Number(tradeDate.slice(0, 4));
  const month = tradeDate.slice(5, 7);
  const history: string[] = [];
  const seen = new Set<string>();
  let xmlFetched = 0;
  for (let y = year - 1; y >= year - PRIOR_YEARS; y--) {
    const inYear = filings.filter((f) => f.periodEnding.startsWith(`${y}-`) && !seen.has(f.xmlUrl));
    const ordered = [...inYear.filter((f) => f.periodEnding.slice(5, 7) === month), ...inYear.filter((f) => f.periodEnding.slice(5, 7) !== month)];
    let hasAny = history.some((d) => d.startsWith(`${y}-`));
    let hasMonth = history.some((d) => d.startsWith(`${y}-${month}`));
    for (const f of ordered) {
      if (hasMonth) break;
      if (xmlFetched >= maxXml) {
        return { ...classifyInsider([], tradeDate), insiderClass: "unclassified", xmlFetched, capHit: true };
      }
      seen.add(f.xmlUrl);
      xmlFetched++;
      const dates = parseForm4OpenMarketDates(await client.fetch(f.xmlUrl));
      history.push(...dates);
      hasAny ||= dates.some((d) => d.startsWith(`${y}-`));
      hasMonth ||= dates.some((d) => d.startsWith(`${y}-${month}`));
    }
    if (!hasAny) break; // unclassified whatever the other years hold
  }
  return { ...classifyInsider(history, tradeDate), xmlFetched, capHit: false };
}

function tradeDateOf(s: RawSignal): string | null {
  const d = s.tradeDate ?? s.filedAt ?? null;
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

/**
 * Annotate SEC_INSIDER signals with the insider's class (harvester side).
 * Needs SEC_USER_AGENT (SEC asks automated clients for a contact); without it
 * every signal stays unannotated. One classification per distinct insider,
 * ticker and trade date; a failed EDGAR request leaves that insider unannotated.
 */
export async function annotateInsiderClasses(
  signals: RawSignal[],
  {
    userAgent = process.env.SEC_USER_AGENT,
    get,
    minIntervalMs,
    maxXml,
  }: { userAgent?: string; get?: EdgarGet; minIntervalMs?: number; maxXml?: number } = {},
): Promise<void> {
  const insider = signals.filter((s) => s.source === "SEC_INSIDER" && s.author && tradeDateOf(s));
  if (insider.length === 0) return;
  if (!userAgent) {
    console.warn("[insider-class] SEC_USER_AGENT not set: routine/opportunistic classification skipped");
    return;
  }
  const client = new EdgarClient(userAgent, get, minIntervalMs);
  const cache = new Map<string, InsiderClassResult | null>();
  let failed = 0;
  let capped = 0;
  for (const s of insider) {
    const date = tradeDateOf(s)!;
    const key = `${s.author}|${s.symbol}|${date}`;
    if (!cache.has(key)) {
      try {
        const filings = await fetchInsiderForm4Filings(s.author!, s.symbol, date, client);
        const r = await classifyFromFilings(filings, date, client, maxXml);
        if (r.capHit) capped++;
        cache.set(key, r);
      } catch {
        failed++;
        cache.set(key, null);
      }
    }
    const r = cache.get(key);
    if (r) {
      s.insiderClass = r.insiderClass;
      s.insiderPriorYears = r.priorYearsWithTrades;
    }
  }
  const results = [...cache.values()];
  const n = (c: InsiderClass) => results.filter((r) => r?.insiderClass === c).length;
  console.log(
    `[insider-class] ${cache.size} insiders, ${n("routine")} routine / ${n("opportunistic")} opportunistic / ` +
      `${n("unclassified")} unclassified, ${client.requests} EDGAR requests` +
      (capped ? `, ${capped} hit the ${maxXml ?? MAX_XML_PER_INSIDER}-filing cap` : "") +
      (failed ? `, ${failed} failed` : ""),
  );
}

/** Per-ticker summary keys for features (log only). */
export function insiderClassFeatures(signals: readonly RawSignal[]): Record<string, number | string | null> {
  const ins = signals.filter((s) => s.source === "SEC_INSIDER");
  if (ins.length === 0) return {};
  const n = (c: InsiderClass) => ins.filter((s) => s.insiderClass === c).length;
  const opp = n("opportunistic");
  const rou = n("routine");
  const unc = n("unclassified");
  return {
    insider_opportunistic_count: opp,
    insider_routine_count: rou,
    insider_unclassified_count: unc,
    insider_class: opp > 0 ? "opportunistic" : rou > 0 ? "routine" : unc > 0 ? "unclassified" : null,
    insider_class_basis: opp + rou + unc > 0 ? INSIDER_CLASS_BASIS : null,
  };
}
