import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkHarvestKey } from "@/lib/harvest-auth";
import { handleApiError } from "@/lib/api-error";
import { getActiveWatch, loadUniverse, loadUniverseProfiles, saveUniverse } from "@/lib/harvester/universe/store";
import { UNIVERSE_RULE } from "@/lib/harvester/universe/rule";

/** Current universe and active graduation watch, for the harvester (PLAN.md PR 1-0). */
export async function GET(req: NextRequest) {
  try {
    const denied = checkHarvestKey(req, "harvest/universe");
    if (denied) return denied;

    const [universe, watch] = await Promise.all([loadUniverse(), getActiveWatch()]);
    // P3-0d: sector and industry per member, for the universe snapshot's sector features
    const profiles = universe ? await loadUniverseProfiles(universe.id) : {};
    return NextResponse.json({
      universe: universe
        ? { id: universe.id, refreshedAt: universe.refreshedAt.toISOString(), symbols: [...universe.symbols].sort(), profiles }
        : null,
      watch,
    });
  } catch (err) {
    return handleApiError(err, "harvest/universe GET");
  }
}

const n = z.number().finite().nullable();
const buildSchema = z.object({
  directoryCount: z.number().int().nonnegative(),
  prefilterCount: z.number().int().nonnegative(),
  members: z.array(
    z.object({
      symbol: z.string().min(1).max(10),
      price: n,
      marketCap: n,
      dollarVolume20d: n,
      atrPct: n,
      hv20: n,
      hasOptions: z.boolean(),
      // P3-0d: weekly profile; older harvesters omit these
      sector: z.string().max(100).nullable().optional(),
      industry: z.string().max(100).nullable().optional(),
    }),
  ),
});

/** Store a weekly universe build computed by the harvester. */
export async function POST(req: NextRequest) {
  try {
    const denied = checkHarvestKey(req, "harvest/universe");
    if (denied) return denied;

    const parsed = buildSchema.parse(await req.json());
    const id = await saveUniverse({ ...parsed, rule: UNIVERSE_RULE });
    console.log(`[harvest/universe] Stored universe ${id} with ${parsed.members.length} members`);
    return NextResponse.json({ id, memberCount: parsed.members.length });
  } catch (err) {
    return handleApiError(err, "harvest/universe POST");
  }
}
