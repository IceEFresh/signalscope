import { describe, it, expect } from "vitest";
import {
  congressFeatures,
  congressAblation,
  HARD_CATALYST_SOURCES_WITHOUT_CONGRESS,
  SOCIAL_ONLY_SCORE_CAP,
} from "@/lib/harvester/congress-features";
import { HARD_CATALYST_SOURCES, type RecommendationInput } from "@/lib/harvester/recommendation";
import type { RawSignal, Source } from "@/lib/harvester/types";

const cong = (over: Partial<RawSignal> = {}): RawSignal => ({
  symbol: "AMD",
  source: "CONGRESS",
  author: "House Jane Doe",
  purchaseValue: 50_000,
  reportingGapDays: 20,
  ...over,
});

describe("congressFeatures", () => {
  it("is empty without a CONGRESS signal", () => {
    expect(congressFeatures([{ symbol: "AMD", source: "REDDIT" }])).toEqual({});
  });

  it("summarizes congress trades and flags congress-only catalysts", () => {
    const f = congressFeatures([
      cong(),
      cong({ author: "Senate John Roe", purchaseValue: 15_000, reportingGapDays: 44 }),
      cong({ purchaseValue: undefined, reportingGapDays: undefined }),
      { symbol: "AMD", source: "REDDIT" },
    ]);
    expect(f).toEqual({
      congress_count: 3,
      congress_members: 2,
      congress_value_total: 65_000,
      congress_min_reporting_gap_days: 20,
      congress_max_reporting_gap_days: 44,
      congress_only_catalyst: true,
    });
  });

  it("is not congress-only when insider or options flow is also present", () => {
    expect(congressFeatures([cong(), { symbol: "AMD", source: "SEC_INSIDER" }]).congress_only_catalyst).toBe(false);
    expect(congressFeatures([cong(), { symbol: "AMD", source: "OPTIONS_FLOW" }]).congress_only_catalyst).toBe(false);
  });

  it("does not count a signal without an author as a member", () => {
    expect(congressFeatures([cong(), cong({ author: undefined })]).congress_members).toBe(1);
  });

  it("uses null, not 0, when values and gaps are missing", () => {
    expect(congressFeatures([cong({ purchaseValue: undefined, reportingGapDays: undefined })])).toMatchObject({
      congress_value_total: null,
      congress_min_reporting_gap_days: null,
    });
  });
});

describe("congress ablation", () => {
  it("leaves the live catalyst set unchanged (log-only PR)", () => {
    expect([...HARD_CATALYST_SOURCES].sort()).toEqual(["CONGRESS", "OPTIONS_FLOW", "SEC_INSIDER"]);
    expect([...HARD_CATALYST_SOURCES_WITHOUT_CONGRESS].sort()).toEqual(["OPTIONS_FLOW", "SEC_INSIDER"]);
  });

  const input = (over: Partial<RecommendationInput> = {}): RecommendationInput => ({
    aiScore: 75,
    stage: "EARLY",
    sourceCount: 2,
    hasCatalystSource: true,
    pndFlagged: false,
    price: 20,
    marketCap: 5e9,
    medianSignalAgeHrs: null,
    ...over,
  });

  it("a congress-only catalyst loses its catalyst, and with the cap its score too", () => {
    const sources = new Set<Source>(["CONGRESS"]);
    const a = congressAblation({ input: input(), sources });
    expect(a).toEqual({ current: "Buy", withoutCongressRules: "Watch", withoutCongressRulesAndCap: "Watch" });
    // Without a catalyst the same row can only land on non-catalyst paths
    const noCatalyst = congressAblation({ input: input({ hasCatalystSource: false }), sources: new Set<Source>() });
    expect(a.withoutCongressRules).toBe(noCatalyst.current);
    const capped = congressAblation({
      input: input({ hasCatalystSource: false, aiScore: SOCIAL_ONLY_SCORE_CAP }),
      sources: new Set<Source>(),
    });
    expect(a.withoutCongressRulesAndCap).toBe(capped.current);
  });

  it("does not change a row that has another hard catalyst", () => {
    const a = congressAblation({ input: input(), sources: new Set<Source>(["CONGRESS", "SEC_INSIDER"]) });
    expect(a.withoutCongressRules).toBe(a.current);
    expect(a.withoutCongressRulesAndCap).toBe(a.current);
  });

  it("does not change a row without CONGRESS", () => {
    const a = congressAblation({ input: input({ hasCatalystSource: false, aiScore: 45 }), sources: new Set<Source>() });
    expect(a.withoutCongressRules).toBe(a.current);
    expect(a.withoutCongressRulesAndCap).toBe(a.current);
  });
});
