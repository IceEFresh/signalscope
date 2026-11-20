/**
 * Nasdaq Trader symbol directory (every NYSE, Nasdaq and other US-listed symbol).
 * Free, no key. https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs
 */

export const NASDAQ_TRADED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";

export interface DirectoryListing {
  /** Yahoo form: class shares use "-" (BRK.B -> BRK-B). */
  symbol: string;
  name: string;
  listingExchange: string;
}

/** Security names that are not common or ADR equity. */
const NON_COMMON = /\b(warrants?|units?|rights?|preferred|notes?|debentures?|due \d{4})\b/i;

/**
 * Parse nasdaqtraded.txt. Drops ETFs, test issues, NextShares, warrants, units,
 * rights, preferreds and notes. Keeps common stock and ADRs.
 */
export function parseNasdaqTraded(text: string): DirectoryListing[] {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.split("|") ?? [];
  const col = (name: string) => header.indexOf(name);
  const iSym = col("Symbol");
  const iName = col("Security Name");
  const iExch = col("Listing Exchange");
  const iEtf = col("ETF");
  const iTest = col("Test Issue");
  const iNext = col("NextShares");
  if ([iSym, iName, iExch, iEtf, iTest].some((i) => i < 0)) return [];

  const out: DirectoryListing[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith("File Creation Time")) continue;
    const f = line.split("|");
    const raw = f[iSym]?.trim();
    if (!raw) continue;
    if (f[iEtf] === "Y" || f[iTest] === "Y") continue;
    if (iNext >= 0 && f[iNext] === "Y") continue;
    const name = f[iName]?.trim() ?? "";
    if (NON_COMMON.test(name)) continue;
    // Plain tickers or one class suffix (BRK.B). Anything with $, ^, = or + is a non-common series.
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(raw)) continue;
    const symbol = raw.replace(".", "-");
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name, listingExchange: f[iExch] ?? "" });
  }
  return out;
}

export async function fetchSymbolDirectory(): Promise<DirectoryListing[]> {
  const res = await fetch(NASDAQ_TRADED_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`nasdaqtraded.txt returned ${res.status}`);
  return parseNasdaqTraded(await res.text());
}
