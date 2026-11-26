import { describe, it, expect } from "vitest";
import { backfillWindow, chartCoversWindow, WARMUP_DAYS, warmupDaysArg } from "@/lib/harvester/universe/backfill";
import { earningsWithin } from "@/lib/eval/funnel";
import { earningsFromFile } from "@/lib/harvester/edgar-earnings";
import { insiderFeaturesAt, INS_KEYS, type InsiderEvent } from "@/lib/harvester/form4-history";
import { congressFeaturesAt, CONG_KEYS } from "@/lib/harvester/house-ptr";
import { calendarCoverage } from "@/lib/harvester/macro-calendar";
import { applySurvivorshipCheck, splitDate, survivorshipLines, windowHasSecondHalf } from "@/lib/eval/survivorship";
import type { Comparison, ComparisonResult, FunnelTrade } from "@/lib/eval/funnel-sim";

const DAY = 86_400;

describe("--years 5 window math with warm-up", () => {
  const now = new Date("2026-11-26T15:00:00Z");

  it("fetches 5 × 365 days plus the 300-day warm-up; the backfill starts 5 × 365 days back", () => {
    const w = backfillWindow(now, 5, warmupDaysArg([]));
    expect(warmupDaysArg([])).toBe(WARMUP_DAYS);
    expect(w.period2).toBe(Math.floor(now.getTime() / 1000));
    expect(w.period2 - w.period1).toBe((5 * 365 + 300) * DAY);
    expect(w.since).toBe("2021-11-27");
    expect(w.fetchFrom).toBe(new Date(now.getTime() - (5 * 365 + 300) * 86_400_000).toISOString().slice(0, 10));
    expect(w.until).toBe("2026-11-26");
    // The 2-year window it replaces, and a custom warm-up
    expect(backfillWindow(now, 2).since).toBe("2024-11-26");
    expect(backfillWindow(now, 5, 120).period2 - backfillWindow(now, 5, 120).period1).toBe((5 * 365 + 120) * DAY);
    expect(() => backfillWindow(now, 0)).toThrow(/--years/);
  });

  const chart = (firstTs: number | null, firstTradeDate?: number) => ({ chart: { result: [{ meta: firstTradeDate == null ? {} : { firstTradeDate }, timestamp: firstTs == null ? [] : [firstTs, firstTs + DAY] }] } });

  it("a chart cached for a shorter window is refetched; one reaching the window start, or a later IPO, is kept", () => {
    const { period1 } = backfillWindow(now, 5);
    expect(chartCoversWindow(chart(period1 + 3 * DAY), period1)).toBe(true); // weekend slack
    expect(chartCoversWindow(chart(period1 - 30 * DAY), period1)).toBe(true);
    const twoYearStart = backfillWindow(now, 2).period1;
    expect(chartCoversWindow(chart(twoYearStart), period1)).toBe(false); // a 2-year cache under --years 5
    expect(chartCoversWindow(chart(twoYearStart, twoYearStart - DAY), period1)).toBe(true); // listed then: can't go further back
    expect(chartCoversWindow(chart(null), period1)).toBe(false);
    expect(chartCoversWindow({}, period1)).toBe(false);
  });
});

describe("null before a source's first date, never 0", () => {
  it("earnings: before the file's from date the gate is unknown (null), after it a real yes/no", () => {
    const earnings = new Set(["2024-02-01"]);
    const sessions = ["2023-12-28", "2023-12-29", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"];
    expect(earningsWithin("2023-12-28", earnings, sessions, 2, "2024-01-01")).toBeNull();
    expect(earningsWithin("2024-01-29", earnings, sessions, 5, "2024-01-01")).toBe(true);
    expect(earningsWithin("2023-12-28", earnings, sessions, 2)).toBe(false); // without coverage: the old behaviour
    expect(earningsFromFile({ from: "2021-11-29", events: [] })).toBe("2021-11-29");
    expect(earningsFromFile({})).toBeUndefined();
  });

  it("Form 4 (a source with shorter history): every ins_* key null before its from date, counts after", () => {
    const ev: InsiderEvent = { session: "2025-03-03", acceptance: "2025-03-03T15:00:00Z", accession: "a", ownerCik: "1", officer: true, director: false, tenPct: false, code: "P", signal: true, shares: 10, usd: 1000, transactionDate: null };
    const before = insiderFeaturesAt([ev], "2023-06-01", [], "2024-10-01");
    expect(Object.keys(before).sort()).toEqual([...INS_KEYS].sort());
    expect(Object.values(before).every((v) => v === null)).toBe(true);
    expect(insiderFeaturesAt([], "2024-11-01", [], "2024-10-01").ins_buy_n_30d).toBe(0); // covered, none: a real 0
    expect(insiderFeaturesAt([ev], "2025-03-05", [], "2024-10-01").ins_buy_n_30d).toBe(1);
  });

  it("House PTRs: cong_* null before the from date", () => {
    const before = congressFeaturesAt([], "AAPL", "2023-01-03", "2024-10-12");
    expect(Object.keys(before)).toEqual([...CONG_KEYS]);
    expect(Object.values(before).every((v) => v === null)).toBe(true);
    expect(congressFeaturesAt([], "AAPL", "2024-11-01", "2024-10-12").cong_buy_n_30d).toBe(0);
  });
});

describe("survivorship split", () => {
  const trade = (date: string, netR: number) => ({ scanStart: new Date(`${date}T13:30:00Z`), fillDate: date, exitDate: date, netR, grossR: netR, population: "p3k3", arm: "stop", dir: 1 }) as unknown as FunnelTrade;
  const comps: Comparison[] = [{ id: "p3k3:vs-all:long", label: "x", kind: "bench", sel: (t) => t.population === "p3k3", bench: () => false, provisional: true }];
  const keep = { id: "p3k3:vs-all:long", group: "x", verdict: "KEEP", reason: "passes", kind: "bench", provisional: true } as unknown as ComparisonResult;

  it("years 1–3 end on the 3-year anniversary of the window start", () => {
    expect(splitDate("2021-11-29")).toBe("2024-11-29");
    expect(windowHasSecondHalf("2021-11-29", "2026-11-25")).toBe(true);
    expect(windowHasSecondHalf("2024-11-27", "2026-11-25")).toBe(false);
  });

  it("a KEEP with a negative half becomes DROP; both positive stays KEEP; the lines print both halves", () => {
    const mixed = [trade("2022-03-01", 2), trade("2023-05-01", 1), trade("2025-06-02", -1), trade("2026-01-05", -0.5)];
    const r = applySurvivorshipCheck([keep], comps, mixed, "2021-11-29", "2026-11-25");
    expect(r.results[0].verdict).toBe("DROP");
    expect(r.results[0].reason).toContain("survivorship check failed");
    expect(r.checks[0]).toMatchObject({ early: { trades: 2 }, late: { trades: 2 }, bothPositive: false });
    const good = [trade("2022-03-01", 2), trade("2025-06-02", 1)];
    expect(applySurvivorshipCheck([keep], comps, good, "2021-11-29", "2026-11-25").results[0].verdict).toBe("KEEP");
    const lines = survivorshipLines("P3-0k3", r.checks, "2021-11-29", "2026-11-25").join("\n");
    expect(lines).toContain("years 1–3 2021-11-29–2024-11-29");
    expect(lines).toContain("| p3k3:vs-all:long | 2 |");
  });

  it("a window of 3 years or less: the check doesn't apply (n/a) and a KEEP stands", () => {
    const r = applySurvivorshipCheck([keep], comps, [trade("2025-06-02", -1)], "2024-11-27", "2026-11-25");
    expect(r.results[0].verdict).toBe("KEEP");
    expect(r.checks[0].bothPositive).toBeNull();
    expect(survivorshipLines("P3-0k3", r.checks, "2024-11-27", "2026-11-25").join("\n")).toContain("doesn't apply (n/a)");
  });
});

describe("macro calendar coverage", () => {
  it("covers when the first event is on or before the window start; otherwise a warning that it means 'no event', not 'unknown'", () => {
    const events = [{ date: "2024-11-07" }, { date: "2023-01-12" }];
    expect(calendarCoverage(events, "2023-01-12")).toEqual({ first: "2023-01-12", covers: true, warning: null });
    const late = calendarCoverage(events, "2021-11-29");
    expect(late).toMatchObject({ first: "2023-01-12", covers: false });
    expect(late.warning).toContain('the calendar starts 2023-01-12, after the window start 2021-11-29');
    expect(late.warning).toContain('"no event", not "unknown"');
    expect(calendarCoverage([], "2021-11-29")).toMatchObject({ first: null, covers: false });
  });
});
