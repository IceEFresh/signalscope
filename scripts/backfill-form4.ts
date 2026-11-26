/**
 * P3-0n §1: insider transactions from SEC EDGAR Form 4 for every symbol in the backfill bar
 * cache, 2 years (docs/PHASE3-PREP.md §P3-0n). Log-only and descriptive.
 *
 * Writes one file per ticker to scripts/output/backfill-form4/<SYMBOL>.json with its insider
 * events (signal session from the filing's acceptance time); insiderFeaturesAt turns them into
 * the ins_* keys for any session. Raw submissions JSON and Form 4 XML are cached (gzipped) in
 * scripts/output/edgar-form4/, which the live harvest shares, so reruns are free; --refresh
 * refetches each issuer's main submissions JSON for new filings. Needs SEC_USER_AGENT.
 * ≤ 8 requests/s with the shared retry.
 *
 *   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
 *     harvester npx tsx scripts/backfill-form4.ts [--years 2] [--refresh] [--symbols A,B]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, etParts } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf, backfillSessions } from "@/lib/harvester/universe/backfill";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import { EdgarEarningsClient, edgarGetter, normTicker, parseTickerMap, TICKER_MAP_URL } from "@/lib/harvester/edgar-earnings";
import { buildForm4, fetchForm4History, form4CoverageLine } from "@/lib/harvester/form4-history";
import { fsForm4Cache } from "@/lib/harvester/history-fs";

const BARS_DIR = "scripts/output/backfill-bars";
const OUT_DIR = "scripts/output/backfill-form4";
const DAY = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) throw new Error("SEC_USER_AGENT is not set (SEC requires a contact in the User-Agent)");
  if (!existsSync(BARS_DIR)) throw new Error(`${BARS_DIR} not found: run scripts/backfill-snapshot.ts first`);
  const years = Number(arg("--years") ?? 2);
  const refresh = process.argv.includes("--refresh");
  mkdirSync(OUT_DIR, { recursive: true });

  const now = new Date();
  const spy = parseChartBars(JSON.parse(readFileSync(join(BARS_DIR, `${BENCHMARK_SYMBOL}.json`), "utf8")), now);
  const allSessions = [...new Set(spy.map(barDateOf).filter((d): d is string => d != null))].sort();
  // 45 days before the backfill's first session, so its 30-day window and 10-session cluster are full
  const first = backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, etParts(now).date)[0];
  const from = new Date(Date.parse(`${first}T12:00:00Z`) - 45 * DAY).toISOString().slice(0, 10);
  const only = arg("--symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const symbols =
    only ??
    readdirSync(BARS_DIR)
      .filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_SYMBOL}.json`)
      .map((f) => f.replace(/\.json$/, ""))
      .sort();

  const client = new EdgarEarningsClient(edgarGetter(userAgent));
  const cache = fsForm4Cache();
  const mapName = "company_tickers.json";
  const tickerJson = (!refresh && cache.readJson(mapName)) || (await client.json(TICKER_MAP_URL));
  cache.writeJson(mapName, tickerJson);
  const tickerMap = parseTickerMap(tickerJson);
  console.log(`[form4] ${symbols.length} symbols, ${tickerMap.size} SEC tickers, filings from ${from} (backfill from ${first})`);

  let errors = 0;
  const { bySymbol, coverage } = await buildForm4(
    symbols,
    (s) => tickerMap.get(normTicker(s)),
    allSessions,
    (cik, stats) => fetchForm4History(cik, from, client, cache, { refreshMain: refresh, stats }),
    (sym, err) => {
      if (errors++ < 5) console.warn(`[form4] ${sym}: ${err instanceof Error ? err.message : err}`);
    },
  );
  for (const [symbol, { cik, events }] of bySymbol) {
    writeFileSync(
      join(OUT_DIR, `${symbol}.json`),
      JSON.stringify({ symbol, cik, source: "SEC EDGAR Form 4 (non-derivative)", timing: "acceptance session", from, builtAt: now.toISOString(), events }),
    );
  }
  console.log(`${form4CoverageLine(coverage)}. ${client.requests} EDGAR requests.`);
}

main().catch((err) => {
  console.error("[form4] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
