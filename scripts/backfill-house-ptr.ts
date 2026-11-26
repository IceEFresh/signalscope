/**
 * P3-0p: congress trades from the House Clerk's Periodic Transaction Reports, 2 years
 * (docs/PHASE3-PREP.md §P3-0p). Log-only and descriptive.
 *
 * Reads each year's index ZIP, then every PTR's PDF (≤ 2 requests/s), parses the transactions
 * and writes all ticker events to scripts/output/backfill-house-ptr/events.json; congressFeaturesAt
 * turns them into the cong_* keys for any ticker and session. Raw ZIPs, PDFs and parses are
 * cached in scripts/output/house-ptr/ (shared with the live harvest), so a rerun is free;
 * --refresh refetches the index ZIPs. Scanned paper filings have no text: counted, not guessed.
 *
 *   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
 *     harvester npx tsx scripts/backfill-house-ptr.ts [--years 2] [--refresh]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, etParts } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf } from "@/lib/harvester/universe/backfill";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { buildCongress, congressCoverageLine, fetchPtrIndex, fetchPtrParsed, houseGetter } from "@/lib/harvester/house-ptr";
import { fsHouseCache } from "@/lib/harvester/history-fs";

const BARS_DIR = "scripts/output/backfill-bars";
const OUT_DIR = "scripts/output/backfill-house-ptr";
const DAY = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const spyPath = join(BARS_DIR, `${BENCHMARK_SYMBOL}.json`);
  if (!existsSync(spyPath)) throw new Error(`${spyPath} not found: run scripts/backfill-snapshot.ts first`);
  const years = Number(arg("--years") ?? 2);
  const refresh = process.argv.includes("--refresh");
  mkdirSync(OUT_DIR, { recursive: true });
  const now = new Date();
  const today = etParts(now).date;
  const sessions = [...new Set(parseChartBars(JSON.parse(readFileSync(spyPath, "utf8")), now).map(barDateOf).filter((d): d is string => d != null))].sort();
  // 45 days before the backfill window, so its first sessions have a full 30-day window
  const from = new Date(now.getTime() - (years * 365 + 45) * DAY).toISOString().slice(0, 10);
  const get = houseGetter();
  const cache = fsHouseCache();
  const filings = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) filings.push(...(await fetchPtrIndex(y, get, cache, refresh || y === Number(today.slice(0, 4)))));
  const inRange = filings.filter((f) => f.filingDate >= from);
  console.log(`[house-ptr] ${inRange.length} PTRs filed from ${from} (${inRange.filter((f) => !f.electronic).length} paper)`);
  let errors = 0;
  const { events, coverage } = await buildCongress(
    inRange,
    sessions,
    (f) => fetchPtrParsed(f, get, cache),
    (f, err) => {
      if (errors++ < 5) console.warn(`[house-ptr] ${f.docId}: ${err instanceof Error ? err.message : err}`);
    },
  );
  writeFileSync(
    join(OUT_DIR, "events.json"),
    JSON.stringify({ source: "House Clerk PTRs", timing: "first session after the filing date", from, builtAt: now.toISOString(), coverage, events }),
  );
  console.log(`${congressCoverageLine(coverage)}; ${events.length} ticker events; ${get.requests()} House Clerk requests`);
}

main().catch((err) => {
  console.error("[house-ptr] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
