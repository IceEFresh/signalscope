/**
 * Routine vs opportunistic insiders, PLAN.md PR 2a (Cohen, Malloy & Pomorski
 * 2012). LOG ONLY: the class is stored in ValidatedTicker.features and on
 * graduation-watch rows; no score, stage or label reads it until Phase 3.
 *
 * Rule: an insider with trades in each of the 3 calendar years before the
 * current trade is classifiable. They are "routine" if each of those 3 years
 * has a trade in the same calendar month as the current trade, otherwise
 * "opportunistic". Anyone without 3 prior years of history is "unclassified".
 *
 * History comes from EDGAR full-text search (efts.sec.gov) over the insider's
 * Form 4 filings for the same issuer. Basis caveat: a filing's
 * `period_ending` is its earliest transaction of ANY type (grants and option
 * exercises included), so annual grant cycles count as trades. The search
 * result has no transaction codes; filtering to open-market trades would need
 * one XML fetch per filing.
 */
import type { RawSignal } from "./types";

export type InsiderClass = "routine" | "opportunistic" | "unclassified";

export const PRIOR_YEARS = 3;
export const INSIDER_CLASS_BASIS = "form4_any_transaction";

export interface InsiderClassResult {
  insiderClass: InsiderClass;
  /** How many of the 3 prior years have any trade. */
  priorYearsWithTrades: number;
  /** How many of the 3 prior years have a trade in the current trade's month. */
  priorYearsSameMonth: number;
}

/** Transaction dates (YYYY-MM-DD) of this issuer's Form 4 filings in an efts response. */
export function parseEftsForm4Dates(json: unknown, ticker: string): string[] {
  const hits = (json as { hits?: { hits?: Array<{ _source?: Record<string, unknown> }> } })?.hits?.hits ?? [];
  const tag = `(${ticker.toUpperCase()})`;
  const out: string[] = [];
  for (const h of hits) {
    const s = h._source ?? {};
    if (s.form !== "4" && s.file_type !== "4") continue;
    const names = Array.isArray(s.display_names) ? (s.display_names as string[]) : [];
    if (!names.some((n) => n.toUpperCase().includes(tag))) continue;
    const date = typeof s.period_ending === "string" ? s.period_ending : typeof s.file_date === "string" ? s.file_date : null;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push(date);
  }
  return out;
}

export function eftsTotal(json: unknown): number {
  const v = (json as { hits?: { total?: { value?: unknown } } })?.hits?.total?.value;
  return typeof v === "number" ? v : 0;
}

/** Classify the trade on `tradeDate` (YYYY-MM-DD) from the insider's prior trade dates. */
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

const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export type EftsFetch = (url: string, userAgent: string) => Promise<unknown>;

const defaultEftsFetch: EftsFetch = async (url, userAgent) => {
  const res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`efts ${res.status}`);
  return res.json();
};

/** This insider's Form 4 transaction dates at this issuer, from Jan 1 three years before `tradeDate`. */
export async function fetchInsiderForm4Dates(
  insiderName: string,
  ticker: string,
  tradeDate: string,
  userAgent: string,
  get: EftsFetch = defaultEftsFetch,
): Promise<string[]> {
  const start = `${Number(tradeDate.slice(0, 4)) - PRIOR_YEARS}-01-01`;
  const dates: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      q: `"${insiderName}"`,
      forms: "4",
      dateRange: "custom",
      startdt: start,
      enddt: tradeDate,
      from: String(page * PAGE_SIZE),
    });
    const json = await get(`${EFTS_URL}?${params}`, userAgent);
    dates.push(...parseEftsForm4Dates(json, ticker));
    if ((page + 1) * PAGE_SIZE >= eftsTotal(json)) break;
    await new Promise((r) => setTimeout(r, 150)); // SEC fair access: well under 10 requests/s
  }
  return dates;
}

function tradeDateOf(s: RawSignal): string | null {
  const d = s.tradeDate ?? s.filedAt ?? null;
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

/**
 * Annotate SEC_INSIDER signals with the insider's class (harvester side).
 * Needs SEC_USER_AGENT (SEC asks automated clients for a contact); without it
 * every signal stays unannotated. One EDGAR query per distinct insider and
 * ticker; a failed query leaves that insider unannotated.
 */
export async function annotateInsiderClasses(
  signals: RawSignal[],
  { userAgent = process.env.SEC_USER_AGENT, get }: { userAgent?: string; get?: EftsFetch } = {},
): Promise<void> {
  const insider = signals.filter((s) => s.source === "SEC_INSIDER" && s.author && tradeDateOf(s));
  if (insider.length === 0) return;
  if (!userAgent) {
    console.warn("[insider-class] SEC_USER_AGENT not set: routine/opportunistic classification skipped");
    return;
  }
  const cache = new Map<string, InsiderClassResult | null>();
  let failed = 0;
  for (const s of insider) {
    const date = tradeDateOf(s)!;
    const key = `${s.author}|${s.symbol}|${date}`;
    if (!cache.has(key)) {
      try {
        const history = await fetchInsiderForm4Dates(s.author!, s.symbol, date, userAgent, get);
        // The current trade's own filing is excluded by year (only prior years count).
        cache.set(key, classifyInsider(history, date));
      } catch {
        failed++;
        cache.set(key, null);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const r = cache.get(key);
    if (r) {
      s.insiderClass = r.insiderClass;
      s.insiderPriorYears = r.priorYearsWithTrades;
    }
  }
  const counts = insider.reduce<Record<string, number>>((m, s) => ((m[s.insiderClass ?? "failed"] = (m[s.insiderClass ?? "failed"] ?? 0) + 1), m), {});
  console.log(`[insider-class] ${JSON.stringify(counts)} (EDGAR queries failed: ${failed})`);
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
