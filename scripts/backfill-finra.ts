/**
 * P3-0n §2–3: FINRA short interest (twice monthly) and Reg SHO daily short-sale volume for
 * every symbol in the backfill bar cache, 2 years (docs/PHASE3-PREP.md §P3-0n). Log-only and
 * descriptive.
 *
 * Writes one file per ticker to scripts/output/backfill-finra/<SYMBOL>.json: its short interest
 * reports (siFeaturesAt applies the publication-date rule), its daily short-volume ratio by
 * session (svFeaturesAt), and Yahoo's current float (an approximation for past dates). Raw
 * FINRA files are cached gzipped in scripts/output/finra/raw/ (shared with the live harvest);
 * floats in scripts/output/finra/floats.json (--refresh-floats refetches them).
 *
 *   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
 *     harvester npx tsx scripts/backfill-finra.ts [--years 2] [--refresh-floats] [--symbols A,B]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, etParts } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf, backfillSessions } from "@/lib/harvester/universe/backfill";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { fetchFloats, fetchShortInterest, fetchShortVolume, finraGetter, siRowsFor, svRatiosFor, SV_WINDOW } from "@/lib/harvester/finra";
import { fsFinraCache, readFloats, writeFloats } from "@/lib/harvester/history-fs";

const BARS_DIR = "scripts/output/backfill-bars";
const OUT_DIR = "scripts/output/backfill-finra";
const DAY = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  if (!existsSync(BARS_DIR)) throw new Error(`${BARS_DIR} not found: run scripts/backfill-snapshot.ts first`);
  const years = Number(arg("--years") ?? 2);
  mkdirSync(OUT_DIR, { recursive: true });
  const now = new Date();
  const today = etParts(now).date;
  const spy = parseChartBars(JSON.parse(readFileSync(join(BARS_DIR, `${BENCHMARK_SYMBOL}.json`), "utf8")), now);
  const allSessions = [...new Set(spy.map(barDateOf).filter((d): d is string => d != null))].sort();
  const backfill = backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, today);
  const first = backfill[0];
  // Short volume from 20 sessions before the backfill (the z-score baseline); short interest from a month before
  const svSessions = allSessions.slice(Math.max(0, allSessions.indexOf(first) - SV_WINDOW));
  const siFrom = new Date(Date.parse(`${first}T12:00:00Z`) - 35 * DAY).toISOString().slice(0, 10);
  const only = arg("--symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const symbols =
    only ??
    readdirSync(BARS_DIR)
      .filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_SYMBOL}.json`)
      .map((f) => f.replace(/\.json$/, ""))
      .sort();

  const get = finraGetter();
  const cache = fsFinraCache();
  const siStats = { fetched: 0, missing: 0 };
  const svStats = { fetched: 0, missing: 0 };
  console.log(`[finra] ${symbols.length} symbols; short interest from ${siFrom}, short volume over ${svSessions.length} sessions from ${svSessions[0]}`);
  const reports = await fetchShortInterest(siFrom, today, get, cache, siStats);
  console.log(`[finra] short interest: ${reports.length} reports (${siStats.fetched} fetched, ${siStats.missing} candidate dates without a file)`);
  const sv = await fetchShortVolume(svSessions, get, cache, svStats);
  const svMissing = [...sv.values()].filter((v) => v == null).length;
  console.log(`[finra] short volume: ${svSessions.length - svMissing}/${svSessions.length} sessions (${svStats.fetched} fetched, ${svMissing} missing)`);

  let floats = readFloats();
  const needFloats = process.argv.includes("--refresh-floats") ? symbols : symbols.filter((s) => !(floats?.floats && s in floats.floats));
  if (needFloats.length) {
    console.log(`[finra] fetching Yahoo floats for ${needFloats.length} symbols...`);
    floats = { fetchedAt: now.toISOString(), floats: { ...(floats?.floats ?? {}), ...(await fetchFloats(needFloats)) } };
    writeFloats(floats);
  }

  let withSi = 0;
  let withSv = 0;
  let withFloat = 0;
  for (const symbol of symbols) {
    const si = siRowsFor(reports, symbol);
    const ratios = svRatiosFor(sv, svSessions, symbol);
    const float = floats?.floats[symbol] ?? null;
    if (si.length) withSi++;
    if (ratios.some((r) => r != null)) withSv++;
    if (float != null) withFloat++;
    writeFileSync(
      join(OUT_DIR, `${symbol}.json`),
      JSON.stringify({
        symbol,
        source: "FINRA short interest + Reg SHO daily short volume (CNMS)",
        builtAt: now.toISOString(),
        float,
        floatSource: "yahoo_current",
        si,
        sv: Object.fromEntries(svSessions.map((s, i) => [s, ratios[i] == null ? null : Math.round(ratios[i]! * 1e4) / 1e4])),
      }),
    );
  }
  console.log(`[finra] ${symbols.length} symbols: short interest ${withSi}, short volume ${withSv}, float ${withFloat}`);
}

main().catch((err) => {
  console.error("[finra] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
