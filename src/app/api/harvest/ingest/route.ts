import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { processSignals } from "@/lib/harvester";
import { handleApiError } from "@/lib/api-error";
import { checkHarvestKey } from "@/lib/harvest-auth";

const signalSchema = z.object({
  symbol: z.string(),
  source: z.enum(["REDDIT", "STOCKTWITS", "SEC_INSIDER", "SEC_FILING", "OPTIONS_FLOW", "VOLUME_SPIKE", "TWITTER", "CONGRESS", "POLYMARKET", "GRADUATION"]),
  title: z.string().optional(),
  body: z.string().optional(),
  url: z.string().optional(),
  author: z.string().optional(),
  authorAge: z.number().optional(),
  authorKarma: z.number().optional(),
  upvotes: z.number().optional(),
  commentCount: z.number().optional(),
  subreddit: z.string().optional(),
  postAge: z.number().optional(),
  sortType: z.string().optional(),
  watchlistCount: z.number().optional(),
  insiderTitle: z.string().optional(),
  purchaseValue: z.number().optional(),
  optionType: z.string().optional(),
  optionVolume: z.number().optional(),
  openInterest: z.number().optional(),
  volOiRatio: z.number().optional(),
  volumeRatio: z.number().optional(),
  retweetCount: z.number().optional(),
  likeCount: z.number().optional(),
  replyCount: z.number().optional(),
  quoteCount: z.number().optional(),
  followerCount: z.number().optional(),
  isVerified: z.boolean().optional(),
  tweetType: z.string().optional(),
  marketProbability: z.number().nullable().optional().transform((v) => v ?? undefined),
  marketVolume24hr: z.number().nullable().optional().transform((v) => v ?? undefined),
  marketLiquidity: z.number().nullable().optional().transform((v) => v ?? undefined),
  marketEndDate: z.string().nullable().optional().transform((v) => v ?? undefined),
  netPremium: z.number().nullable().optional().transform((v) => v ?? undefined),
  callPremiumRatio: z.number().nullable().optional().transform((v) => v ?? undefined),
  // Graduation watch (PR 1-0)
  filedAt: z.string().optional(),
  filingKey: z.string().optional(),
  reportingGapDays: z.number().optional(),
  graduationSource: z.string().optional(),
  filingAgeDays: z.number().optional(),
  flippedCriteria: z.array(z.string()).optional(),
});

const nullableNum = z.number().finite().nullable();

const ingestPayloadSchema = z.object({
  signals: z.array(signalSchema).min(1),
  harvestedAt: z.string().datetime(),
  // PR 1-0 additions; optional so an older harvester still works.
  universeId: z.string().nullable().optional(),
  barMetrics: z
    .record(z.string(), z.object({ dollarVolume20d: nullableNum, atrPct: nullableNum, hv20: nullableNum }))
    .optional(),
  // PLAN.md 1a bar features (log only)
  barFeatures: z
    .record(z.string(), z.record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.null()])))
    .optional(),
  // PLAN.md 1g STP states and triggers (log only)
  stp: z
    .record(
      z.string(),
      z.object({
        barDate: z.string().nullable(),
        htfOpens: nullableNum,
        maState: nullableNum,
        wellBid: nullableNum,
        sizeFactor: nullableNum,
        trigger: nullableNum,
        triggerType: z.string().nullable(),
        firedRules: z.array(z.string()),
        atr14: nullableNum,
        fudge: nullableNum,
        entry: nullableNum,
        stop: nullableNum,
        risk: nullableNum,
        target2R: nullableNum,
        target3R: nullableNum,
        addLevel2R: nullableNum,
        addLevel3R: nullableNum,
      }),
    )
    .optional(),
  watchChecks: z
    .array(
      z.object({
        watchId: z.string(),
        failingCriteria: z.array(z.string()),
        graduated: z.boolean(),
        flippedCriteria: z.array(z.string()),
      }),
    )
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    const denied = checkHarvestKey(req, "harvest/ingest");
    if (denied) return denied;

    const body = await req.json();
    const parsed = ingestPayloadSchema.parse(body);

    // Log source breakdown
    const sourceCounts = parsed.signals.reduce((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const uniqueSymbols = new Set(parsed.signals.map((s) => s.symbol)).size;

    console.log(`[harvest/ingest] Received ${parsed.signals.length} signals (${uniqueSymbols} unique symbols) harvested at ${parsed.harvestedAt}`);
    console.log(`[harvest/ingest] Source breakdown:`, JSON.stringify(sourceCounts));

    const t0 = Date.now();
    const scanId = await processSignals(parsed.signals, {
      universeId: parsed.universeId ?? null,
      barMetrics: parsed.barMetrics ?? {},
      barFeatures: parsed.barFeatures ?? {},
      stp: parsed.stp ?? {},
      watchChecks: parsed.watchChecks ?? [],
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`[harvest/ingest] Processing completed in ${elapsed}s — scanId=${scanId}`);

    return NextResponse.json({ status: "completed", scanId });
  } catch (err) {
    return handleApiError(err, "harvest/ingest");
  }
}
