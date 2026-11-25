/**
 * P3-0i3: historical earnings sessions from SEC EDGAR 8-K Item 2.02 for every symbol in the
 * backfill bar cache (docs/PHASE3-PREP.md §P3-0i3). Writes one file per ticker to
 * scripts/output/backfill-earnings/<SYMBOL>.json; simulate-stp feeds them to computeStp so
 * EGOP can fire on the backfill. Raw EDGAR JSON is cached in backfill-earnings/raw/ (rerun
 * is free; --refresh refetches). Needs SEC_USER_AGENT. ≤ 8 requests/s with the shared retry.
 *
 *   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
 *     harvester npx tsx scripts/backfill-earnings.ts [--years 2] [--refresh]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseChartBars, etParts } from "@/lib/harvester/universe/bar-metrics";
import { barDateOf, backfillSessions } from "@/lib/harvester/universe/backfill";
import { BENCHMARK_SYMBOL } from "@/lib/harvester/universe/snapshot";
import {
  buildEarnings,
  EdgarEarningsClient,
  edgarGetter,
  earningsCoverageLine,
  fetchEarningsFilings,
  parseTickerMap,
  TICKER_MAP_URL,
  type EarningsCache,
} from "@/lib/harvester/edgar-earnings";

const BARS_DIR = "scripts/output/backfill-bars";
const OUT_DIR = "scripts/output/backfill-earnings";
const RAW_DIR = join(OUT_DIR, "raw");
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
  mkdirSync(RAW_DIR, { recursive: true });

  const now = new Date();
  const spy = parseChartBars(JSON.parse(readFileSync(join(BARS_DIR, `${BENCHMARK_SYMBOL}.json`), "utf8")), now);
  // All SPY sessions (warm-up included) resolve weekends and holidays; events are kept from the backfill's first session.
  const allSessions = [...new Set(spy.map(barDateOf).filter((d): d is string => d != null))].sort();
  const from = backfillSessions(spy, etParts(new Date(now.getTime() - years * 365 * DAY)).date, etParts(now).date)[0];
  const symbols = readdirSync(BARS_DIR)
    .filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_SYMBOL}.json`)
    .map((f) => f.replace(/\.json$/, ""))
    .sort();

  const client = new EdgarEarningsClient(edgarGetter(userAgent));
  const cache: EarningsCache = {
    read: (name) => (!refresh && existsSync(join(RAW_DIR, name)) ? (JSON.parse(readFileSync(join(RAW_DIR, name), "utf8")) as unknown) : null),
    write: (name, json) => writeFileSync(join(RAW_DIR, name), JSON.stringify(json)),
  };
  const mapName = "company_tickers.json";
  const tickerJson = cache.read(mapName) ?? (await client.json(TICKER_MAP_URL));
  cache.write(mapName, tickerJson);
  const tickerMap = parseTickerMap(tickerJson);
  console.log(`[earnings] ${symbols.length} symbols, ${tickerMap.size} SEC tickers, sessions from ${from}`);

  let errors = 0;
  const { bySymbol, coverage } = await buildEarnings(
    symbols,
    tickerMap,
    allSessions,
    from,
    (cik) => fetchEarningsFilings(cik, from, client, cache),
    (sym, err) => {
      if (errors++ < 5) console.warn(`[earnings] ${sym}: ${err instanceof Error ? err.message : err}`);
    },
  );
  for (const [symbol, { cik, events }] of bySymbol) {
    writeFileSync(join(OUT_DIR, `${symbol}.json`), JSON.stringify({ symbol, cik, source: "SEC EDGAR 8-K item 2.02", from, builtAt: now.toISOString(), events }));
  }
  console.log(`${earningsCoverageLine(coverage)}. ${client.requests} EDGAR requests.`);
}

main().catch((err) => {
  console.error("[earnings] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
