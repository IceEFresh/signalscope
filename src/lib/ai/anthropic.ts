import Anthropic from "@anthropic-ai/sdk";
import type { ChatJSONRequest, ChatJSONResponse } from "./types";

const MODEL_MAP = {
  standard: "claude-sonnet-4-20250514",
  mini: "claude-haiku-4-5-20251001",
} as const;

// Pricing per 1M tokens (USD) — update if Anthropic changes pricing.
// PR 1d: current models added (claude-api skill price table, cached 2026-11-03); Haiku 4.5
// corrected from $0.80/$4 to $1/$5. Haiku 5.5's price is for prompts up to 100K tokens.
// cacheRead defaults to 0.1x input when not listed; cache writes are 1.25x input (5-minute TTL).
const PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "claude-haiku-4-5-20251001":  { input: 1.00, output: 5.00 },
  "claude-haiku-5-5": { input: 0.10, output: 0.50 },
  "claude-sonnet-5-5": { input: 2.00, output: 10.00, cacheRead: 0.10 },
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/** Cost in USD, counting cache writes (1.25x input) and cache reads (listed rate, else 0.1x input). */
export function computeAnthropicCost(
  model: string,
  t: { input: number; output: number; cacheWrite?: number; cacheRead?: number },
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  return (
    t.input * p.input +
    t.output * p.output +
    (t.cacheWrite ?? 0) * p.input * 1.25 +
    (t.cacheRead ?? 0) * cacheRead
  ) / 1_000_000;
}

export async function chatJSONAnthropic(
  req: ChatJSONRequest
): Promise<ChatJSONResponse> {
  const model = MODEL_MAP[req.tier];
  const response = await getClient().messages.create({
    model,
    max_tokens: 4096,
    temperature: req.temperature,
    // PR 1d: cache the system prompt. A prefix under the model's minimum (Haiku 4.5: 4096 tokens)
    // silently doesn't cache, so this is harmless where it can't help.
    system: [
      {
        type: "text",
        text: `${req.systemPrompt}\n\nYou must respond with valid JSON only. No other text.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "user", content: req.userMessage },
      { role: "assistant", content: "{" },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic returned no text content");
  }

  const raw = textBlock.text.trim().startsWith("{") ? textBlock.text.trim() : "{" + textBlock.text;
  JSON.parse(raw); // validate — throws if invalid

  const cost = computeAnthropicCost(model, {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
  });

  return {
    content: raw,
    provider: "anthropic",
    model,
    cost,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
