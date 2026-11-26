/**
 * P3-0k5 survivorship check (docs/PHASE3-PREP.md §P3-0k5). The backfill uses today's universe
 * only, so delisted losers are missing and the bias grows with the window. Every P3-0k3/0k4 report
 * prints each pre-registered comparison's primary metric (the selection's net expectancy, R) for
 * years 1–3 and years 4–5 of the window separately; a KEEP needs both halves positive. With a
 * window of 3 years or less there is no second half and the check doesn't apply (marked n/a).
 */
import { groupMetrics } from "./stp-sim";
import type { Comparison, ComparisonResult, FunnelTrade } from "./funnel-sim";

export const SPLIT_YEARS = 3;

/** The first date of "years 4–5": `firstSession` + 3 years (calendar). */
export function splitDate(firstSession: string, years = SPLIT_YEARS): string {
  const d = new Date(`${firstSession}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** True when the window reaches past the split, so both halves exist. */
export const windowHasSecondHalf = (firstSession: string, lastSession: string) => lastSession >= splitDate(firstSession);

const tradeDate = (t: FunnelTrade) => t.scanStart.toISOString().slice(0, 10);

export interface HalfCheck {
  id: string;
  early: { trades: number; expectancy: number | null };
  late: { trades: number; expectancy: number | null };
  /** null = the window has no years 4–5. */
  bothPositive: boolean | null;
}

/**
 * Applies the check to each result: a KEEP whose selection isn't net-positive in both halves
 * becomes DROP (reason says why). Other verdicts are unchanged.
 */
export function applySurvivorshipCheck(
  results: readonly ComparisonResult[],
  comparisons: readonly Comparison[],
  trades: readonly FunnelTrade[],
  firstSession: string,
  lastSession: string,
): { results: ComparisonResult[]; checks: HalfCheck[] } {
  const split = splitDate(firstSession);
  const applies = windowHasSecondHalf(firstSession, lastSession);
  const checks: HalfCheck[] = [];
  const out = results.map((r) => {
    const c = comparisons.find((x) => x.id === r.id);
    const sel = c ? trades.filter(c.sel) : [];
    const e = groupMetrics(sel.filter((t) => tradeDate(t) < split));
    const l = groupMetrics(sel.filter((t) => tradeDate(t) >= split));
    const pos = (x: number | null) => x != null && x > 0;
    const bothPositive = applies ? pos(e.expectancy) && pos(l.expectancy) : null;
    checks.push({ id: r.id, early: { trades: e.trades, expectancy: e.expectancy }, late: { trades: l.trades, expectancy: l.expectancy }, bothPositive });
    if (r.verdict === "KEEP" && bothPositive === false)
      return { ...r, verdict: "DROP" as const, reason: `${r.reason}; survivorship check failed: net exp R years 1–3 ${e.expectancy?.toFixed(3) ?? "n/a"}, years 4–5 ${l.expectancy?.toFixed(3) ?? "n/a"} (both must be > 0)` };
    return r;
  });
  return { results: out, checks };
}

export function survivorshipLines(title: string, checks: readonly HalfCheck[], firstSession: string, lastSession: string): string[] {
  const split = splitDate(firstSession);
  const f = (v: number | null) => (v == null ? "n/a" : v.toFixed(3));
  return [
    `**${title}: survivorship split (today's universe only; years 1–3 ${firstSession}–${split}, years 4–5 ${split}–${lastSession})**`,
    "",
    windowHasSecondHalf(firstSession, lastSession) ? "A KEEP needs the selection's net expectancy > 0 in both halves." : "The window is 3 years or less: no years 4–5, so the check doesn't apply (n/a).",
    "",
    "| comparison | years 1–3 trades | years 1–3 net exp R | years 4–5 trades | years 4–5 net exp R | both > 0 |",
    "|---|---|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${c.early.trades} | ${f(c.early.expectancy)} | ${c.late.trades} | ${f(c.late.expectancy)} | ${c.bothPositive == null ? "n/a" : c.bothPositive ? "yes" : "no"} |`),
    "",
  ];
}
