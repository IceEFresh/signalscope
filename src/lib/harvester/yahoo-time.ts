/** yahoo-finance2 returns timestamps (e.g. earningsTimestamp) as Date; raw JSON has unix seconds. */
export function toUnixSeconds(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : Math.floor(v.getTime() / 1000);
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : v;
  return null;
}
