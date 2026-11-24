/**
 * DB side of the universe and graduation watch (web host). Every function here
 * is called inside try/catch by its caller: a failure is logged and the harvest
 * carries on.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { RawSignal, WatchCheck } from "../types";
import type { UniverseBuildResult } from "./build";
import { mergeWatchEntry, watchEntriesFromSignals, type ActiveWatchRow, type WatchSource } from "./watch";

/** A universe build is stale after this many days and the harvester rebuilds it. */
export const UNIVERSE_MAX_AGE_DAYS = 7;
/** Refuse to store a build smaller than this: it is almost certainly a failed fetch. */
export const MIN_UNIVERSE_SIZE = 50;

export interface LoadedUniverse {
  id: string;
  refreshedAt: Date;
  symbols: Set<string>;
}

export async function loadUniverse(id?: string | null): Promise<LoadedUniverse | null> {
  const u = id
    ? await prisma.universe.findUnique({ where: { id }, include: { members: { select: { symbol: true } } } })
    : await prisma.universe.findFirst({ orderBy: { refreshedAt: "desc" }, include: { members: { select: { symbol: true } } } });
  if (!u) return null;
  return { id: u.id, refreshedAt: u.refreshedAt, symbols: new Set(u.members.map((m) => m.symbol)) };
}

export type UniverseProfiles = Record<string, { sector: string | null; industry: string | null }>;

/** P3-0d: sector and industry for each member that has a profile. */
export async function loadUniverseProfiles(universeId: string): Promise<UniverseProfiles> {
  const rows = await prisma.universeMember.findMany({
    where: { universeId, OR: [{ sector: { not: null } }, { industry: { not: null } }] },
    select: { symbol: true, sector: true, industry: true },
  });
  return Object.fromEntries(rows.map((r) => [r.symbol, { sector: r.sector, industry: r.industry }]));
}

export async function saveUniverse(build: UniverseBuildResult): Promise<string> {
  if (build.members.length < MIN_UNIVERSE_SIZE) {
    throw new Error(`Universe build has ${build.members.length} members (< ${MIN_UNIVERSE_SIZE}); not stored`);
  }
  const u = await prisma.universe.create({
    data: {
      rule: build.rule as unknown as Prisma.InputJsonValue,
      directoryCount: build.directoryCount,
      prefilterCount: build.prefilterCount,
      memberCount: build.members.length,
      members: { createMany: { data: build.members } },
    },
  });
  return u.id;
}

export async function getActiveWatch(now: Date = new Date()): Promise<ActiveWatchRow[]> {
  const rows = await prisma.graduationWatch.findMany({
    where: { graduatedAt: null, expiresAt: { gt: now } },
    orderBy: { lastFiledAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    source: r.source as WatchSource,
    firstFiledAt: r.firstFiledAt.toISOString(),
    lastFiledAt: r.lastFiledAt.toISOString(),
    totalValue: r.totalValue,
    isCluster: r.isCluster,
    failingCriteria: r.failingCriteria,
  }));
}

/** Add this scan's out-of-universe insider/congress buys to the watch. Returns rows created or updated. */
export async function recordWatchEntries(
  signals: readonly RawSignal[],
  isOutsideUniverse: (symbol: string) => boolean,
  now: Date = new Date(),
): Promise<number> {
  const entries = watchEntriesFromSignals(signals, isOutsideUniverse);
  let changed = 0;
  for (const entry of entries) {
    const existing = await prisma.graduationWatch.findFirst({
      where: { symbol: entry.symbol, source: entry.source, graduatedAt: null, expiresAt: { gt: now } },
      orderBy: { lastFiledAt: "desc" },
    });
    const merged = mergeWatchEntry(existing, entry, now);
    if (!merged) continue;
    if (existing) {
      await prisma.graduationWatch.update({ where: { id: existing.id }, data: merged });
    } else {
      await prisma.graduationWatch.create({
        data: { ...merged, symbol: entry.symbol, source: entry.source, committees: [], failingCriteria: [], flippedCriteria: [] },
      });
    }
    changed++;
  }
  return changed;
}

export async function applyWatchChecks(checks: readonly WatchCheck[], scanId: string, now: Date = new Date()): Promise<void> {
  for (const c of checks) {
    await prisma.graduationWatch.update({
      where: { id: c.watchId },
      data: {
        lastCheckedAt: now,
        failingCriteria: c.failingCriteria,
        ...(c.graduated ? { graduatedAt: now, graduatedScanId: scanId, flippedCriteria: c.flippedCriteria } : {}),
      },
    });
  }
}
