import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeScan,
  flagsFor,
  renderText,
  featureCoverageLine,
  familyOf,
  TICKER_FAMILIES,
  type ScanInput,
} from "@/lib/health/harvest-health";
import { computeBarFeatures } from "@/lib/harvester/universe/bar-features";
import { parseChartBars } from "@/lib/harvester/universe/bar-metrics";

// Bar features computed from the real saved AMD/SPY charts, as the harvester writes them.
const chart = (f: string) => parseChartBars(JSON.parse(readFileSync(join(__dirname, "fixtures/universe", f), "utf8")), new Date("2030-01-01T00:00:00Z"));
const bar = computeBarFeatures(chart("chart-AMD-3mo.json"), chart("chart-SPY-3mo.json")) as unknown as Record<string, unknown>;

/** One ticker's features: every always-on family, plus the conditional ones when asked. */
function ticker(i: number, opts: { opt?: boolean; dropBar?: boolean; nullIv?: boolean } = {}): Record<string, unknown> {
  return {
    ...(opts.dropBar ? {} : bar),
    earnings_date: null, days_to_earnings: 12 + i, earnings_within_5d: false, earnings_date_is_estimate: true, earnings_window_days: 3, options_flow_near_earnings: null,
    industry: "Semiconductors", sector_etf: "XLK", industry_etf: "SMH", rs_vs_sector_20d: 0.01 * i, rs_vs_industry_20d: 0.02, sector_rank_20d: 3, sector_rank_change_4w: 1, industry_ticker_count: 2,
    shadow_ai_score: 50 + i, shadow_ai_raw_score: 50 + i, shadow_ai_sentiment: "bullish", shadow_ai_model: "claude-haiku-5-5",
    ...(opts.opt ? { opt_atm_iv_30d: opts.nullIv ? null : 0.5 + i / 100, opt_pc_volume_ratio: 0.7 } : {}),
  };
}

function scan(id: string, day: number, tickers: Record<string, unknown>[], over: Partial<ScanInput> = {}): ScanInput {
  return {
    scanId: id,
    startedAt: new Date(Date.UTC(2027, 0, day, 13, 30)),
    universeSize: 820,
    regimeFeatures: { regime_version: 1, spy_close: 600 },
    sectorRotation: { version: 1, sectors: [] },
    stpRows: 800,
    tickers,
    ...over,
  };
}

const healthy = (id: string, day: number) => scan(id, day, Array.from({ length: 10 }, (_, i) => ticker(i, { opt: i < 6 })));

describe("feature families", () => {
  it("are derived from the harvester's own builders", () => {
    expect(familyOf("close_vs_sma20")).toBe("bar");
    expect(familyOf("stp_htf_opens")).toBe("stp");
    expect(familyOf("days_to_earnings")).toBe("earnings");
    expect(familyOf("rs_vs_sector_20d")).toBe("sector");
    expect(familyOf("alp_large_prints")).toBe("alp");
    expect(familyOf("politician_offices")).toBe("politician");
    expect(familyOf("reddit_dd_count")).toBe("reddit");
    expect(familyOf("insider_class")).toBe("insider");
    expect(familyOf("shadow_ai_score")).toBe("shadow_ai");
    expect(familyOf("unrelated_key")).toBeNull();
  });
});

describe("analyzeScan", () => {
  it("measures coverage, null rates and numeric spread", () => {
    const r = analyzeScan(healthy("s1", 10));
    expect(r.tickers).toBe(10);
    expect(r.families.bar.coverage).toBe(1);
    expect(r.families.opt.rowsWithFamily).toBe(6);
    expect(r.families.opt.coverage).toBeCloseTo(0.6);
    // Conditional family: null rate measured over the 6 tickers that have options data
    expect(r.families.opt.keys.opt_atm_iv_30d.nullRate).toBe(0);
    expect(r.families.earnings.keys.earnings_date.nullRate).toBe(1);
    expect(r.families.earnings.keys.days_to_earnings).toMatchObject({ min: 12, max: 21, median: 16.5 });
    expect(r.families.politician.rowsWithFamily).toBe(0);
  });
});

describe("flags", () => {
  const previous = [healthy("s4", 9), healthy("s3", 8), healthy("s2", 7)];

  it("a healthy scan raises only its always-null keys and info notes for absent conditional families", () => {
    const flags = flagsFor([healthy("s5", 10), ...previous].map(analyzeScan));
    const warns = flags.filter((f) => f.level === "warn").map((f) => f.message);
    // Only the earnings keys this fixture leaves null on every row are flagged
    expect(warns).toEqual([
      "earnings.earnings_date is 100% null in the latest scan",
      "earnings.options_flow_near_earnings is 100% null in the latest scan",
    ]);
    const infos = flags.filter((f) => f.level === "info").map((f) => f.message);
    expect(infos.every((m) => /conditional/.test(m))).toBe(true);
    expect(infos.some((m) => m.startsWith("family politician missing"))).toBe(true);
  });

  it("flags a family that dropped out entirely", () => {
    const dropped = scan("s5", 10, Array.from({ length: 10 }, (_, i) => ticker(i, { opt: i < 6, dropBar: true })));
    const flags = flagsFor([dropped, ...previous].map(analyzeScan));
    expect(flags).toContainEqual({ level: "warn", message: "family bar missing entirely" });
  });

  it("flags a null-rate jump of more than 30 points against the earlier scans", () => {
    const jump = scan("s5", 10, Array.from({ length: 10 }, (_, i) => ticker(i, { opt: i < 6, nullIv: i < 4 })));
    const flags = flagsFor([jump, ...previous].map(analyzeScan));
    expect(flags.map((f) => f.message)).toContain("opt.opt_atm_iv_30d null rate 67% vs median 0% (+67 pts)");
  });

  it("flags missing scan-level families, an empty scan and an out-of-range universe", () => {
    const bad = scan("s5", 10, [], { universeSize: 120, regimeFeatures: null, sectorRotation: {}, stpRows: 0 });
    const msgs = flagsFor([analyzeScan(bad)]).map((f) => f.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "latest scan has no tickers",
        "universe size 120 outside 300-1500",
        "family regime missing (Scan.regimeFeatures empty)",
        "family sectorRotation missing (Scan.sectorRotation empty)",
        "family stp missing (no StpSignal rows)",
      ]),
    );
    expect(flagsFor([analyzeScan(scan("s6", 11, [ticker(0)], { universeSize: null }))]).map((f) => f.message)).toContain(
      "latest scan has no universe (static fallback list)",
    );
    expect(flagsFor([])).toEqual([{ level: "warn", message: "no completed scans found" }]);
  });
});

describe("output", () => {
  it("renders every family and the flags", () => {
    const reports = [healthy("s5", 10), healthy("s4", 9)].map(analyzeScan);
    const text = renderText(reports, flagsFor(reports));
    for (const f of TICKER_FAMILIES) expect(text).toContain(`[${f}] coverage`);
    expect(text).toContain("universe 820");
    expect(text).toContain("WARN earnings.earnings_date is 100% null");
  });

  it("gives the ingest a one-line coverage summary", () => {
    expect(featureCoverageLine([ticker(0, { opt: true }), ticker(1), null])).toBe(
      "[features] 3 tickers; coverage bar 67%, stp 67%, earnings 67%, sector 67%, opt 33%, alp 0%, politician 0%, reddit 0%, insider 0%, shadow_ai 67%",
    );
  });
});
