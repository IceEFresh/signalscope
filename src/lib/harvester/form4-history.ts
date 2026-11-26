/**
 * P3-0n §1: insider transactions from SEC EDGAR Form 4, with history (docs/PHASE3-PREP.md §P3-0n).
 * Log-only and descriptive.
 *
 * Source: the issuer's submissions JSON (the same files P3-0i3 reads) lists every Form 4 and
 * 4/A about the company, with `acceptanceDateTime` (UTC). Each filing's raw XML is
 * `Archives/edgar/data/<issuer CIK>/<accession without dashes>/<primaryDocument without the
 * xslF345X0n/ rendering prefix>`.
 *
 * Timing: the signal session is the filing's **acceptance** time mapped like P3-0i3 (at or
 * after 16:00 ET → the next session; earlier → that day's session, weekends and holidays roll
 * forward), never the transaction date: insiders have up to 2 business days to file.
 *
 * Codes: open-market buys are `P`, sales `S`; every other code (grants A, exercises M, tax F,
 * gifts G, …) is kept and tagged non-signal. Non-derivative transactions only.
 *
 * Amendments: a 4/A replaces the original Form 4 (same reporting owners and period of report,
 * filed on the 4/A's `dateOfOriginalSubmission` when given). The amended rows take the 4/A's own
 * acceptance time, so a correction is never back-dated (no look-ahead).
 */
import { earningsSession } from "./edgar-earnings";

export const ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";
export const FORM4_FORMS = new Set(["4", "4/A"]);
/** Calendar days in the ins_*_30d windows. */
export const INS_WINDOW_DAYS = 30;
/** ins_cluster: ≥ 2 distinct insiders buying within this many sessions (the current one included). */
export const INS_CLUSTER_SESSIONS = 10;
export const INS_CLUSTER_MIN_BUYERS = 2;

export interface Form4Filing {
  form: "4" | "4/A";
  accession: string;
  filingDate: string;
  /** ISO UTC, as EDGAR gives it. */
  acceptance: string;
  /** The raw XML's URL. */
  xmlUrl: string;
}

type Columns = Record<string, unknown[]>;

/** Raw XML URL from the issuer CIK, accession and primaryDocument (drops the XSL rendering folder). */
export function form4XmlUrl(cik: string, accession: string, primaryDocument: string): string {
  const doc = primaryDocument.replace(/^xslF345X\d+\//, "");
  return `${ARCHIVES_URL}/${String(cik).replace(/^0+/, "")}/${accession.replace(/-/g, "")}/${doc}`;
}

/** Form 4 and 4/A filings from a columnar submissions block (`filings.recent` or an older page). */
export function form4Filings(cols: unknown, cik: string): Form4Filing[] {
  const c = cols as Columns | null;
  if (!c || !Array.isArray(c.form)) return [];
  const out: Form4Filing[] = [];
  for (let i = 0; i < c.form.length; i++) {
    const form = c.form[i];
    if (form !== "4" && form !== "4/A") continue;
    const acceptance = c.acceptanceDateTime?.[i];
    const filingDate = c.filingDate?.[i];
    const accession = c.accessionNumber?.[i];
    const doc = c.primaryDocument?.[i];
    if (typeof acceptance !== "string" || Number.isNaN(Date.parse(acceptance)) || typeof filingDate !== "string") continue;
    if (typeof accession !== "string" || typeof doc !== "string" || !doc.endsWith(".xml")) continue;
    out.push({ form, accession, filingDate, acceptance, xmlUrl: form4XmlUrl(cik, accession, doc) });
  }
  return out;
}

export interface Form4Owner {
  cik: string;
  name: string;
  director: boolean;
  officer: boolean;
  tenPct: boolean;
  officerTitle: string | null;
}

export interface Form4Txn {
  date: string | null;
  code: string;
  shares: number | null;
  price: number | null;
  /** A = acquired, D = disposed. */
  acquiredDisposed: "A" | "D" | null;
  /** P (buy) and S (sale) only. */
  signal: boolean;
}

export interface Form4Doc {
  documentType: string;
  periodOfReport: string | null;
  dateOfOriginalSubmission: string | null;
  owners: Form4Owner[];
  txns: Form4Txn[];
}

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
};
/** `<x><value>…</value></x>` or `<x>…</x>`, trimmed; null when absent or empty. */
const val = (xml: string, name: string): string | null => {
  const inner = tag(xml, name);
  if (inner == null) return null;
  const v = (tag(inner, "value") ?? inner).trim();
  return v === "" ? null : v;
};
const num = (s: string | null): number | null => {
  if (s == null) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const bool = (s: string | null) => s != null && /^(1|true)$/i.test(s.trim());
const blocks = (xml: string, name: string): string[] => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "g")) ?? [];

/** Parse a Form 4 / 4/A ownershipDocument. Null when it isn't one. */
export function parseForm4(xml: string): Form4Doc | null {
  if (!/<ownershipDocument>/.test(xml)) return null;
  const owners: Form4Owner[] = blocks(xml, "reportingOwner").map((o) => ({
    cik: (val(o, "rptOwnerCik") ?? "").replace(/^0+/, ""),
    name: val(o, "rptOwnerName") ?? "",
    director: bool(val(o, "isDirector")),
    officer: bool(val(o, "isOfficer")),
    tenPct: bool(val(o, "isTenPercentOwner")),
    officerTitle: val(o, "officerTitle"),
  }));
  const txns: Form4Txn[] = blocks(xml, "nonDerivativeTransaction").map((t) => {
    const code = (val(t, "transactionCode") ?? "").toUpperCase();
    const ad = val(t, "transactionAcquiredDisposedCode");
    return {
      date: val(t, "transactionDate"),
      code,
      shares: num(val(t, "transactionShares")),
      price: num(val(t, "transactionPricePerShare")),
      acquiredDisposed: ad === "A" || ad === "D" ? ad : null,
      signal: code === "P" || code === "S",
    };
  });
  return {
    documentType: val(xml, "documentType") ?? "",
    periodOfReport: val(xml, "periodOfReport"),
    dateOfOriginalSubmission: val(xml, "dateOfOriginalSubmission"),
    owners,
    txns,
  };
}

export interface ParsedFiling {
  filing: Form4Filing;
  doc: Form4Doc;
}

const ownerKey = (d: Form4Doc) => d.owners.map((o) => o.cik).sort().join(",");

/**
 * Apply amendments: each 4/A replaces the original Form 4 with the same owners and period of
 * report (filed on its dateOfOriginalSubmission when given, else the latest earlier one). The
 * 4/A is kept with its own acceptance time. A 4/A with no matching original is kept as is.
 */
export function applyAmendments(filings: readonly ParsedFiling[]): ParsedFiling[] {
  const sorted = [...filings].sort((a, b) => a.filing.acceptance.localeCompare(b.filing.acceptance));
  const dropped = new Set<ParsedFiling>();
  for (const a of sorted) {
    if (a.filing.form !== "4/A") continue;
    const candidates = sorted.filter(
      (o) =>
        o !== a &&
        !dropped.has(o) &&
        o.filing.acceptance < a.filing.acceptance &&
        ownerKey(o.doc) === ownerKey(a.doc) &&
        o.doc.periodOfReport === a.doc.periodOfReport,
    );
    const orig = a.doc.dateOfOriginalSubmission ? candidates.filter((o) => o.filing.filingDate === a.doc.dateOfOriginalSubmission) : candidates;
    const target = orig.at(-1) ?? candidates.at(-1);
    if (target) dropped.add(target);
  }
  return sorted.filter((f) => !dropped.has(f));
}

export interface InsiderEvent {
  /** Signal session (from the acceptance time). */
  session: string;
  acceptance: string;
  accession: string;
  ownerCik: string;
  officer: boolean;
  director: boolean;
  tenPct: boolean;
  code: string;
  signal: boolean;
  shares: number;
  usd: number | null;
  transactionDate: string | null;
}

/**
 * One event per (filing, code): shares and dollars summed over the filing's rows of that code.
 * A joint filing (an insider and their fund report the same shares) is one trade: it's credited
 * to the first reporting owner, with the roles of all owners. Sorted by session.
 */
export function insiderEvents(filings: readonly ParsedFiling[], sessions: readonly string[]): InsiderEvent[] {
  const out: InsiderEvent[] = [];
  for (const { filing, doc } of applyAmendments(filings)) {
    const s = earningsSession(filing.acceptance, sessions);
    if (!s) continue;
    const byCode = new Map<string, { shares: number; usd: number | null; date: string | null }>();
    for (const t of doc.txns) {
      const e = byCode.get(t.code) ?? { shares: 0, usd: null, date: t.date };
      e.shares += t.shares ?? 0;
      // Dollars from the rows with both shares and price (grants and gifts usually have no price)
      if (t.shares != null && t.price != null) e.usd = (e.usd ?? 0) + t.shares * t.price;
      if (t.date && (!e.date || t.date < e.date)) e.date = t.date;
      byCode.set(t.code, e);
    }
    const first = doc.owners[0];
    if (!first) continue;
    for (const [code, e] of byCode)
      out.push({
        session: s.session,
        acceptance: filing.acceptance,
        accession: filing.accession,
        ownerCik: first.cik,
        officer: doc.owners.some((o) => o.officer),
        director: doc.owners.some((o) => o.director),
        tenPct: doc.owners.some((o) => o.tenPct),
        code,
        signal: code === "P" || code === "S",
        shares: e.shares,
        usd: e.usd,
        transactionDate: e.date,
      });
  }
  return out.sort((a, b) => a.session.localeCompare(b.session) || a.acceptance.localeCompare(b.acceptance));
}

export interface InsiderFeatures {
  /** P-code buys (one per filing and owner) with a signal session in the last 30 calendar days. */
  ins_buy_n_30d: number;
  ins_buy_usd_30d: number;
  /** Distinct insiders buying in the window. */
  ins_buyers_30d: number;
  /** ≥ 2 distinct insiders buying within the last 10 sessions (this one included). */
  ins_cluster: boolean;
  /** An officer among the window's buyers. */
  ins_officer_buy: boolean;
  ins_sell_usd_30d: number;
}

export const INS_KEYS = ["ins_buy_n_30d", "ins_buy_usd_30d", "ins_buyers_30d", "ins_cluster", "ins_officer_buy", "ins_sell_usd_30d"] as const;

const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Features as of `session` from events known by then (signal session ≤ session). `sessions`
 * (sorted) sets the 10-session cluster window. Pure.
 */
export type Nullable<T> = { [K in keyof T]: T[K] | null };

/**
 * P3-0k5: before the source's first covered date (`coverageFrom`, the backfill's `from`) every
 * key is null, never 0: no data is not "no insider buying".
 */
export function insiderFeaturesAt(events: readonly InsiderEvent[], session: string, sessions: readonly string[], coverageFrom?: string): Nullable<InsiderFeatures> {
  if (coverageFrom && session < coverageFrom) return Object.fromEntries(INS_KEYS.map((k) => [k, null])) as Nullable<InsiderFeatures>;
  const from = minusDays(session, INS_WINDOW_DAYS); // exclusive
  const win = events.filter((e) => e.session > from && e.session <= session);
  const buys = win.filter((e) => e.code === "P");
  const i = sessions.indexOf(session);
  const clusterFrom = i >= 0 ? sessions[Math.max(0, i - (INS_CLUSTER_SESSIONS - 1))] : session;
  const clusterBuyers = new Set(events.filter((e) => e.code === "P" && e.session >= clusterFrom && e.session <= session).map((e) => e.ownerCik));
  return {
    ins_buy_n_30d: buys.length,
    ins_buy_usd_30d: Math.round(buys.reduce((s, e) => s + (e.usd ?? 0), 0)),
    ins_buyers_30d: new Set(buys.map((e) => e.ownerCik)).size,
    ins_cluster: clusterBuyers.size >= INS_CLUSTER_MIN_BUYERS,
    ins_officer_buy: buys.some((e) => e.officer),
    ins_sell_usd_30d: Math.round(win.filter((e) => e.code === "S").reduce((s, e) => s + (e.usd ?? 0), 0)),
  };
}

/** P-code buys whose acceptance falls in [fromIso, toIso) (the health line's "found today"). */
export function buysAccepted(events: readonly InsiderEvent[], fromIso: string, toIso: string): InsiderEvent[] {
  return events.filter((e) => e.code === "P" && e.acceptance >= fromIso && e.acceptance < toIso);
}

// ── Fetching (cached) ────────────────────────────────────────────────────────────

export interface Form4Client {
  json(url: string): Promise<unknown>;
  text(url: string): Promise<string>;
}

/** Disk caches: submissions JSON by file name, Form 4 XML by accession. `null` = not cached. */
export interface Form4Cache {
  readJson: (name: string) => unknown | null;
  writeJson: (name: string, json: unknown) => void;
  readXml: (accession: string) => string | null;
  writeXml: (accession: string, xml: string) => void;
}

export interface Form4FetchStats {
  filings: number;
  xmlFetched: number;
  xmlFailed: number;
}

/**
 * Every Form 4 / 4/A about one issuer accepted on or after `from` (YYYY-MM-DD), parsed.
 * The main submissions JSON is refetched when `refreshMain` (live: new filings); older pages
 * and every XML come from the cache when present (filed documents never change). An XML that
 * fails or doesn't parse is counted and skipped.
 */
export async function fetchForm4History(
  cik: string,
  from: string,
  client: Form4Client,
  cache: Form4Cache,
  opts: { refreshMain?: boolean; stats?: Form4FetchStats } = {},
): Promise<ParsedFiling[]> {
  const SUB = "https://data.sec.gov/submissions";
  const load = async (name: string, refresh = false) => {
    const hit = refresh ? null : cache.readJson(name);
    if (hit != null) return hit;
    const json = await client.json(`${SUB}/${name}`);
    cache.writeJson(name, json);
    return json;
  };
  const main = (await load(`CIK${cik}.json`, opts.refreshMain)) as { filings?: { recent?: unknown; files?: unknown } };
  const filings = form4Filings(main?.filings?.recent, cik);
  const files = Array.isArray(main?.filings?.files) ? (main.filings.files as Array<{ name?: unknown; filingTo?: unknown }>) : [];
  for (const f of files) if (typeof f.name === "string" && typeof f.filingTo === "string" && f.filingTo >= from) filings.push(...form4Filings(await load(f.name), cik));
  const stats = opts.stats ?? { filings: 0, xmlFetched: 0, xmlFailed: 0 };
  const out: ParsedFiling[] = [];
  const seen = new Set<string>();
  for (const f of filings) {
    if (f.acceptance.slice(0, 10) < from || seen.has(f.accession)) continue;
    seen.add(f.accession);
    stats.filings++;
    let xml = cache.readXml(f.accession);
    if (xml == null) {
      try {
        xml = await client.text(f.xmlUrl);
        cache.writeXml(f.accession, xml);
        stats.xmlFetched++;
      } catch {
        stats.xmlFailed++;
        continue;
      }
    }
    const doc = parseForm4(xml);
    if (!doc) {
      stats.xmlFailed++;
      continue;
    }
    out.push({ filing: f, doc });
  }
  return out;
}

export interface Form4Coverage {
  symbols: number;
  withFilings: number;
  noCik: number;
  failed: number;
  filings: number;
  xmlFetched: number;
  xmlFailed: number;
  buys: number;
}

export function form4CoverageLine(c: Form4Coverage): string {
  return (
    `[form4] ${c.withFilings}/${c.symbols} symbols with Form 4s; ${c.noCik} without a CIK, ${c.failed} failed; ` +
    `${c.filings} filings (${c.xmlFetched} XML fetched, ${c.xmlFailed} failed), ${c.buys} P-code buys`
  );
}

/**
 * Insider events per symbol: ticker → CIK, that CIK's Form 4s, mapped to sessions. One fetch
 * per CIK. A symbol without a CIK, or whose fetch failed, gets no entry (null downstream); a
 * CIK with no Form 4s gets an empty list (zeros downstream).
 */
export async function buildForm4(
  symbols: readonly string[],
  cikOf: (symbol: string) => string | undefined,
  sessions: readonly string[],
  fetchParsed: (cik: string, stats: Form4FetchStats) => Promise<ParsedFiling[]>,
  onError: (symbol: string, err: unknown) => void = () => {},
): Promise<{ bySymbol: Map<string, { cik: string; events: InsiderEvent[] }>; coverage: Form4Coverage }> {
  const bySymbol = new Map<string, { cik: string; events: InsiderEvent[] }>();
  const coverage: Form4Coverage = { symbols: symbols.length, withFilings: 0, noCik: 0, failed: 0, filings: 0, xmlFetched: 0, xmlFailed: 0, buys: 0 };
  const perCik = new Map<string, InsiderEvent[] | null>();
  for (const sym of symbols) {
    const cik = cikOf(sym);
    if (!cik) {
      coverage.noCik++;
      continue;
    }
    if (!perCik.has(cik)) {
      const stats: Form4FetchStats = { filings: 0, xmlFetched: 0, xmlFailed: 0 };
      try {
        perCik.set(cik, insiderEvents(await fetchParsed(cik, stats), sessions));
      } catch (err) {
        perCik.set(cik, null);
        onError(sym, err);
      }
      coverage.filings += stats.filings;
      coverage.xmlFetched += stats.xmlFetched;
      coverage.xmlFailed += stats.xmlFailed;
    }
    const events = perCik.get(cik);
    if (events == null) {
      coverage.failed++;
      continue;
    }
    bySymbol.set(sym, { cik, events });
    if (events.length) coverage.withFilings++;
    coverage.buys += events.filter((e) => e.code === "P").length;
  }
  return { bySymbol, coverage };
}
