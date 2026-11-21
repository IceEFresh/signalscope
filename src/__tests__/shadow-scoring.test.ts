import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AggregatedSymbol } from "@/lib/harvester/types";

const mockCostCreate = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({ prisma: { aiCostLog: { create: (...a: unknown[]) => mockCostCreate(...a) } } }));
const mockChatJSON = vi.fn();
vi.mock("@/lib/ai", () => ({ chatJSON: (...a: unknown[]) => mockChatJSON(...a) }));

const { shadowChatJSON, SHADOW_SCORING_MODEL, shadowScoringEnabled } = await import("@/lib/ai/shadow");
const { computeAnthropicCost } = await import("@/lib/ai/anthropic");
const { scoreSymbolBatch, scoreSymbolBatchShadow, SCORING_SYSTEM_PROMPT, buildScoringPayload } = await import("@/lib/harvester/scoring");
const { getTotalCost, resetCostTracker } = await import("@/lib/ai/cost-tracker");

function agg(symbol: string, sources: string[] = ["REDDIT", "STOCKTWITS"]): AggregatedSymbol {
  return {
    symbol,
    signals: sources.map((source) => ({ symbol, source: source as never, title: "t" })),
    sourceCount: sources.length,
    weightedSourceScore: sources.length,
    subredditCount: 1,
    totalUpvotes: 10,
    totalComments: 2,
    avgVelocity: 1,
    momentum: { risingCount: 0, freshCount: 0, recentCount: 0, commentDerivedCount: 0, staleCount: 0 },
    medianSignalAgeHrs: 2,
  };
}

function fakeClient(response: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { messages: { create } } as never, create };
}

const okResponse = (json: unknown) => ({
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(json) }],
  usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCostTracker();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.stubEnv("SHADOW_SCORING", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("shadowChatJSON request shape (Haiku 5.5)", () => {
  it("uses structured output, low effort and a cached system prompt, with no temperature or prefill", async () => {
    const { client, create } = fakeClient(okResponse({ scores: [] }));
    await shadowChatJSON("SYSTEM", "USER", { scanId: "scan_1" }, client);
    const req = create.mock.calls[0][0];
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req).not.toHaveProperty("temperature");
    expect(req.messages).toEqual([{ role: "user", content: "USER" }]); // no assistant prefill
    expect(req.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    expect(req.output_config.effort).toBe("low");
    expect(req.output_config.format.type).toBe("json_schema");
  });

  it("parses the text block, prices cache reads, adds to the scan cost and logs it separately", async () => {
    const { client } = fakeClient(okResponse({ scores: [{ symbol: "A" }] }));
    const r = await shadowChatJSON("S", "U", { scanId: "scan_1" }, client);
    expect(r.json).toEqual({ scores: [{ symbol: "A" }] });
    // 1000 in × $0.10 + 200 out × $0.50 + 3000 cache reads × $0.01 (0.1x), per MTok
    expect(r.cost).toBeCloseTo((1000 * 0.1 + 200 * 0.5 + 3000 * 0.01) / 1e6, 12);
    expect(getTotalCost()).toBeCloseTo(r.cost, 12);
    expect(mockCostCreate.mock.calls[0][0].data).toMatchObject({ callPoint: "scoring_shadow", model: SHADOW_SCORING_MODEL, scanId: "scan_1" });
  });

  it("throws on a refusal or an empty response", async () => {
    await expect(shadowChatJSON("S", "U", {}, fakeClient({ stop_reason: "refusal", content: [], usage: okResponse({}).usage }).client)).rejects.toThrow(/refused/);
    await expect(shadowChatJSON("S", "U", {}, fakeClient({ stop_reason: "end_turn", content: [], usage: okResponse({}).usage }).client)).rejects.toThrow(/no text/);
  });
});

describe("computeAnthropicCost", () => {
  it("charges cache writes at 1.25x input and uses a listed cache-read price when there is one", () => {
    expect(computeAnthropicCost("claude-sonnet-5-5", { input: 0, output: 0, cacheWrite: 1e6, cacheRead: 1e6 })).toBeCloseTo(2 * 1.25 + 0.1, 12);
    expect(computeAnthropicCost("unknown-model", { input: 1e6, output: 1e6 })).toBe(0);
  });
});

describe("shadowScoringEnabled", () => {
  it("needs an Anthropic key and can be switched off", () => {
    expect(shadowScoringEnabled()).toBe(true);
    vi.stubEnv("SHADOW_SCORING", "off");
    expect(shadowScoringEnabled()).toBe(false);
    vi.stubEnv("SHADOW_SCORING", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(shadowScoringEnabled()).toBe(false);
  });
});

describe("scoreSymbolBatchShadow", () => {
  const batch = [agg("SOC"), agg("CAT", ["SEC_INSIDER", "REDDIT"]), agg("MISS")];

  it("sends the production prompt and payload, applies the social-only cap, and leaves skipped symbols out", async () => {
    const call = vi.fn().mockResolvedValue({
      json: { scores: [
        { symbol: "SOC", score: 80, sentiment: "bullish", reasoning: "r" },
        { symbol: "CAT", score: 80, sentiment: "bullish", reasoning: "r" },
      ] },
      model: "claude-haiku-5-5",
      cost: 0,
    });
    const out = await scoreSymbolBatchShadow(batch, undefined, undefined, "scan_1", call);
    expect(call).toHaveBeenCalledWith(SCORING_SYSTEM_PROMPT, JSON.stringify(buildScoringPayload(batch)), { scanId: "scan_1" });
    expect(out.get("SOC")).toEqual({ score: 50, rawScore: 80, sentiment: "bullish", model: "claude-haiku-5-5" });
    expect(out.get("CAT")!.score).toBe(80);
    expect(out.has("MISS")).toBe(false); // no heuristic fill-in for the shadow
  });

  it("returns an empty map on failure, malformed output, or when disabled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await scoreSymbolBatchShadow(batch, undefined, undefined, "s", vi.fn().mockRejectedValue(new Error("x")))).size).toBe(0);
    expect((await scoreSymbolBatchShadow(batch, undefined, undefined, "s", vi.fn().mockResolvedValue({ json: { nope: 1 }, model: "m", cost: 0 }))).size).toBe(0);
    vi.stubEnv("SHADOW_SCORING", "off");
    const call = vi.fn();
    expect((await scoreSymbolBatchShadow(batch, undefined, undefined, "s", call)).size).toBe(0);
    expect(call).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("production scoring is unchanged", () => {
  it("still calls chatJSON with the same prompt, tier and temperature", async () => {
    mockChatJSON.mockResolvedValue({ content: JSON.stringify({ scores: [{ symbol: "SOC", score: 40, sentiment: "neutral", reasoning: "r" }] }) });
    const r = await scoreSymbolBatch([agg("SOC")]);
    expect(mockChatJSON.mock.calls[0][0]).toMatchObject({ callPoint: "scoring", tier: "mini", temperature: 0.3, systemPrompt: SCORING_SYSTEM_PROMPT });
    expect(r[0]).toMatchObject({ symbol: "SOC", score: 40 });
  });
});
