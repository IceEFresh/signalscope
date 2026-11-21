/**
 * Graduation watch (PLAN.md PR 1-0, change 5): informed buys on names outside
 * the universe are watched for 90 days; when a name starts passing the universe
 * rule, a GRADUATION signal is emitted and flows through normal staging.
 *
 * Pure logic only. DB access lives in watch-store.ts, network in build.ts.
 */
import type { RawSignal, WatchCheck } from "../types";
import { flippedCriteria, type UniverseRuleResult } from "./rule";

export type WatchSource = "INSIDER" | "POLITICIAN" | "ACTIVIST" | "NEW_INSIDER";

export const WATCH_DAYS = 90;
/** Second STOCK Act disclosure bracket. */
export const MIN_POLITICIAN_VALUE = 15_000;
/** Insider rows: the source already keeps only C-suite/director purchases ≥ $50K. */
export const MIN_INSIDER_VALUE = 50_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WatchEntry {
  symbol: string;
  source: WatchSource;
  filingKey: string;
  filedAt: Date | null;
  actorName: string | null;
  actorRole: string | null;
  value: number | null;
  reportingGapDays: number | null;
  /** PLAN.md 2a, insiders only. */
  insiderClass?: string | null;
}

/** The fields of a stored watch row that merge logic reads and writes. */
export interface WatchRowState {
  firstFiledAt: Date;
  lastFiledAt: Date;
  actorNames: string[];
  actorRoles: string[];
  filingKeys: string[];
  totalValue: number | null;
  filingCount: number;
  isCluster: boolean;
  reportingGapDays: number | null;
  expiresAt: Date;
  /** PLAN.md 2a: opportunistic if any filing on the row is, else routine, else unclassified. */
  insiderClass?: string | null;
}

const INSIDER_CLASS_RANK: Record<string, number> = { unclassified: 1, routine: 2, opportunistic: 3 };

/** The stronger of two insider classes (opportunistic > routine > unclassified). */
export function strongerInsiderClass(a: string | null | undefined, b: string | null | undefined): string | null {
  const ra = a ? INSIDER_CLASS_RANK[a] ?? 0 : 0;
  const rb = b ? INSIDER_CLASS_RANK[b] ?? 0 : 0;
  if (ra === 0 && rb === 0) return null;
  return ra >= rb ? a! : b!;
}

/** Row shape the harvester receives from GET /api/harvest/universe. */
export interface ActiveWatchRow {
  id: string;
  symbol: string;
  source: WatchSource;
  firstFiledAt: string;
  lastFiledAt: string;
  totalValue: number | null;
  isCluster: boolean;
  failingCriteria: string[];
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Watch entries from this scan's insider and congress buys on symbols outside the universe. */
export function watchEntriesFromSignals(
  signals: readonly RawSignal[],
  isOutsideUniverse: (symbol: string) => boolean,
): WatchEntry[] {
  const out: WatchEntry[] = [];
  for (const s of signals) {
    if (!isOutsideUniverse(s.symbol) || !s.filingKey) continue;
    if (s.source === "SEC_INSIDER") {
      if ((s.purchaseValue ?? 0) < MIN_INSIDER_VALUE) continue;
      out.push({
        symbol: s.symbol,
        source: "INSIDER",
        filingKey: s.filingKey,
        filedAt: parseDate(s.filedAt),
        actorName: s.author ?? null,
        actorRole: s.insiderTitle ?? null,
        value: s.purchaseValue ?? null,
        reportingGapDays: null,
        insiderClass: s.insiderClass ?? null,
      });
    } else if (s.source === "CONGRESS") {
      if ((s.purchaseValue ?? 0) < MIN_POLITICIAN_VALUE) continue;
      out.push({
        symbol: s.symbol,
        source: "POLITICIAN",
        filingKey: s.filingKey,
        filedAt: parseDate(s.filedAt),
        actorName: s.author ?? null,
        actorRole: null,
        value: s.purchaseValue ?? null,
        reportingGapDays: s.reportingGapDays ?? null,
      });
    }
  }
  return out;
}

/**
 * Fold one entry into an existing active row (or start a new one). Returns null
 * when the filing is already on the row, so repeat listings across daily runs
 * don't double-count. Expiry is 90 days after the latest filing.
 */
export function mergeWatchEntry(existing: WatchRowState | null, entry: WatchEntry, now: Date): WatchRowState | null {
  if (existing?.filingKeys.includes(entry.filingKey)) return null;
  const filedAt = entry.filedAt ?? now;
  const base: WatchRowState = existing ?? {
    firstFiledAt: filedAt,
    lastFiledAt: filedAt,
    actorNames: [],
    actorRoles: [],
    filingKeys: [],
    totalValue: null,
    filingCount: 0,
    isCluster: false,
    reportingGapDays: null,
    expiresAt: new Date(filedAt.getTime() + WATCH_DAYS * DAY_MS),
  };
  const actorNames = entry.actorName && !base.actorNames.includes(entry.actorName)
    ? [...base.actorNames, entry.actorName]
    : base.actorNames;
  const actorRoles = entry.actorRole && !base.actorRoles.includes(entry.actorRole)
    ? [...base.actorRoles, entry.actorRole]
    : base.actorRoles;
  const firstFiledAt = filedAt < base.firstFiledAt ? filedAt : base.firstFiledAt;
  const lastFiledAt = filedAt > base.lastFiledAt ? filedAt : base.lastFiledAt;
  return {
    firstFiledAt,
    lastFiledAt,
    actorNames,
    actorRoles,
    filingKeys: [...base.filingKeys, entry.filingKey],
    totalValue: entry.value == null ? base.totalValue : (base.totalValue ?? 0) + entry.value,
    filingCount: base.filingCount + 1,
    isCluster: entry.source === "INSIDER" ? actorNames.length >= 2 : base.isCluster,
    reportingGapDays: entry.reportingGapDays ?? base.reportingGapDays,
    expiresAt: new Date(lastFiledAt.getTime() + WATCH_DAYS * DAY_MS),
    insiderClass: entry.source === "INSIDER" ? strongerInsiderClass(base.insiderClass, entry.insiderClass) : base.insiderClass ?? null,
  };
}

export function buildGraduationSignal(row: ActiveWatchRow, flipped: string[], now: Date): RawSignal {
  const filedAt = parseDate(row.lastFiledAt) ?? now;
  const ageDays = Math.max(0, Math.floor((now.getTime() - filedAt.getTime()) / DAY_MS));
  const value = row.totalValue != null ? `$${Math.round(row.totalValue).toLocaleString("en-US")}` : "unknown value";
  const flippedText = flipped.length > 0 ? flipped.join(", ") : "first check";
  return {
    symbol: row.symbol,
    source: "GRADUATION",
    title: `Graduation: ${row.symbol} entered the liquid universe after a ${row.source.toLowerCase()} buy`,
    body: `Watched since ${row.firstFiledAt.slice(0, 10)} (${row.source}${row.isCluster ? ", cluster" : ""}, ${value}). Latest filing ${ageDays} days old. Criteria that flipped: ${flippedText}.`,
    graduationSource: row.source,
    filingAgeDays: ageDays,
    purchaseValue: row.totalValue ?? undefined,
    flippedCriteria: flipped,
  };
}

/** Turn rule results for watched symbols into stored checks plus GRADUATION signals. */
export function applyWatchResults(
  rows: readonly ActiveWatchRow[],
  results: Map<string, UniverseRuleResult>,
  now: Date,
): { checks: WatchCheck[]; signals: RawSignal[] } {
  const checks: WatchCheck[] = [];
  const signals: RawSignal[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const r = results.get(row.symbol);
    if (!r) continue; // fetch failed: leave the row untouched
    const flipped = r.passes ? flippedCriteria(row.failingCriteria, r.failing) : [];
    checks.push({ watchId: row.id, failingCriteria: r.failing, graduated: r.passes, flippedCriteria: flipped });
    if (r.passes && !emitted.has(row.symbol)) {
      emitted.add(row.symbol);
      signals.push(buildGraduationSignal(row, flipped, now));
    }
  }
  return { checks, signals };
}
