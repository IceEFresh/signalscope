import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkHarvestKey } from "@/lib/harvest-auth";
import { handleApiError } from "@/lib/api-error";
import { writeSnapshotRows } from "@/lib/harvester/universe/snapshot-store";
import { SNAPSHOT_BATCH } from "@/lib/harvester/universe/snapshot";

/** Universe-wide daily snapshot rows for a completed scan (P3-0c, log only). One POST per batch. */
const schema = z.object({
  scanId: z.string().min(1),
  rows: z
    .array(
      z.object({
        symbol: z.string().min(1).max(20), // P3-0e: Yahoo crypto symbols such as HYPE32196-USD
        sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        close: z.number().finite().positive(),
        features: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
        assetClass: z.enum(["stock", "crypto"]).optional(),
      }),
    )
    .min(1)
    .max(SNAPSHOT_BATCH),
});

export async function POST(req: NextRequest) {
  try {
    const denied = checkHarvestKey(req, "harvest/snapshot");
    if (denied) return denied;
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid snapshot payload", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
    const scan = await prisma.scan.findUnique({ where: { id: parsed.data.scanId }, select: { id: true } });
    if (!scan) return NextResponse.json({ error: "Unknown scanId" }, { status: 404 });
    const t0 = Date.now();
    const inserted = await writeSnapshotRows(parsed.data.scanId, parsed.data.rows);
    console.log(`[snapshot] scan ${parsed.data.scanId}: ${inserted}/${parsed.data.rows.length} rows in ${Date.now() - t0} ms`);
    return NextResponse.json({ inserted });
  } catch (err) {
    return handleApiError(err, "harvest/snapshot POST");
  }
}
