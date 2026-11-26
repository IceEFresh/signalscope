/**
 * P3-0n live: the ins_* (EDGAR Form 4), si_* (FINRA short interest) and sv_* (FINRA daily
 * short volume) keys on each snapshot row, log-only, plus the health lines. Same code paths and
 * caches as the backfill scripts, so live and backfill values are built the same way.
 *
 * Requests per harvest: one submissions JSON per issuer (refetched for new Form 4s; ≤ 8/s) plus
 * each new Form 4 XML; one short-volume file for the newest session (older ones are cached); the
 * short interest candidates of the last ~5 weeks until each half-month's file is found.
 */
import { buysAccepted, fetchForm4History, insiderEvents, insiderFeaturesAt, type Form4Cache, type Form4Client, type InsiderEvent } from "./form4-history";
import { fetchShortInterest, fetchShortVolume, siFeaturesAt, siRowsFor, svFeaturesAt, svRatiosFor, SV_WINDOW, type FinraCache, type FinraGet } from "./finra";

/** Form 4s accepted from this many days back (the 30-day window plus the 10-session cluster). */
export const LIVE_FORM4_DAYS = 45;
/** Short interest candidates from this many days back (two reports, publication lag included). */
export const LIVE_SI_DAYS = 40;

export interface HistoryRow {
  symbol: string;
  sessionDate: string;
}

const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export interface Form4LiveResult {
  features: Record<string, Record<string, unknown>>;
  /** Every symbol's events (for the health line). */
  events: Map<string, InsiderEvent[]>;
  stats: { symbols: number; withCik: number; failed: number; xmlFetched: number; xmlFailed: number };
}

/** ins_* for each row (null-free: a symbol without a CIK or whose fetch failed gets no keys). */
export async function form4Live(
  rows: readonly HistoryRow[],
  sessions: readonly string[],
  today: string,
  cikOf: (symbol: string) => string | undefined,
  client: Form4Client,
  cache: Form4Cache,
): Promise<Form4LiveResult> {
  const from = daysBefore(today, LIVE_FORM4_DAYS);
  const res: Form4LiveResult = { features: {}, events: new Map(), stats: { symbols: rows.length, withCik: 0, failed: 0, xmlFetched: 0, xmlFailed: 0 } };
  const perCik = new Map<string, InsiderEvent[] | null>();
  for (const r of rows) {
    const cik = cikOf(r.symbol);
    if (!cik) continue;
    res.stats.withCik++;
    if (!perCik.has(cik)) {
      const stats = { filings: 0, xmlFetched: 0, xmlFailed: 0 };
      try {
        perCik.set(cik, insiderEvents(await fetchForm4History(cik, from, client, cache, { refreshMain: true, stats }), sessions));
      } catch {
        perCik.set(cik, null);
      }
      res.stats.xmlFetched += stats.xmlFetched;
      res.stats.xmlFailed += stats.xmlFailed;
    }
    const ev = perCik.get(cik);
    if (ev == null) {
      res.stats.failed++;
      continue;
    }
    res.events.set(r.symbol, ev);
    res.features[r.symbol] = { ...insiderFeaturesAt(ev, r.sessionDate, sessions) };
  }
  return res;
}

/**
 * `[form4] live: EDGAR P-code buys accepted in the last day n (symbols a); live insider source
 * m (symbols b); both k` — the two sources over the same rows.
 */
export function form4LiveLine(
  r: Form4LiveResult,
  liveInsiderSymbols: ReadonlySet<string>,
  fromIso: string,
  toIso: string,
): { line: string; warn: boolean } {
  const edgar = new Set<string>();
  let n = 0;
  for (const [sym, ev] of r.events) {
    const b = buysAccepted(ev, fromIso, toIso);
    n += b.length;
    if (b.length) edgar.add(sym);
  }
  const live = [...liveInsiderSymbols].filter((s) => r.events.has(s));
  const both = live.filter((s) => edgar.has(s)).length;
  const s = r.stats;
  const warn = s.withCik > 0 && s.failed / s.withCik > 0.2;
  const line =
    `[form4] live: ${s.withCik - s.failed}/${s.symbols} rows with EDGAR Form 4 keys (${s.failed} failed, ${s.xmlFetched} new XML, ${s.xmlFailed} XML failed); ` +
    `P-code buys accepted ${fromIso.slice(0, 16)}–${toIso.slice(0, 16)}Z: EDGAR ${n} (${edgar.size} symbols), live insider source ${live.length} symbols, both ${both}`;
  return { line: warn ? `${line}; WARNING: over 20% of issuers failed` : line, warn };
}

export interface FinraLiveResult {
  features: Record<string, Record<string, unknown>>;
  line: string;
  warn: boolean;
}

/** si_* and sv_* for each row; si_pct_float uses the floats file (null without a float). */
export async function finraLive(
  rows: readonly HistoryRow[],
  sessions: readonly string[],
  today: string,
  floats: Readonly<Record<string, number | null>> | null,
  get: FinraGet,
  cache: FinraCache,
): Promise<FinraLiveResult> {
  const newest = rows.reduce((m, r) => (r.sessionDate > m ? r.sessionDate : m), "");
  const upto = sessions.filter((s) => s <= newest);
  const svSessions = upto.slice(-(SV_WINDOW + 1));
  const reports = await fetchShortInterest(daysBefore(today, LIVE_SI_DAYS), today, get, cache);
  const sv = await fetchShortVolume(svSessions, get, cache);
  const features: Record<string, Record<string, unknown>> = {};
  let si = 0;
  let svN = 0;
  let fl = 0;
  for (const r of rows) {
    const ratios = svRatiosFor(sv, svSessions, r.symbol);
    const i = svSessions.indexOf(r.sessionDate);
    const svF = i >= 0 ? svFeaturesAt(ratios, i) : { sv_ratio: null, sv_ratio_20d: null, sv_z: null };
    const float = floats?.[r.symbol] ?? null;
    const siF = siFeaturesAt(siRowsFor(reports, r.symbol), r.sessionDate, sessions, float);
    features[r.symbol] = { ...siF, ...svF };
    if (siF.si_shares != null) si++;
    if (svF.sv_ratio != null) svN++;
    if (float != null) fl++;
  }
  const latest = reports.at(-1)?.settlement ?? "none";
  const svToday = sv.get(newest) != null;
  const warn = rows.length > 0 && (!svToday || si / rows.length < 0.5);
  const line =
    `[finra] short volume ${newest}: ${svToday ? "file ok" : "file missing"}, ${svN}/${rows.length} rows; ` +
    `short interest (latest settlement fetched ${latest}): ${si}/${rows.length} rows; floats ${fl}/${rows.length}`;
  return { features, line: warn ? `${line}; WARNING: short volume missing or short interest under 50% of rows` : line, warn };
}
