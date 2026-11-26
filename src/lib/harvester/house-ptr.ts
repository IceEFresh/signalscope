/**
 * P3-0p: congress trades from the House Clerk's Periodic Transaction Reports (PTRs), official
 * and free (docs/PHASE3-PREP.md §P3-0p). Log-only.
 *
 * Source: `disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.zip` holds the year's
 * filing index (XML). PTRs are FilingType "P"; each one's PDF is
 * `public_disc/ptr-pdfs/<year>/<DocID>.pdf`. Electronic filings have a text layer; paper
 * filings are scanned images with none, so they're counted as unparsed, never guessed.
 *
 * Timing: the signal session is the first session **after** the PTR's filing date (the index
 * gives the date only, no time), never the transaction date: members have up to 45 days to file.
 * Ticker extraction reads "(TICKER) [XX]" rows; a row with no ticker (bonds, funds, LLCs) is
 * counted as non-equity; a transaction-shaped line that doesn't parse is counted as unparsed.
 */
import { inflateRawSync } from "node:zlib";
import { normTicker } from "./edgar-earnings";

export const HOUSE_BASE = "https://disclosures-clerk.house.gov/public_disc";
export const indexZipUrl = (year: number) => `${HOUSE_BASE}/financial-pdfs/${year}FD.zip`;
export const ptrPdfUrl = (year: number, docId: string) => `${HOUSE_BASE}/ptr-pdfs/${year}/${docId}.pdf`;
/** Calendar days in the cong_*_30d windows. */
export const CONG_WINDOW_DAYS = 30;

// ── Index ────────────────────────────────────────────────────────────────────────

/** Files in a ZIP archive (stored or deflated), by name. Minimal reader: no encryption, no ZIP64. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export interface PtrFiling {
  docId: string;
  year: number;
  /** "Last, First (StateDst)". */
  member: string;
  stateDst: string;
  /** YYYY-MM-DD. */
  filingDate: string;
  /** Electronic filings (DocID 2xxxxxxx) have a text layer; paper ones are scanned images. */
  electronic: boolean;
}

const xmlTag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() ?? "";

/** M/D/YYYY → YYYY-MM-DD; null when malformed. */
export function usDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/** The PTRs (FilingType P) in a yearly index XML. */
export function parsePtrIndex(xml: string): PtrFiling[] {
  const out: PtrFiling[] = [];
  for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    const b = m[1];
    if (xmlTag(b, "FilingType") !== "P") continue;
    const docId = xmlTag(b, "DocID");
    const filingDate = usDate(xmlTag(b, "FilingDate"));
    const year = Number(xmlTag(b, "Year"));
    if (!docId || !filingDate || !Number.isFinite(year)) continue;
    const stateDst = xmlTag(b, "StateDst");
    out.push({ docId, year, member: `${xmlTag(b, "Last")}, ${xmlTag(b, "First")} (${stateDst})`, stateDst, filingDate, electronic: docId.startsWith("2") });
  }
  return out;
}

// ── PTR text ─────────────────────────────────────────────────────────────────────

export type PtrTxType = "purchase" | "sale" | "sale_partial" | "exchange";

export interface PtrTxn {
  ticker: string | null;
  /** House asset-type code: ST stock, OP option, EF ETF, GS government security, … */
  assetType: string;
  type: PtrTxType;
  /** Self (blank), SP spouse, JT joint, DC dependent child. */
  owner: "self" | "SP" | "JT" | "DC";
  transactionDate: string | null;
  notificationDate: string | null;
  amountLow: number | null;
  amountHigh: number | null;
  /** Range midpoint; the lower bound for an open "Over $X" range. */
  amountMid: number | null;
}

export interface PtrParse {
  txns: PtrTxn[];
  /** Transaction-shaped lines (two dates) that didn't parse into a row. */
  unparsed: number;
  /** No text layer (a scanned paper filing). */
  noText: boolean;
}

const money = (s: string) => Number(s.replace(/[$,\s]/g, ""));

/** "$1,001 - $15,000" → [1001, 15000]; "Over $50,000,000" → [50000000, null]. */
export function parseAmount(s: string): { low: number | null; high: number | null; mid: number | null } {
  const t = s.replace(/\s+/g, " ").trim();
  const r = t.match(/^\$([\d,]+) ?- ?\$([\d,]+)$/);
  if (r) {
    const low = money(r[1]);
    const high = money(r[2]);
    return { low, high, mid: (low + high) / 2 };
  }
  const o = t.match(/^Over \$([\d,]+)$/i);
  if (o) return { low: money(o[1]), high: null, mid: money(o[1]) };
  return { low: null, high: null, mid: null };
}

const TX_TYPES: Record<string, PtrTxType> = { P: "purchase", S: "sale", "S (partial)": "sale_partial", E: "exchange" };
const DATE = String.raw`\d{2}/\d{2}/\d{4}`;
const AMOUNT = String.raw`\$[\d,]+\s*-\s*\$[\d,]+|Over\s+\$[\d,]+`;
const ROW = new RegExp(
  String.raw`(?:\((?<ticker>[A-Z][A-Z0-9.\-]{0,9})\)\s*)?\[(?<asset>[A-Z]{2})\]\s*(?<type>S \(partial\)|P|S|E)\s+(?<tdate>${DATE})\s+(?<ndate>${DATE})\s+(?<amount>${AMOUNT})`,
  "g",
);
const DATE_PAIR = new RegExp(String.raw`${DATE}\s+${DATE}`, "g");
/** Label lines whose bold letters the extractor drops ("F      S     : New", "S          O : Schwab", "D          : …"). */
const NOISE = /^\s*[A-Z](?:\s+[A-Z])?\s*:/;

/** Parse a PTR's extracted text. */
export function parsePtrText(text: string): PtrParse {
  if (!text.trim()) return { txns: [], unparsed: 0, noText: true };
  const lines = text.split(/\r?\n/).filter((l) => !NOISE.test(l));
  const flat = lines.join(" ").replace(/\s+/g, " ");
  const txns: PtrTxn[] = [];
  let lastEnd = 0;
  for (const m of flat.matchAll(ROW)) {
    const g = m.groups!;
    // The owner code starts the row's asset cell: the last standalone SP/JT/DC before the asset name
    // (after the table header, so the page header's "Washington, DC" never reads as an owner)
    let before = flat.slice(lastEnd, m.index);
    const head = before.lastIndexOf("$200?");
    if (head >= 0) before = before.slice(head + 5);
    const own = [...before.matchAll(/(?:^|\s)(SP|JT|DC)\s+(?=\S)/g)].at(-1)?.[1] as PtrTxn["owner"] | undefined;
    lastEnd = m.index! + m[0].length;
    const amt = parseAmount(g.amount);
    txns.push({
      ticker: g.ticker ? normTicker(g.ticker) : null,
      assetType: g.asset,
      type: TX_TYPES[g.type],
      owner: own ?? "self",
      transactionDate: usDate(g.tdate.replace(/^0/, "")) ?? null,
      notificationDate: usDate(g.ndate.replace(/^0/, "")) ?? null,
      amountLow: amt.low,
      amountHigh: amt.high,
      amountMid: amt.mid,
    });
  }
  const pairs = flat.match(DATE_PAIR)?.length ?? 0;
  return { txns, unparsed: Math.max(0, pairs - txns.length), noText: false };
}

/** Text of a PDF via unpdf (pdf.js); empty for a scanned filing. */
export async function pdfText(pdf: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(pdf);
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

// ── Events and features ─────────────────────────────────────────────────────────

export interface CongressEvent {
  /** Signal session: the first session after the filing date. */
  session: string;
  filingDate: string;
  docId: string;
  member: string;
  ticker: string;
  type: PtrTxType;
  amountMid: number | null;
  transactionDate: string | null;
}

/** The first session strictly after `date` in sorted `sessions`; null past the list. */
export function sessionAfter(date: string, sessions: readonly string[]): string | null {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo < sessions.length ? sessions[lo] : null;
}

/** Ticker rows of one PTR as events (rows with no ticker are dropped here, counted at parse). */
export function congressEvents(filing: PtrFiling, parsed: PtrParse, sessions: readonly string[]): CongressEvent[] {
  const session = sessionAfter(filing.filingDate, sessions);
  if (!session) return [];
  return parsed.txns
    .filter((t): t is PtrTxn & { ticker: string } => t.ticker != null)
    .map((t) => ({ session, filingDate: filing.filingDate, docId: filing.docId, member: filing.member, ticker: t.ticker, type: t.type, amountMid: t.amountMid, transactionDate: t.transactionDate }));
}

export interface CongressFeatures {
  /** Purchases with a signal session in the last 30 calendar days. */
  cong_buy_n_30d: number;
  /** Sum of the purchases' range midpoints. */
  cong_buy_amt_mid_30d: number;
  /** Sales (full or partial). */
  cong_sell_n_30d: number;
  /** Distinct members with a purchase or sale. */
  cong_members_30d: number;
}

export const CONG_KEYS = ["cong_buy_n_30d", "cong_buy_amt_mid_30d", "cong_sell_n_30d", "cong_members_30d"] as const;

const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Features for one ticker as of `session` (events with a signal session ≤ session only). */
export function congressFeaturesAt(events: readonly CongressEvent[], ticker: string, session: string, coverageFrom?: string): { [K in keyof CongressFeatures]: number | null } {
  // P3-0k5: before the source's first covered date every key is null, never 0
  if (coverageFrom && session < coverageFrom) return { cong_buy_n_30d: null, cong_buy_amt_mid_30d: null, cong_sell_n_30d: null, cong_members_30d: null };
  const t = normTicker(ticker);
  const from = minusDays(session, CONG_WINDOW_DAYS);
  const win = events.filter((e) => e.ticker === t && e.session > from && e.session <= session);
  const buys = win.filter((e) => e.type === "purchase");
  const sells = win.filter((e) => e.type === "sale" || e.type === "sale_partial");
  return {
    cong_buy_n_30d: buys.length,
    cong_buy_amt_mid_30d: buys.reduce((s, e) => s + (e.amountMid ?? 0), 0),
    cong_sell_n_30d: sells.length,
    cong_members_30d: new Set([...buys, ...sells].map((e) => e.member)).size,
  };
}

// ── Fetching (cached, ≤ 2 requests/s) ───────────────────────────────────────────

/** Bump when parsePtrText changes, so cached parses are redone. */
export const PTR_PARSER_VERSION = 1;
export const HOUSE_MIN_INTERVAL_MS = 500;

/** GET as bytes; null on 404. */
export type HouseGet = (url: string) => Promise<Uint8Array | null>;

/** Paced (≤ 2/s), retried getter. */
export function houseGetter(minIntervalMs = HOUSE_MIN_INTERVAL_MS): HouseGet & { requests: () => number } {
  let last = 0;
  let n = 0;
  const get = async (url: string) => {
    const { withRetry } = await import("@/lib/yahoo-retry");
    return withRetry(
      async () => {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        n++;
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 404) return null;
        if (!res.ok) throw Object.assign(new Error(`house ${res.status}`), { status: res.status });
        return new Uint8Array(await res.arrayBuffer());
      },
      { label: "house" },
    );
  };
  return Object.assign(get, { requests: () => n });
}

export interface HouseCache {
  readBytes: (name: string) => Uint8Array | null;
  writeBytes: (name: string, data: Uint8Array) => void;
  readJson: (name: string) => unknown | null;
  writeJson: (name: string, json: unknown) => void;
}

/** One year's PTRs from its index ZIP (cached unless `refresh`; the current year changes daily). */
export async function fetchPtrIndex(year: number, get: HouseGet, cache: HouseCache, refresh = false): Promise<PtrFiling[]> {
  const name = `${year}FD.zip`;
  let zip = refresh ? null : cache.readBytes(name);
  if (zip == null) {
    zip = await get(indexZipUrl(year));
    if (zip == null) return [];
    cache.writeBytes(name, zip);
  }
  const files = unzip(Buffer.from(zip));
  const xml = [...files.entries()].find(([n]) => n.toLowerCase().endsWith(".xml"))?.[1];
  return xml ? parsePtrIndex(xml.toString("utf8").replace(/^﻿/, "")) : [];
}

/** One PTR parsed: the cached parse, else the (cached) PDF parsed and cached. Null when the PDF is missing. */
export async function fetchPtrParsed(f: PtrFiling, get: HouseGet, cache: HouseCache, text: (pdf: Uint8Array) => Promise<string> = pdfText): Promise<PtrParse | null> {
  const parsedName = `parsed/${f.docId}.json`;
  const hit = cache.readJson(parsedName) as (PtrParse & { v?: number }) | null;
  if (hit && hit.v === PTR_PARSER_VERSION) return { txns: hit.txns, unparsed: hit.unparsed, noText: hit.noText };
  const pdfName = `pdf/${f.year}/${f.docId}.pdf`;
  let pdf = cache.readBytes(pdfName);
  if (pdf == null) {
    pdf = await get(ptrPdfUrl(f.year, f.docId));
    if (pdf == null) return null;
    cache.writeBytes(pdfName, pdf);
  }
  const parsed = parsePtrText(await text(pdf));
  cache.writeJson(parsedName, { v: PTR_PARSER_VERSION, ...parsed });
  return parsed;
}

export interface CongressCoverage {
  ptrs: number;
  /** Scanned paper filings with no text layer. */
  paper: number;
  rows: number;
  tickerRows: number;
  unparsed: number;
  failed: number;
}

export function congressCoverageLine(c: CongressCoverage): string {
  return (
    `[house-ptr] ${c.ptrs} PTRs (${c.paper} scanned paper filings with no text, ${c.failed} failed); ` +
    `${c.rows} transactions parsed (${c.tickerRows} with a ticker), ${c.unparsed} transaction lines unparsed`
  );
}

/** Events from every filing; a filing that fails is counted and skipped. */
export async function buildCongress(
  filings: readonly PtrFiling[],
  sessions: readonly string[],
  parse: (f: PtrFiling) => Promise<PtrParse | null>,
  onError: (f: PtrFiling, err: unknown) => void = () => {},
): Promise<{ events: CongressEvent[]; coverage: CongressCoverage }> {
  const coverage: CongressCoverage = { ptrs: filings.length, paper: 0, rows: 0, tickerRows: 0, unparsed: 0, failed: 0 };
  const events: CongressEvent[] = [];
  for (const f of filings) {
    let p: PtrParse | null;
    try {
      p = await parse(f);
    } catch (err) {
      p = null;
      onError(f, err);
    }
    if (!p) {
      coverage.failed++;
      continue;
    }
    if (p.noText) coverage.paper++;
    coverage.rows += p.txns.length;
    coverage.tickerRows += p.txns.filter((t) => t.ticker).length;
    coverage.unparsed += p.unparsed;
    events.push(...congressEvents(f, p, sessions));
  }
  return { events: events.sort((a, b) => a.session.localeCompare(b.session)), coverage };
}

/** `sessions` plus the next `n` weekdays (live: today's filings map to a session not yet in the bar list). */
export function withNextWeekdays(sessions: readonly string[], n = 5): string[] {
  const out = [...sessions];
  let t = Date.parse(`${sessions.at(-1) ?? "1970-01-01"}T12:00:00Z`);
  while (out.length < sessions.length + n) {
    t += 86_400_000;
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ── Live ─────────────────────────────────────────────────────────────────────────

/** PTRs filed from this many days back are read each harvest (the 30-day window plus slack). */
export const LIVE_PTR_DAYS = 45;

/**
 * This harvest's congress events: the current year's index refetched (and last year's from the
 * cache in January and February), PTRs filed in the last 45 days parsed (new PDFs fetched).
 */
export async function houseLive(
  today: string,
  sessions: readonly string[],
  get: HouseGet,
  cache: HouseCache,
  parse: (f: PtrFiling) => Promise<PtrParse | null> = (f) => fetchPtrParsed(f, get, cache),
): Promise<{ events: CongressEvent[]; coverage: CongressCoverage }> {
  const year = Number(today.slice(0, 4));
  const years = Number(today.slice(5, 7)) <= 2 ? [year - 1, year] : [year];
  const from = minusDays(today, LIVE_PTR_DAYS);
  const filings: PtrFiling[] = [];
  for (const y of years) filings.push(...(await fetchPtrIndex(y, get, cache, y === year)).filter((f) => f.filingDate >= from));
  return buildCongress(filings, withNextWeekdays(sessions), parse);
}

/** Tickers with a purchase filed on or after `since` (the P3-0l congress hits). */
export function newCongressBuys(events: readonly CongressEvent[], since: string): Set<string> {
  return new Set(events.filter((e) => e.type === "purchase" && e.filingDate >= since).map((e) => e.ticker));
}

/** The House PTR source vs Capitol Trades: tickers with a new purchase in each. */
export function houseVsCapitolLine(house: ReadonlySet<string>, capitol: ReadonlySet<string>): string {
  const both = [...house].filter((t) => capitol.has(t)).length;
  return `[house-ptr] new purchase tickers: House Clerk ${house.size}, Capitol Trades ${capitol.size}, both ${both}`;
}
