/**
 * P3-0i4: one-off. Fills sector/industry on the latest universe's stock members where null,
 * from Yahoo assetProfile (paced, retried, failures counted). Updates existing rows only.
 *
 *   docker compose --profile harvest run --rm harvester npx tsx scripts/backfill-profiles.ts [--dry-run]
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { fetchAssetProfile, fetchProfilesWith, logProfileStats } from "@/lib/harvester/fundamentals";
import { STOCK_MEMBER } from "@/lib/harvester/universe/store";
import { backfillProfiles, profileBackfillLine } from "@/lib/harvester/universe/profile-backfill";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await backfillProfiles(
    {
      latest: async () => {
        const u = await prisma.universe.findFirst({ orderBy: { refreshedAt: "desc" }, select: { id: true, refreshedAt: true } });
        if (!u) return null;
        const members = await prisma.universeMember.findMany({
          where: { universeId: u.id, ...STOCK_MEMBER },
          select: { id: true, symbol: true, sector: true, industry: true },
          orderBy: { symbol: "asc" },
        });
        return { ...u, members };
      },
      fetchProfiles: async (symbols) => {
        const r = await fetchProfilesWith(symbols, fetchAssetProfile);
        logProfileStats(r.stats);
        return r;
      },
      setIfNull: async (id, field, value) =>
        (await prisma.universeMember.updateMany({ where: { id, [field]: null }, data: { [field]: value } })).count,
    },
    { dryRun },
  );
  console.log(profileBackfillLine(result));
}

main()
  .catch((err) => {
    console.error("[backfill-profiles] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
