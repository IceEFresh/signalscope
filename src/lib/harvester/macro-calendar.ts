/**
 * P3-0j: scheduled US macro releases (docs/PHASE3-PREP.md §P3-0j step 1). Macro events never
 * block an entry; they halve the size (out-of-hours events within 5 sessions) and tighten
 * stops of open positions (the event stop rule, stp-sim ExitExtras).
 *
 * The calendar is checked in at src/lib/harvester/macro-calendar.json. Every event has its
 * date, release time (ET) and the official page it was read from. The tag comes from the
 * time: before 09:30 or from 16:00 ET is out-of-hours (it can gap against an open position at
 * the open); 09:30–16:00 is in-hours (FOMC statements at 14:00).
 */
import calendarJson from "./macro-calendar.json";

export const MACRO_EVENT_TYPES = ["FOMC", "CPI", "PPI", "NFP", "PCE", "GDP_ADV", "RETAIL"] as const;
export type MacroEventType = (typeof MACRO_EVENT_TYPES)[number];
export const OFFICIAL_SOURCES = ["www.federalreserve.gov", "www.bls.gov", "www.bea.gov", "www.census.gov"] as const;
/** Sessions after D in which an out-of-hours event halves the size. */
export const EVENT_HALF_SESSIONS = 5;
/** The health report warns when the calendar's last event is fewer than this many days away. */
export const CALENDAR_WARN_DAYS = 60;

export interface MacroEvent {
  event: MacroEventType;
  date: string;
  /** Release time, ET, HH:MM. */
  time: string;
  source: string;
  outOfHours: boolean;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const isOutOfHours = (time: string) => minutes(time) < 9 * 60 + 30 || minutes(time) >= 16 * 60;

/** Validated events, oldest first. A row with a bad date, time, type or a non-official source is dropped. */
export function parseMacroCalendar(json: unknown): MacroEvent[] {
  const rows = (json as { events?: unknown } | null)?.events;
  if (!Array.isArray(rows)) return [];
  const out: MacroEvent[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const { event, date, time, source } = r ?? {};
    if (typeof event !== "string" || !(MACRO_EVENT_TYPES as readonly string[]).includes(event)) continue;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue;
    let host = "";
    try {
      host = new URL(String(source)).host;
    } catch {
      continue;
    }
    if (!(OFFICIAL_SOURCES as readonly string[]).includes(host)) continue;
    out.push({ event: event as MacroEventType, date, time, source: String(source), outOfHours: isOutOfHours(time) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

let cached: MacroEvent[] | null = null;
/** The checked-in calendar. */
export function macroCalendar(): MacroEvent[] {
  cached ??= parseMacroCalendar(calendarJson);
  return cached;
}

/**
 * The `n` sessions after `d`, from sorted `sessions` (e.g. SPY's dates); past its end,
 * weekdays stand in (live: the exchange calendar ahead isn't stored).
 */
export function sessionsAfter(d: string, n: number, sessions: readonly string[] = []): string[] {
  const out = sessions.filter((s) => s > d).slice(0, n);
  let t = Date.parse(`${out.at(-1) ?? d}T12:00:00Z`);
  while (out.length < n) {
    t += 86_400_000;
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** An out-of-hours event on one of the EVENT_HALF_SESSIONS sessions after D (size × 0.5). */
export function outOfHoursWithin(d: string, events: readonly MacroEvent[], sessions: readonly string[] = [], n = EVENT_HALF_SESSIONS): MacroEvent | null {
  const next = new Set(sessionsAfter(d, n, sessions));
  return events.find((e) => e.outOfHours && next.has(e.date)) ?? null;
}

/** An in-hours event on D itself. */
export const inHoursOn = (d: string, events: readonly MacroEvent[]) => events.find((e) => !e.outOfHours && e.date === d) ?? null;

/**
 * Bar indices whose close is the last close before a macro event (any tag): the event stop
 * rule is set there and is live from the next bar, i.e. at the event day's open.
 */
export function eventBeforeIndices(barDates: readonly string[], events: readonly MacroEvent[]): Set<number> {
  const out = new Set<number>();
  let k = 0;
  const dates = [...new Set(events.map((e) => e.date))].sort();
  for (let j = 0; j < barDates.length; j++) {
    const d = barDates[j];
    const nextBar = barDates[j + 1];
    while (k < dates.length && dates[k] <= d) k++;
    if (k < dates.length && nextBar != null && dates[k] <= nextBar) out.add(j);
  }
  return out;
}

/** The next event after D and how many sessions away it is. */
export function nextEvent(d: string, events: readonly MacroEvent[], sessions: readonly string[] = []): { event: MacroEvent; sessions: number } | null {
  const e = events.find((x) => x.date > d);
  if (!e) return null;
  const ahead = sessionsAfter(d, 400, sessions);
  const idx = ahead.indexOf(e.date);
  return { event: e, sessions: idx >= 0 ? idx + 1 : ahead.filter((s) => s < e.date).length + 1 };
}

/** Days from `today` to the calendar's last event, and whether that's under CALENDAR_WARN_DAYS. */
export function calendarExpiry(events: readonly MacroEvent[], today: string): { lastDate: string | null; daysLeft: number | null; warn: boolean; line: string } {
  const lastDate = events.at(-1)?.date ?? null;
  const daysLeft = lastDate ? Math.round((Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  const warn = daysLeft == null || daysLeft < CALENDAR_WARN_DAYS;
  return {
    lastDate,
    daysLeft,
    warn,
    line: lastDate
      ? `[macro-calendar] ${events.length} events, last ${lastDate} (${daysLeft} days left)${warn ? `: under ${CALENDAR_WARN_DAYS} days, extend src/lib/harvester/macro-calendar.json` : ""}`
      : "[macro-calendar] no events: add them to src/lib/harvester/macro-calendar.json",
  };
}
