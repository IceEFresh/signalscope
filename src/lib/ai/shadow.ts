/**
 * Shadow AI scoring, PLAN.md PR 1d (Chris, 2026-11-20: option 2, "shadow first").
 *
 * The production score keeps coming from the configured provider (OpenAI on the
 * NAS). This module scores the same batch with Claude Haiku 5.5 and returns the
 * result for logging only: it is stored in ValidatedTicker.features and never
 * feeds aiScore, stage or labels. Phase 3 compares the two before any switch.
 *
 * Haiku 5.5 request shape (claude-api skill): no `temperature` (non-default
 * values return 400) and no assistant prefill (400), so JSON comes from
 * structured output (`output_config.format`). Adaptive thinking is on by
 * default; effort is set to `low` for a short classification-style call. The
 * system prompt is cached (512-token minimum on Haiku 5.5), so parallel batches
 * after the first read it from cache.
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { addCost } from "./cost-tracker";
import { computeAnthropicCost } from "./anthropic";

export const SHADOW_SCORING_MODEL = "claude-haiku-5-5";

/** Shadow scoring runs only with an Anthropic key, and can be switched off with SHADOW_SCORING=off. */
export function shadowScoringEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.SHADOW_SCORING !== "off";
}

export const SCORES_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          score: { type: "number" },
          sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          reasoning: { type: "string" },
        },
        required: ["symbol", "score", "sentiment", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export interface ShadowCallResult {
  json: unknown;
  model: string;
  cost: number;
}

/** One structured-output call to Haiku 5.5. Throws on API errors, refusals and empty output. */
export async function shadowChatJSON(
  systemPrompt: string,
  userMessage: string,
  context?: { scanId?: string },
  anthropic: Pick<Anthropic, "messages"> = getClient(),
): Promise<ShadowCallResult> {
  const response = await anthropic.messages.create({
    model: SHADOW_SCORING_MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCORES_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: userMessage }],
  });

  if (response.stop_reason === "refusal") throw new Error("shadow scoring: model refused");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("shadow scoring: no text content");

  const u = response.usage;
  const cost = computeAnthropicCost(SHADOW_SCORING_MODEL, {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  });
  addCost(cost);
  if (context?.scanId) {
    prisma.aiCostLog
      .create({
        data: {
          callPoint: "scoring_shadow",
          trigger: "harvest",
          provider: "anthropic",
          model: SHADOW_SCORING_MODEL,
          inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          cost,
          scanId: context.scanId,
        },
      })
      .catch((err) => console.error("[ai] Failed to log shadow cost:", err));
  }
  return { json: JSON.parse(text.text), model: SHADOW_SCORING_MODEL, cost };
}
