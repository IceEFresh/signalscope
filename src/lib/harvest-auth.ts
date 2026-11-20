import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Shared-secret auth for harvester endpoints (x-harvest-key header).
 * Returns an error response to send, or null when the key matches.
 */
export function checkHarvestKey(req: NextRequest, route: string): NextResponse | null {
  const harvestKey = req.headers.get("x-harvest-key");
  const expectedKey = process.env.HARVEST_API_KEY;

  if (!expectedKey) {
    console.error(`[${route}] HARVEST_API_KEY not configured`);
    return NextResponse.json({ error: "Endpoint not configured" }, { status: 503 });
  }

  const bufKey = harvestKey ? Buffer.from(harvestKey, "utf8") : null;
  const bufExpected = Buffer.from(expectedKey, "utf8");
  const keyMatch =
    bufKey !== null &&
    bufKey.byteLength === bufExpected.byteLength &&
    timingSafeEqual(bufKey, bufExpected);
  return keyMatch ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
