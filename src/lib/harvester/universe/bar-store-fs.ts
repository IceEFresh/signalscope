/**
 * Disk adapter for the P3-0i2b bar store: one chart-JSON file per symbol under
 * BAR_STORE_DIR (default data/bar-store, bind-mounted into the harvester container).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchYahooChart } from "../yahoo-chart";
import type { BarStoreIO } from "./bar-store";

export const DEFAULT_BAR_STORE_DIR = "data/bar-store";
const DAY_S = 86_400;

export const storeFile = (dir: string, symbol: string) => join(dir, `${symbol.replace(/[^A-Za-z0-9.^=-]/g, "_")}.json`);

export function fsBarStoreIO(dir: string = process.env.BAR_STORE_DIR || DEFAULT_BAR_STORE_DIR, now: Date = new Date()): BarStoreIO {
  return {
    read: (symbol) => {
      const f = storeFile(dir, symbol);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as unknown) : null;
    },
    write: (symbol, json) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(storeFile(dir, symbol), JSON.stringify(json));
    },
    fetch2y: async (symbol) => {
      const p2 = Math.floor(now.getTime() / 1000);
      const p1 = p2 - (2 * 365 + 10) * DAY_S;
      const res = await fetchYahooChart(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`);
      return res.ok ? res.json : null;
    },
  };
}
