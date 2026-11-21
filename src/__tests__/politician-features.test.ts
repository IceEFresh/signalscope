import { describe, it, expect } from "vitest";
import {
  politicianFeatures,
  politicianAblation,
  politicianOffice,
  HARD_CATALYST_SOURCES_WITHOUT_POLITICIANS,
  SOCIAL_ONLY_SCORE_CAP,
} from "@/lib/harvester/politician-features";
import { HARD_CATALYST_SOURCES, type RecommendationInput } from "@/lib/harvester/recommendation";
import type { RawSignal, Source } from "@/lib/harvester/types";

const pol = (over: Partial<RawSignal> = {}): RawSignal => ({
  symbol: "AMD",
  source: "CONGRESS",
  author: "Rep. Jane Doe",
  office: "house",
  purchaseValue: 50_000,
  reportingGapDays: 20,
  ...over,
});

describe("politicianFeatures", () => {
  it("is empty without a CONGRESS signal", () => {
    expect(politicianFeatures([{ symbol: "AMD", source: "REDDIT" }])).toEqual({});
  });

  it("summarizes politician trades and flags politician-only catalysts", () => {
    const f = politicianFeatures([
      pol(),
      pol({ author: "Sen. John Roe", office: "senate", purchaseValue: 15_000, reportingGapDays: 44 }),
      pol({ purchaseValue: undefined, reportingGapDays: undefined }),
      { symbol: "AMD", source: "REDDIT" },
    ]);
    expect(f).toEqual({
      politician_count: 3,
      politician_members: 2,
      politician_offices: "house,senate",
      politician_value_total: 65_000,
      politician_min_reporting_gap_days: 20,
      politician_max_reporting_gap_days: 44,
      politician_only_catalyst: true,
    });
  });

  it("is not politician-only when insider or options flow is also present", () => {
    expect(politicianFeatures([pol(), { symbol: "AMD", source: "SEC_INSIDER" }]).politician_only_catalyst).toBe(false);
    expect(politicianFeatures([pol(), { symbol: "AMD", source: "OPTIONS_FLOW" }]).politician_only_catalyst).toBe(false);
  });

  it("reads the office from the signal, else from the Sen./Rep. author prefix", () => {
    expect(politicianOffice(pol({ office: "president" }))).toBe("president");
    expect(politicianOffice(pol({ office: undefined, author: "Sen. A B" }))).toBe("senate");
    expect(politicianOffice(pol({ office: undefined, author: "Rep. A B" }))).toBe("house");
    expect(politicianOffice(pol({ office: undefined, author: "Governor X" }))).toBeNull();
    expect(politicianFeatures([pol({ office: undefined, author: undefined })]).politician_offices).toBeNull();
  });

  it("does not count a signal without an author as a member", () => {
    expect(politicianFeatures([pol(), pol({ author: undefined })]).politician_members).toBe(1);
  });

  it("uses null, not 0, when values and gaps are missing", () => {
    expect(politicianFeatures([pol({ purchaseValue: undefined, reportingGapDays: undefined })])).toMatchObject({
      politician_value_total: null,
      politician_min_reporting_gap_days: null,
    });
  });
});

describe("politician ablation", () => {
  it("leaves the live catalyst set unchanged (log-only PR)", () => {
    expect([...HARD_CATALYST_SOURCES].sort()).toEqual(["CONGRESS", "OPTIONS_FLOW", "SEC_INSIDER"]);
    expect([...HARD_CATALYST_SOURCES_WITHOUT_POLITICIANS].sort()).toEqual(["OPTIONS_FLOW", "SEC_INSIDER"]);
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

  it("a politician-only catalyst loses its catalyst, and with the cap its score too", () => {
    const sources = new Set<Source>(["CONGRESS"]);
    const a = politicianAblation({ input: input(), sources });
    expect(a).toEqual({ current: "Buy", withoutPoliticianRules: "Watch", withoutPoliticianRulesAndCap: "Watch" });
    // Without a catalyst the same row can only land on non-catalyst paths
    const noCatalyst = politicianAblation({ input: input({ hasCatalystSource: false }), sources: new Set<Source>() });
    expect(a.withoutPoliticianRules).toBe(noCatalyst.current);
    const capped = politicianAblation({
      input: input({ hasCatalystSource: false, aiScore: SOCIAL_ONLY_SCORE_CAP }),
      sources: new Set<Source>(),
    });
    expect(a.withoutPoliticianRulesAndCap).toBe(capped.current);
  });

  it("does not change a row that has another hard catalyst", () => {
    const a = politicianAblation({ input: input(), sources: new Set<Source>(["CONGRESS", "SEC_INSIDER"]) });
    expect(a.withoutPoliticianRules).toBe(a.current);
    expect(a.withoutPoliticianRulesAndCap).toBe(a.current);
  });

  it("does not change a row without CONGRESS", () => {
    const a = politicianAblation({ input: input({ hasCatalystSource: false, aiScore: 45 }), sources: new Set<Source>() });
    expect(a.withoutPoliticianRules).toBe(a.current);
    expect(a.withoutPoliticianRulesAndCap).toBe(a.current);
  });
});
