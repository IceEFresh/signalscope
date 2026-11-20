/**
 * Earnings timing features, PLAN.md PR 1b (BOOK-IMPROVEMENTS row #5). LOG ONLY:
 * merged into ValidatedTicker.features; no score, stage or label reads them.
 *
 * Point in time: the earnings date is the one Yahoo reports at scan time, and
 * days are counted from the scan's ET calendar date. Yahoo's date can be off by
 * ±2 days and is often an estimate, so the estimate flag and window are kept.
 */
import { etParts } from "./universe/bar-metrics";
import type { FundamentalData } from "./types";

export const EARNINGS_NEAR_DAYS = 5;

export interface EarningsFeatures {
  earnings_date: string | null; // ET date of the reported earnings release
  days_to_earnings: number | null; // calendar days from the scan's ET date; negative = already reported
  earnings_within_5d: boolean | null; // 0 ≤ days_to_earnings ≤ 5
  earnings_date_is_estimate: boolean | null;
  earnings_window_days: number | null; // Yahoo's estimated window (end − start), in days
  options_flow_near_earnings: boolean | null; // has an OPTIONS_FLOW hit and earnings within 5 days; null without one
}

const DAY_MS = 86_400_000;
const etDateMs = (unixS: number) => Date.parse(`${etParts(new Date(unixS * 1000)).date}T00:00:00Z`);

export function computeEarningsFeatures(
  fund: Pick<FundamentalData, "earningsTs" | "earningsTsStart" | "earningsTsEnd" | "isEarningsDateEstimate"> | null | undefined,
  scanTime: Date,
  hasOptionsFlow: boolean,
): EarningsFeatures {
  const ts = fund?.earningsTs ?? null;
  const days = ts == null ? null : Math.round((etDateMs(ts) - etDateMs(scanTime.getTime() / 1000)) / DAY_MS);
  const within = days == null ? null : days >= 0 && days <= EARNINGS_NEAR_DAYS;
  const start = fund?.earningsTsStart ?? null;
  const end = fund?.earningsTsEnd ?? null;
  return {
    earnings_date: ts == null ? null : etParts(new Date(ts * 1000)).date,
    days_to_earnings: days,
    earnings_within_5d: within,
    earnings_date_is_estimate: fund?.isEarningsDateEstimate ?? null,
    earnings_window_days: start != null && end != null && end >= start ? Math.round((end - start) / 86_400) : null,
    options_flow_near_earnings: hasOptionsFlow ? within : null,
  };
}
