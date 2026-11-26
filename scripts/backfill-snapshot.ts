// P3-0g price-history backfill (docs/PHASE3-PREP.md). LOG ONLY: writes UniverseSnapshot
// rows for past sessions, marked features.backfill = true, under one synthetic Scan per
// session (status FAILED, error "backfill:v1 ..."), which no live reader sees. Never
// touches a live scan: rows go only to backfill scan ids, and conflicts are skipped.
//
// Run by hand on the NAS, from the harvester container (needs DATABASE_URL):
//   npx tsx scripts/backfill-snapshot.ts --limit 20          # measure first: 20 members, prints the projection
//   npx tsx scripts/backfill-snapshot.ts --years 2           # all current universe members + SPY
//   npx tsx scripts/backfill-snapshot.ts --symbols AMD,NVDA  # specific symbols
// Raw charts are cached under scripts/output/backfill-bars/, so a rerun doesn't refetch,
// and a rerun after a partial run writes only the missing rows.
//   --warmup-days N   calendar days before the window (default 300, P3-0k2; was 120)
//   --refresh         refetch every chart even when cached (a failed fetch keeps the cached file);
//                     DB rows already written are never overwritten

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { fetchYahooChart } from "@/lib/harvester/yahoo-chart";
import { etParts, parseChartBars, type DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { loadUniverse } from "@/lib/harvester/universe/store";
import { BENCHMARK_SYMBOL, chunk, type SnapshotRow } from "@/lib/harvester/universe/snapshot";
import {
  BACKFILL_SCAN_ERROR,
  warmupDaysArg,
  backfillRowsForSymbol,
  backfillScanId,
  backfillScanStartedAt,
  backfillSessions,
  backfillWindow,
  chartCoversWindow,
  featureBytes,
  pendingRows,
} from "@/lib/harvester/universe/backfill";

const CACHE_DIR = "scripts/output/backfill-bars";
const PACE_MS = 300; // same spacing as fetchBarMetricsMany's batches
const DAY = 86_400_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadBars(symbol: string, period1: number, period2: number, now: Date, refresh = false): Promise<{ bars: DailyBar[]; fetched: boolean }> {
  const path = join(CACHE_DIR, `${symbol.replace(/[^A-Za-z0-9.^=-]/g, "_")}.json`);
  const cached = () => ({ bars: parseChartBars(JSON.parse(readFileSync(path, "utf8")), now), fetched: true });
  // P3-0k5: a chart cached for a shorter window (e.g. a 2-year run before --years 5) is refetched
  if (existsSync(path) && !refresh && chartCoversWindow(JSON.parse(readFileSync(path, "utf8")), period1)) return { ...cached(), fetched: false };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetchYahooChart(url);
  if (!res.ok) {
    console.warn(`[backfill] ${symbol}: chart failed (status ${res.status ?? "network"}${res.rateLimited ? ", 429" : ""})${existsSync(path) ? "; keeping the cached file" : ""}`);
    return existsSync(path) ? cached() : { bars: [], fetched: true };
  }
  writeFileSync(path, JSON.stringify(res.json));
  return { bars: parseChartBars(res.json, now), fetched: true };
}

async function main() {
  const years = Number(arg("--years") ?? 2);
  const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
  const now = new Date();
  mkdirSync(CACHE_DIR, { recursive: true });

  let symbols: string[];
  let universeSize: number;
  if (arg("--symbols")) {
    symbols = arg("--symbols")!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    universeSize = symbols.length;
  } else {
    const u = await loadUniverse();
    if (!u) throw new Error("no stored universe; run a harvest first or pass --symbols");
    symbols = [...u.symbols].sort();
    universeSize = symbols.length;
  }
  if (limit) symbols = symbols.slice(0, limit);
  symbols = [BENCHMARK_SYMBOL, ...symbols.filter((s) => s !== BENCHMARK_SYMBOL)];

  const warmupDays = warmupDaysArg(process.argv);
  const refresh = process.argv.includes("--refresh");
  const win = backfillWindow(now, years, warmupDays);
  const { period1, period2 } = win;
  console.log(`[backfill] ${years} years from ${win.since}, warm-up ${warmupDays} days (fetch from ${win.fetchFrom})${refresh ? ", refreshing every cached chart" : ""}`);
  const since = etParts(new Date(now.getTime() - years * 365 * DAY)).date;
  const until = etParts(now).date;

  const started = Date.now();
  const spy = await loadBars(BENCHMARK_SYMBOL, period1, period2, now, refresh);
  if (spy.bars.length === 0) throw new Error("SPY chart unavailable; nothing to backfill against");
  const sessions = backfillSessions(spy.bars, since, until);
  console.log(`[backfill] ${symbols.length} symbols (incl. SPY), ${sessions.length} sessions ${sessions[0]}..${sessions.at(-1)}`);

  // One synthetic scan per session; createMany skips ones a previous run made.
  for (const part of chunk(sessions)) {
    await prisma.scan.createMany({
      data: part.map((d) => ({
        id: backfillScanId(d),
        status: "FAILED" as const,
        error: BACKFILL_SCAN_ERROR,
        startedAt: backfillScanStartedAt(d),
        completedAt: backfillScanStartedAt(d),
      })),
      skipDuplicates: true,
    });
  }

  let rowsWritten = 0;
  let rowsComputed = 0;
  let bytes = 0;
  let failed = 0;
  for (const [i, symbol] of symbols.entries()) {
    const { bars, fetched } = symbol === BENCHMARK_SYMBOL ? spy : await loadBars(symbol, period1, period2, now, refresh);
    if (bars.length === 0) {
      failed++;
      continue;
    }
    const rows: SnapshotRow[] = backfillRowsForSymbol(symbol, bars, spy.bars, sessions);
    rowsComputed += rows.length;
    bytes += featureBytes(rows);
    const stored = await prisma.universeSnapshot.findMany({
      where: { symbol, scanId: { startsWith: "backfill-v" } },
      select: { scanId: true },
    });
    const todo = pendingRows(rows, new Set(stored.map((s) => `${s.scanId}|${symbol}`)));
    for (const part of chunk(todo)) {
      const res = await prisma.universeSnapshot.createMany({
        data: part.map((r) => ({
          scanId: backfillScanId(r.sessionDate),
          symbol: r.symbol,
          sessionDate: r.sessionDate,
          close: r.close,
          features: r.features as Prisma.InputJsonValue,
          assetClass: "stock",
        })),
        skipDuplicates: true, // never overwrite: a (scanId, symbol) conflict is skipped
      });
      rowsWritten += res.count;
    }
    if ((i + 1) % 50 === 0) console.log(`[backfill] ${i + 1}/${symbols.length} symbols, ${rowsWritten} rows written`);
    if (fetched && i + 1 < symbols.length) await new Promise((r) => setTimeout(r, PACE_MS));
  }

  const secs = (Date.now() - started) / 1000;
  const done = symbols.length - failed;
  console.log(`[backfill] done in ${secs.toFixed(0)} s: ${rowsComputed} rows computed, ${rowsWritten} written, ${failed} symbols failed`);
  if (done > 0) {
    const perSym = { rows: rowsComputed / done, bytes: bytes / done, secs: secs / done };
    const total = universeSize + 1;
    console.log(
      `[backfill] per symbol: ${perSym.rows.toFixed(0)} rows, ${(perSym.bytes / 1024).toFixed(0)} KB features JSON, ${perSym.secs.toFixed(1)} s. ` +
        `Projection for ${total} symbols: ${Math.round(perSym.rows * total)} rows, ` +
        `${((perSym.bytes * total) / 1e9).toFixed(2)} GB features JSON (before row/index overhead), ` +
        `${((perSym.secs * total) / 60).toFixed(0)} min.`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
