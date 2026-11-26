import { fetchOptionsRaw } from "../options-chain";
import type { RawSignal } from "../types";
import { SCAN_SYMBOLS } from "./ticker-utils";

// yahoo-finance2 doesn't export subpath types, so define what we need
interface OptionsContract {
  contractSymbol: string;
  strike: number;
  volume?: number;
  openInterest?: number;
  expiration: Date;
  impliedVolatility: number;
  inTheMoney: boolean;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  [key: string]: unknown;
}

export interface OptionsChainResult {
  quote: { regularMarketPrice?: number; [key: string]: unknown };
  options: { calls: OptionsContract[]; puts: OptionsContract[] }[];
  [key: string]: unknown;
}

// Thresholds
const VOL_OI_RATIO_THRESHOLD = 3.0;
const MIN_ABSOLUTE_VOLUME = 1_000;
const MIN_OPEN_INTEREST = 100;
const OTM_FACTOR = 1.10; // 10%+ above current price
const SWEEP_MIN_STRIKES = 3;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2_000;

export interface UnusualContract {
  strike: number;
  expiry: string;
  type: "Call" | "Put";
  volume: number;
  openInterest: number;
  volOiRatio: number;
  isOTM: boolean;
}

async function fetchOptionsChain(symbol: string): Promise<OptionsChainResult | null> {
  try {
    // No date param — Yahoo returns the nearest expiry by default.
    // Passing a calculated date (e.g. next Friday) often misses the actual
    // expiry timestamp Yahoo expects, returning 0 contracts.
    // PLAN.md 1h: per-run cache shared with the option features (same nearest-expiry call as before)
    return (await fetchOptionsRaw(symbol)) as OptionsChainResult;
  } catch (err) {
    console.warn(
      `[options-flow] Failed to fetch ${symbol}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export function analyzeChain(
  symbol: string,
  result: OptionsChainResult,
): UnusualContract[] {
  const unusual: UnusualContract[] = [];
  const price = result.quote?.regularMarketPrice;
  if (!price) return unusual;

  const allContracts: (OptionsContract & { type: "Call" | "Put" })[] = [
    ...(result.options[0]?.calls ?? []).map((c) => ({ ...c, type: "Call" as const })),
    ...(result.options[0]?.puts ?? []).map((p) => ({ ...p, type: "Put" as const })),
  ];

  for (const c of allContracts) {
    const volume = c.volume ?? 0;
    const oi = c.openInterest ?? 0;
    if (volume < MIN_ABSOLUTE_VOLUME || oi < MIN_OPEN_INTEREST) continue;

    const ratio = volume / oi;
    if (ratio < VOL_OI_RATIO_THRESHOLD) continue;

    const isOTM =
      c.type === "Call"
        ? c.strike > price * OTM_FACTOR
        : c.strike < price * (2 - OTM_FACTOR); // 10% below for puts

    unusual.push({
      strike: c.strike,
      expiry: c.expiration
        ? (c.expiration instanceof Date ? c.expiration : new Date(c.expiration)).toISOString().slice(0, 10)
        : "unknown",
      type: c.type,
      volume,
      openInterest: oi,
      volOiRatio: Math.round(ratio * 100) / 100,
      isOTM,
    });
  }

  return unusual;
}

export function computeNetPremium(
  result: OptionsChainResult,
): { netPremium: number; callPremiumRatio: number } | null {
  const opts = result.options[0];
  if (!opts) return null;

  let callPrem = 0;
  let putPrem = 0;

  for (const c of opts.calls ?? []) {
    const vol = c.volume ?? 0;
    if (vol === 0) continue;
    const mid =
      c.bid != null && c.ask != null && c.bid > 0 && c.ask > 0
        ? (c.bid + c.ask) / 2
        : (c.lastPrice ?? 0);
    if (mid <= 0) continue;
    callPrem += vol * mid * 100;
  }

  for (const p of opts.puts ?? []) {
    const vol = p.volume ?? 0;
    if (vol === 0) continue;
    const mid =
      p.bid != null && p.ask != null && p.bid > 0 && p.ask > 0
        ? (p.bid + p.ask) / 2
        : (p.lastPrice ?? 0);
    if (mid <= 0) continue;
    putPrem += vol * mid * 100;
  }

  const total = callPrem + putPrem;
  if (total === 0) return null;

  return {
    netPremium: Math.round(callPrem - putPrem),
    callPremiumRatio: Math.round((callPrem / total) * 10000) / 10000,
  };
}

/** The first expiry with unusual calls on 3+ strikes (a sweep), or null. */
export function callSweep(contracts: readonly UnusualContract[]): [string, UnusualContract[]] | null {
  const expiryGroups = new Map<string, UnusualContract[]>();
  for (const c of contracts) {
    if (c.type !== "Call") continue;
    const group = expiryGroups.get(c.expiry) ?? [];
    group.push(c);
    expiryGroups.set(c.expiry, group);
  }
  for (const entry of expiryGroups) if (entry[1].length >= SWEEP_MIN_STRIKES) return entry;
  return null;
}

/**
 * Symbols the options-flow source scans: the universe plus the static SCAN_SYMBOLS outside it
 * (P3-0m, Chris 2026-11-26: the 89 create OPTIONS_FLOW signals again, as before PR 1-0).
 */
export function optionsFlowSymbols(scanSymbols: readonly string[]): string[] {
  return [...new Set([...scanSymbols, ...SCAN_SYMBOLS])];
}

function generateSignals(
  symbol: string,
  contracts: UnusualContract[],
): RawSignal[] {
  if (contracts.length === 0) return [];

  const signals: RawSignal[] = [];
  const calls = contracts.filter((c) => c.type === "Call");
  const otmCalls = calls.filter((c) => c.isOTM);

  // Pattern 1: Unusual Call Volume (pick the highest vol/OI call)
  if (calls.length > 0) {
    const top = calls.reduce((a, b) => (a.volOiRatio > b.volOiRatio ? a : b));
    signals.push({
      symbol,
      source: "OPTIONS_FLOW",
      title: `Unusual call volume: ${symbol} $${top.strike} ${top.expiry}`,
      body: `Vol ${top.volume.toLocaleString()} vs OI ${top.openInterest.toLocaleString()} (${top.volOiRatio}x ratio). ${calls.length} unusual call contract(s) detected.`,
      optionType: "Call",
      optionVolume: top.volume,
      openInterest: top.openInterest,
      volOiRatio: top.volOiRatio,
    });
  }

  // Pattern 2: Heavy OTM Calls (2+ distinct OTM strikes with unusual volume)
  if (otmCalls.length >= 2) {
    const totalVol = otmCalls.reduce((sum, c) => sum + c.volume, 0);
    const strikes = otmCalls.map((c) => `$${c.strike}`).join(", ");
    signals.push({
      symbol,
      source: "OPTIONS_FLOW",
      title: `Heavy OTM call activity: ${symbol} (${otmCalls.length} strikes)`,
      body: `OTM strikes with unusual volume: ${strikes}. Combined volume: ${totalVol.toLocaleString()} contracts.`,
      optionType: "Call",
      optionVolume: totalVol,
      openInterest: otmCalls.reduce((sum, c) => sum + c.openInterest, 0),
      volOiRatio: Math.round(
        (otmCalls.reduce((sum, c) => sum + c.volOiRatio, 0) / otmCalls.length) * 100
      ) / 100,
    });
  }

  // Pattern 3: Call Sweep (3+ distinct strikes on the same expiry)
  const sweep = callSweep(calls);
  if (sweep) {
    const [expiry, group] = sweep;
    const totalVol = group.reduce((sum, c) => sum + c.volume, 0);
    const strikes = group.map((c) => `$${c.strike}`).sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1))).join(", ");
    signals.push({
      symbol,
      source: "OPTIONS_FLOW",
      title: `Call sweep detected: ${symbol} ${expiry} (${group.length} strikes)`,
      body: `Systematic call buying across strikes ${strikes}. Total volume: ${totalVol.toLocaleString()} contracts.`,
      optionType: "Call",
      optionVolume: totalVol,
      openInterest: group.reduce((sum, c) => sum + c.openInterest, 0),
      volOiRatio: Math.round(
        (group.reduce((sum, c) => sum + c.volOiRatio, 0) / group.length) * 100
      ) / 100,
    });
  }

  return signals;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Scans `symbols` (the universe plus the static SCAN_SYMBOLS, see optionsFlowSymbols). */
export async function fetchOptionsFlowSignals(symbols: readonly string[] = SCAN_SYMBOLS): Promise<RawSignal[]> {
  console.log("Options Flow: scanning", symbols.length, "symbols...");
  const signals: RawSignal[] = [];

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((symbol) => fetchOptionsChain(symbol))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status !== "fulfilled" || !result.value) continue;

      const symbol = batch[j];
      const unusual = analyzeChain(symbol, result.value);
      const symbolSignals = generateSignals(symbol, unusual);
      const premium = computeNetPremium(result.value);
      if (premium && symbolSignals.length > 0) {
        symbolSignals[0].netPremium = premium.netPremium;
        symbolSignals[0].callPremiumRatio = premium.callPremiumRatio;
      }
      signals.push(...symbolSignals);
    }

    // Rate limit between batches (skip delay after last batch)
    if (i + BATCH_SIZE < symbols.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`Options Flow: ${signals.length} signals from ${symbols.length} symbols`);
  return signals;
}
