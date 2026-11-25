/**
 * P3-0i4: fill sector/industry on the latest universe's stock members where they're null
 * (the 2026-11-24 build stored 0 of 1,485). Updates existing rows only, never overwrites a
 * stored value, no schema change. Used by scripts/backfill-profiles.ts.
 */
import type { Profile, ProfileFetchStats } from "../fundamentals";

export interface MemberProfileRow {
  id: string;
  symbol: string;
  sector: string | null;
  industry: string | null;
}

export interface ProfileBackfillDeps {
  /** The latest universe and its stock members (crypto members have no Yahoo profile). */
  latest: () => Promise<{ id: string; refreshedAt: Date; members: MemberProfileRow[] } | null>;
  fetchProfiles: (symbols: string[]) => Promise<{ profiles: Map<string, Profile>; stats: ProfileFetchStats }>;
  /** Set `field` on member `id` only while it's still null; returns rows changed (0 or 1). */
  setIfNull: (id: string, field: "sector" | "industry", value: string) => Promise<number>;
}

export interface ProfileBackfillResult {
  universeId: string | null;
  refreshedAt: string | null;
  members: number;
  missing: number;
  stats: ProfileFetchStats | null;
  sectorUpdated: number;
  industryUpdated: number;
  dryRun: boolean;
}

export async function backfillProfiles(deps: ProfileBackfillDeps, opts: { dryRun?: boolean } = {}): Promise<ProfileBackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const u = await deps.latest();
  if (!u) return { universeId: null, refreshedAt: null, members: 0, missing: 0, stats: null, sectorUpdated: 0, industryUpdated: 0, dryRun };
  const missing = u.members.filter((m) => m.sector == null || m.industry == null);
  const { stats, profiles } = await deps.fetchProfiles(missing.map((m) => m.symbol));
  let sectorUpdated = 0;
  let industryUpdated = 0;
  for (const m of missing) {
    const p = profiles.get(m.symbol);
    if (!p) continue;
    if (m.sector == null && p.sector != null) sectorUpdated += dryRun ? 1 : await deps.setIfNull(m.id, "sector", p.sector);
    if (m.industry == null && p.industry != null) industryUpdated += dryRun ? 1 : await deps.setIfNull(m.id, "industry", p.industry);
  }
  return { universeId: u.id, refreshedAt: u.refreshedAt.toISOString(), members: u.members.length, missing: missing.length, stats, sectorUpdated, industryUpdated, dryRun };
}

export function profileBackfillLine(r: ProfileBackfillResult): string {
  if (!r.universeId) return "[backfill-profiles] no universe stored; nothing to do";
  const s = r.stats!;
  return (
    `[backfill-profiles]${r.dryRun ? " DRY RUN" : ""} universe ${r.universeId} (${r.refreshedAt!.slice(0, 10)}): ${r.members} stock members, ${r.missing} missing a sector or industry; ` +
    `profiles ${s.fetched}/${s.total} fetched, ${s.empty} empty, ${s.failed} failed; ${r.dryRun ? "would update" : "updated"} sector on ${r.sectorUpdated}, industry on ${r.industryUpdated}`
  );
}
