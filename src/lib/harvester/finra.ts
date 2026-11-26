/**
 * P3-0n §2–3: FINRA short interest and Reg SHO daily short-sale volume, with history
 * (docs/PHASE3-PREP.md §P3-0n). Log-only and descriptive.
 *
 * Short interest: one pipe-delimited file per settlement date (twice a month),
 * `cdn.finra.org/equity/otcmarket/biweekly/shrtYYYYMMDD.csv`, exchange-listed and OTC. A
 * settlement date has no file until it's published; a date that isn't a settlement date
 * returns 403. The data is published after the close on the 7th business day after
 * settlement, so a report is used from that session on (the row built after that close),
 * never before.
 *
 * Short volume: `cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt` (consolidated NMS),
 * published the same evening; used on that session's row like its bar. It includes
 * market-maker hedging: it isn't short interest, and it's logged only as a crowding input.
 *
 * si_pct_float divides by Yahoo's current float: an approximation for past dates (flagged in
 * the docs and the backfill output); no float → null.
 */
import { withRetry } from "@/lib/yahoo-retry";

export const SI_URL = "https://cdn.finra.org/equity/otcmarket/biweekly";
export const SV_URL = "https://cdn.finra.org/equity/regsho/daily";
/** Business days from settlement to publication. */
export const SI_PUBLICATION_LAG = 7;
/** The Finviz sh_short_high threshold (% of float). */
export const SI_HIGH_PCT = 20;
export const SV_WINDOW = 20;
/** Sessions with data needed in the 20-session window for sv_ratio_20d and sv_z. */
export const SV_MIN_VALID = 15;

const compact = (d: string) => d.replace(/-/g, "");
export const siFileUrl = (settlement: string) => `${SI_URL}/shrt${compact(settlement)}.csv`;
export const svFileUrl = (session: string) => `${SV_URL}/CNMSshvol${compact(session)}.txt`;

export interface SiRow {
  settlement: string;
  current: number;
  previous: number | null;
  avgDailyVolume: number | null;
}

/** Split a pipe-delimited line; FINRA's newer files quote every field ("A"|"B"). */
const fields = (line: string) => line.split("|").map((f) => f.trim().replace(/^"(.*)"$/, "$1"));

const toNum = (s: string | undefined): number | null => {
  if (s == null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Header-driven parse of a short interest file → symbol → row. */
export function parseShortInterest(text: string): Map<string, SiRow> {
  const out = new Map<string, SiRow>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return out;
  const head = fields(lines[0]);
  const col = (n: string) => head.indexOf(n);
  const [iSym, iCur, iPrev, iAvg, iSet] = ["symbolCode", "currentShortPositionQuantity", "previousShortPositionQuantity", "averageDailyVolumeQuantity", "settlementDate"].map(col);
  if (iSym < 0 || iCur < 0 || iSet < 0) return out;
  for (const line of lines.slice(1)) {
    const f = fields(line);
    const sym = f[iSym]?.toUpperCase();
    const cur = toNum(f[iCur]);
    const set = f[iSet]?.trim();
    if (!sym || cur == null || !set || !/^\d{4}-\d{2}-\d{2}$/.test(set)) continue;
    out.set(sym, { settlement: set, current: cur, previous: iPrev >= 0 ? toNum(f[iPrev]) : null, avgDailyVolume: iAvg >= 0 ? toNum(f[iAvg]) : null });
  }
  return out;
}

export interface SvRow {
  short: number;
  total: number;
}

/** A daily short volume file → symbol → volumes (the trailing record-count line is skipped). */
export function parseShortVolume(text: string): Map<string, SvRow> {
  const out = new Map<string, SvRow>();
  const lines = text.split(/\r?\n/).filter((l) => l.includes("|"));
  if (!lines.length) return out;
  const head = fields(lines[0]);
  const [iSym, iShort, iTot] = ["Symbol", "ShortVolume", "TotalVolume"].map((n) => head.indexOf(n));
  if (iSym < 0 || iShort < 0 || iTot < 0) return out;
  for (const line of lines.slice(1)) {
    const f = fields(line);
    const sym = f[iSym]?.toUpperCase();
    const short = toNum(f[iShort]);
    const total = toNum(f[iTot]);
    if (!sym || short == null || total == null) continue;
    out.set(sym, { short, total });
  }
  return out;
}

/** The session the report for `settlement` is first used on (the 7th session after it); null if past the list. */
export function siPublicationSession(settlement: string, sessions: readonly string[]): string | null {
  let n = 0;
  for (const s of sessions) {
    if (s <= settlement) continue;
    if (++n === SI_PUBLICATION_LAG) return s;
  }
  return null;
}

/**
 * Candidate settlement dates between `from` and `to`, grouped by half-month, newest first in each
 * group: weekdays on the 11th–15th (mid-month) and the last 5 weekdays of the month. The first
 * candidate whose file exists is that half's settlement (holidays shift it earlier).
 */
export function siCandidateGroups(from: string, to: string): string[][] {
  const groups: string[][] = [];
  const start = new Date(`${from.slice(0, 7)}-01T12:00:00Z`);
  for (let m = new Date(start); m.toISOString().slice(0, 10) <= to; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const y = m.getUTCFullYear();
    const mo = m.getUTCMonth();
    const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const weekday = (d: number) => {
      const w = new Date(Date.UTC(y, mo, d)).getUTCDay();
      return w !== 0 && w !== 6;
    };
    const iso = (d: number) => new Date(Date.UTC(y, mo, d, 12)).toISOString().slice(0, 10);
    const mid = [15, 14, 13, 12, 11].filter(weekday).map(iso);
    const end: string[] = [];
    for (let d = days; d > 0 && end.length < 5; d--) if (weekday(d)) end.push(iso(d));
    for (const g of [mid, end]) {
      const inRange = g.filter((d) => d >= from && d <= to);
      if (inRange.length) groups.push(inRange);
    }
  }
  return groups;
}

export interface SiFeatures {
  si_shares: number | null;
  /** % of float (Yahoo's current float); null without a float. */
  si_pct_float: number | null;
  si_days_to_cover: number | null;
  /** % change vs the prior report. */
  si_change_pct: number | null;
  /** si_pct_float > 20; null when si_pct_float is. */
  si_high: boolean | null;
  si_settlement: string | null;
}

export const SI_KEYS = ["si_shares", "si_pct_float", "si_days_to_cover", "si_change_pct", "si_high", "si_settlement"] as const;

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Short interest features for one symbol as of `session`: the newest report whose publication
 * session is ≤ `session`. `reports` is that symbol's rows, any order; null keys when none is
 * usable yet.
 */
export function siFeaturesAt(reports: readonly SiRow[], session: string, sessions: readonly string[], float: number | null | undefined): SiFeatures {
  let best: SiRow | null = null;
  for (const r of reports) {
    const pub = siPublicationSession(r.settlement, sessions);
    if (pub == null || pub > session) continue;
    if (!best || r.settlement > best.settlement) best = r;
  }
  if (!best) return { si_shares: null, si_pct_float: null, si_days_to_cover: null, si_change_pct: null, si_high: null, si_settlement: null };
  const pct = float != null && float > 0 ? round((100 * best.current) / float) : null;
  return {
    si_shares: best.current,
    si_pct_float: pct,
    si_days_to_cover: best.avgDailyVolume != null && best.avgDailyVolume > 0 ? round(best.current / best.avgDailyVolume) : null,
    si_change_pct: best.previous != null && best.previous > 0 ? round((100 * (best.current - best.previous)) / best.previous) : null,
    si_high: pct == null ? null : pct > SI_HIGH_PCT,
    si_settlement: best.settlement,
  };
}

export interface SvFeatures {
  /** Short volume ÷ total volume on the session. */
  sv_ratio: number | null;
  /** Mean ratio over the 20 sessions before this one. */
  sv_ratio_20d: number | null;
  /** (today − that mean) ÷ its standard deviation. */
  sv_z: number | null;
}

export const SV_KEYS = ["sv_ratio", "sv_ratio_20d", "sv_z"] as const;

export const svRatio = (r: SvRow | undefined | null): number | null => (r && r.total > 0 ? r.short / r.total : null);

/**
 * `ratios[i]` is the ratio on sessions[i] (null when the file or symbol is missing). The baseline
 * is the 20 sessions before i, and needs at least 15 with data.
 */
export function svFeaturesAt(ratios: ReadonlyArray<number | null>, i: number): SvFeatures {
  const today = ratios[i] ?? null;
  const base = ratios.slice(Math.max(0, i - SV_WINDOW), i).filter((x): x is number => x != null);
  if (base.length < SV_MIN_VALID) return { sv_ratio: today == null ? null : round(today, 4), sv_ratio_20d: null, sv_z: null };
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length - 1));
  return {
    sv_ratio: today == null ? null : round(today, 4),
    sv_ratio_20d: round(mean, 4),
    sv_z: today == null || !(sd > 0) ? null : round((today - mean) / sd, 2),
  };
}

// ── Fetching (cached) ────────────────────────────────────────────────────────────

/** Raw file cache by file name; `null` = not cached; "" = known missing (a past date with no file). */
export interface FinraCache {
  read: (name: string) => string | null;
  write: (name: string, text: string) => void;
}

/** GET as text; resolves null on 403/404 (no such file), throws on anything else after retries. */
export type FinraGet = (url: string) => Promise<string | null>;

export const finraGetter = (): FinraGet => async (url) =>
  withRetry(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`finra ${res.status}`), { status: res.status });
      return res.text();
    },
    { label: "finra" },
  );

const fileName = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** A file from the cache or fetched (and cached when present). */
export async function finraFile(
  url: string,
  get: FinraGet,
  cache: FinraCache,
  stats?: { fetched: number; missing: number },
  /** Remember a missing file (a date old enough that it would have been published). */
  finalIfMissing = false,
): Promise<string | null> {
  const name = fileName(url);
  const hit = cache.read(name);
  if (hit === "") return null;
  if (hit != null) return hit;
  const text = await get(url);
  if (text == null) {
    if (stats) stats.missing++;
    if (finalIfMissing) cache.write(name, "");
    return null;
  }
  cache.write(name, text);
  if (stats) stats.fetched++;
  return text;
}

/** Calendar days after which a candidate with no file is final (publication is ~9–11 days after settlement). */
export const SI_FINAL_DAYS = 20;

/** Short interest reports between `from` and `to`: the first existing candidate per half-month. */
export async function fetchShortInterest(
  from: string,
  to: string,
  get: FinraGet,
  cache: FinraCache,
  stats = { fetched: 0, missing: 0 },
): Promise<Array<{ settlement: string; rows: Map<string, SiRow> }>> {
  const out: Array<{ settlement: string; rows: Map<string, SiRow> }> = [];
  const finalBefore = new Date(Date.parse(`${to}T12:00:00Z`) - SI_FINAL_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const group of siCandidateGroups(from, to)) {
    for (const d of group) {
      const text = await finraFile(siFileUrl(d), get, cache, stats, d < finalBefore);
      if (text == null) continue;
      out.push({ settlement: d, rows: parseShortInterest(text) });
      break;
    }
  }
  return out.sort((a, b) => a.settlement.localeCompare(b.settlement));
}

/** Short volume per session (null where the file is missing). */
export async function fetchShortVolume(
  sessions: readonly string[],
  get: FinraGet,
  cache: FinraCache,
  stats = { fetched: 0, missing: 0 },
): Promise<Map<string, Map<string, SvRow> | null>> {
  const out = new Map<string, Map<string, SvRow> | null>();
  const last = sessions.at(-1);
  for (const s of sessions) {
    // A past session's file is published that evening: missing then means FINRA has none
    const text = await finraFile(svFileUrl(s), get, cache, stats, s !== last);
    out.set(s, text == null ? null : parseShortVolume(text));
  }
  return out;
}

/** One symbol's short interest rows from the fetched reports. */
export const siRowsFor = (reports: ReadonlyArray<{ rows: ReadonlyMap<string, SiRow> }>, symbol: string): SiRow[] =>
  reports.map((r) => r.rows.get(symbol.toUpperCase())).filter((r): r is SiRow => r != null);

/** One symbol's ratio series aligned to `sessions`. */
export const svRatiosFor = (bySession: ReadonlyMap<string, ReadonlyMap<string, SvRow> | null>, sessions: readonly string[], symbol: string): Array<number | null> =>
  sessions.map((s) => svRatio(bySession.get(s)?.get(symbol.toUpperCase())));

// ── Floats (Yahoo's current profile; an approximation for past dates) ───────────

/** Yahoo floatShares per symbol, 5 at a time; a failed or missing float is null. */
export async function fetchFloats(symbols: readonly string[], concurrency = 5): Promise<Record<string, number | null>> {
  const { yahooFinance, withYahooTimeout } = await import("@/lib/yahoo-finance");
  const out: Record<string, number | null> = {};
  for (let i = 0; i < symbols.length; i += concurrency) {
    await Promise.all(
      symbols.slice(i, i + concurrency).map(async (sym) => {
        try {
          const s = await withRetry(() => withYahooTimeout(yahooFinance.quoteSummary(sym, { modules: ["defaultKeyStatistics"] })), { label: "quoteSummary" });
          const f = (s.defaultKeyStatistics as Record<string, unknown> | null | undefined)?.floatShares;
          out[sym] = typeof f === "number" && f > 0 ? f : null;
        } catch {
          out[sym] = null;
        }
      }),
    );
  }
  return out;
}
