import { describe, it, expect } from "vitest";
import { computeEarningsFeatures } from "@/lib/harvester/earnings-features";
import { toUnixSeconds } from "@/lib/harvester/yahoo-time";

const scan = new Date("2026-11-20T13:30:00Z"); // Fri 2026-11-20, 8:30 ET
const ts = (iso: string) => Date.parse(iso) / 1000;

describe("computeEarningsFeatures (PLAN.md 1b)", () => {
  it("counts ET calendar days from the scan date", () => {
    const f = computeEarningsFeatures({ earningsTs: ts("2026-11-24T21:05:00Z") }, scan, false);
    expect(f.earnings_date).toBe("2026-11-24");
    expect(f.days_to_earnings).toBe(4);
    expect(f.earnings_within_5d).toBe(true);
    expect(f.options_flow_near_earnings).toBeNull(); // no OPTIONS_FLOW hit
  });

  it("uses the ET date: a 00:30 UTC release is the previous ET day", () => {
    const f = computeEarningsFeatures({ earningsTs: ts("2026-11-26T00:30:00Z") }, scan, false);
    expect(f.earnings_date).toBe("2026-11-25");
    expect(f.days_to_earnings).toBe(5);
  });

  it("is 0 on the day, negative once reported, and outside 5 days is false", () => {
    expect(computeEarningsFeatures({ earningsTs: ts("2026-11-20T12:00:00Z") }, scan, false).days_to_earnings).toBe(0);
    const past = computeEarningsFeatures({ earningsTs: ts("2026-11-18T21:00:00Z") }, scan, true);
    expect(past.days_to_earnings).toBe(-2);
    expect(past.earnings_within_5d).toBe(false);
    expect(past.options_flow_near_earnings).toBe(false);
    expect(computeEarningsFeatures({ earningsTs: ts("2026-12-10T21:00:00Z") }, scan, true).earnings_within_5d).toBe(false);
  });

  it("flags options flow within 5 days of earnings (book row #5)", () => {
    expect(computeEarningsFeatures({ earningsTs: ts("2026-11-23T21:00:00Z") }, scan, true).options_flow_near_earnings).toBe(true);
  });

  it("keeps Yahoo's estimate flag and window", () => {
    const f = computeEarningsFeatures(
      { earningsTs: ts("2027-02-01T21:00:00Z"), earningsTsStart: ts("2027-01-28T00:00:00Z"), earningsTsEnd: ts("2027-02-03T00:00:00Z"), isEarningsDateEstimate: true },
      scan,
      false,
    );
    expect(f.earnings_date_is_estimate).toBe(true);
    expect(f.earnings_window_days).toBe(6);
  });

  it("returns nulls, not 0, without an earnings date", () => {
    for (const fund of [null, undefined, {}, { earningsTs: null }]) {
      expect(computeEarningsFeatures(fund, scan, true)).toEqual({
        earnings_date: null, days_to_earnings: null, earnings_within_5d: null,
        earnings_date_is_estimate: null, earnings_window_days: null, options_flow_near_earnings: null,
      });
    }
  });
});

describe("toUnixSeconds", () => {
  it("handles the Date yahoo-finance2 returns", () => {
    expect(toUnixSeconds(new Date("2026-11-24T21:05:00Z"))).toBe(ts("2026-11-24T21:05:00Z"));
  });
});
