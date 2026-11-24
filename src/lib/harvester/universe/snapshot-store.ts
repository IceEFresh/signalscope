/** P3-0c snapshot writes (web side). Chunked createMany; duplicates for a scan are skipped. */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { chunk, SNAPSHOT_BATCH, type SnapshotRow } from "./snapshot";

export interface SnapshotWriter {
  createMany(args: { data: Prisma.UniverseSnapshotCreateManyInput[]; skipDuplicates: boolean }): Promise<{ count: number }>;
}

export async function writeSnapshotRows(
  scanId: string,
  rows: readonly SnapshotRow[],
  db: SnapshotWriter = prisma.universeSnapshot,
): Promise<number> {
  let inserted = 0;
  for (const part of chunk(rows, SNAPSHOT_BATCH)) {
    const res = await db.createMany({
      data: part.map((r) => ({ scanId, symbol: r.symbol, sessionDate: r.sessionDate, close: r.close, features: r.features as Prisma.InputJsonValue, assetClass: r.assetClass ?? "stock" })),
      skipDuplicates: true,
    });
    inserted += res.count;
  }
  return inserted;
}
