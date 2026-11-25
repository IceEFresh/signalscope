// Harvest health report (docs/PHASE3-PREP.md P3-0a). Read-only; bounded to the last N
// completed scans. Prints a text report and writes JSON. Exits 0 unless the DB is
// unreachable: this is a report, not a gate.
//
// On the NAS after each harvest:
//   docker compose --profile harvest run --rm harvester npx tsx scripts/harvest-health.ts
// Options: --scans N (default 5), --out path (default scripts/output/harvest-health.json)

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calendarExpiry, macroCalendar } from "@/lib/harvester/macro-calendar";
import { prisma } from "@/lib/prisma";
import { analyzeScan, flagsFor, renderText, type ScanInput } from "@/lib/health/harvest-health";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function load(n: number): Promise<ScanInput[]> {
  const scans = await prisma.scan.findMany({
    where: { status: "COMPLETED" },
    orderBy: { startedAt: "desc" },
    take: n,
    select: { id: true, startedAt: true, universeId: true, regimeFeatures: true, sectorRotation: true },
  });
  const ids = scans.map((s) => s.id);
  const [tickers, stp, universes] = await Promise.all([
    prisma.validatedTicker.findMany({ where: { scanId: { in: ids } }, select: { scanId: true, features: true } }),
    prisma.stpSignal.groupBy({ by: ["scanId"], where: { scanId: { in: ids } }, _count: { _all: true } }),
    prisma.universe.findMany({
      where: { id: { in: scans.map((s) => s.universeId).filter((u): u is string => !!u) } },
      select: { id: true, memberCount: true },
    }),
  ]);
  // P3-0c snapshot: latest scan only (about 1,500 rows), so the query stays bounded. P3-0e: crypto rows split out.
  const snapRows = ids[0] ? await prisma.universeSnapshot.findMany({ where: { scanId: ids[0] }, select: { features: true, assetClass: true } }) : undefined;
  const feat = (r: { features: unknown }) => (r.features as Record<string, unknown> | null) ?? null;
  const snapshot = snapRows?.filter((r) => r.assetClass !== "crypto").map(feat);
  const cryptoSnapshot = snapRows?.filter((r) => r.assetClass === "crypto").map(feat);
  const profiledMembers = scans[0]?.universeId
    ? await prisma.universeMember.count({ where: { universeId: scans[0].universeId, sector: { not: null }, OR: [{ assetClass: null }, { assetClass: "stock" }] } })
    : null;
  const cryptoMembers = scans[0]?.universeId
    ? await prisma.universeMember.count({ where: { universeId: scans[0].universeId, assetClass: "crypto" } })
    : null;
  const stpBy = new Map(stp.map((g) => [g.scanId, g._count._all]));
  const uniBy = new Map(universes.map((u) => [u.id, u.memberCount]));
  return scans.map((s, i) => ({
    ...(i === 0 && snapshot ? { snapshot, cryptoSnapshot, cryptoMembers, profiledMembers } : {}),
    scanId: s.id,
    startedAt: s.startedAt,
    universeSize: s.universeId ? uniBy.get(s.universeId) ?? null : null,
    regimeFeatures: (s.regimeFeatures as Record<string, unknown> | null) ?? null,
    sectorRotation: (s.sectorRotation as Record<string, unknown> | null) ?? null,
    stpRows: stpBy.get(s.id) ?? 0,
    tickers: tickers.filter((t) => t.scanId === s.id).map((t) => (t.features as Record<string, unknown> | null) ?? null),
  }));
}

async function main() {
  const n = Math.max(1, Number(arg("scans", "5")) || 5);
  const out = arg("out", "scripts/output/harvest-health.json");
  let scans: ScanInput[];
  try {
    scans = await load(n);
  } catch (err) {
    console.error("[harvest-health] database unreachable:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const reports = scans.map(analyzeScan);
  const flags = flagsFor(reports);
  console.log(renderText(reports, flags));
  // P3-0j: the macro calendar must stay ≥ 60 days ahead
  const calendar = calendarExpiry(macroCalendar(), new Date().toISOString().slice(0, 10));
  console.log(`\n${calendar.warn ? "WARNING " : ""}${calendar.line}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), reports, flags, calendar }, null, 2));
  console.log(`\nJSON written to ${out}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(0);
});
