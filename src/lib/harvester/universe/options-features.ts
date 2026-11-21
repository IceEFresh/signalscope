/**
 * Option-chain features, PLAN.md PR 1h (BOOK-IMPROVEMENTS row #6, Natenberg).
 * LOG ONLY: merged into ValidatedTicker.features; the existing OPTIONS_FLOW
 * signal and every score, stage and label are unchanged.
 *
 * Source: Yahoo chains for two expiries per ticker, the nearest and the one
 * closest to 30 days (see options-chain.ts for why not Cboe). Yahoo has no
 * greeks, so delta for the 25-delta skew is Black-Scholes from each contract's
 * own implied volatility. Missing data is null, never 0.
 */
import type { NormalizedChain, OptionContract } from "../options-chain";

export const OPTIONS_FEATURES_VERSION = 1;
/**
 * The "near" expiry is the first one at least this many days out. Same-day and
 * next-day expiries carry 0DTE noise (an expiring chain's ATM IV is not a
 * term-structure point), so they are skipped.
 */
export const MIN_NEAR_DAYS = 5;
/** [Guessing] flat risk-free rate for Black-Scholes delta; delta is insensitive to it at these tenors. */
export const RISK_FREE_RATE = 0.04;
/** US equity options stop trading at 16:00 ET = 21:00 UTC (20:00 in summer); Yahoo dates are 00:00 UTC. */
const EXPIRY_CLOSE_OFFSET_S = 21 * 3600;
/** Yahoo reports IV ~0 (e.g. 1e-5) for illiquid strikes; ignore implausible values. */
const IV_MIN = 0.01;
const IV_MAX = 5;

export interface OptionsFeatures {
  opt_features_version: number;
  opt_near_days: number | null; // days to the nearest expiry used
  opt_far_days: number | null; // days to the ~30-day expiry used
  opt_atm_iv_near: number | null;
  opt_atm_iv_30d: number | null;
  opt_iv_term_slope: number | null; // atm_iv_30d − atm_iv_near (negative = inverted, event priced in)
  opt_iv_hv20_ratio: number | null; // atm_iv_30d / 1a hv20 (cheap vs rich options)
  opt_skew_25d: number | null; // 30-day: IV(25Δ put) − IV(25Δ call)
  opt_pc_volume_ratio: number | null; // put volume / call volume, both expiries
  opt_pc_oi_ratio: number | null; // put OI / call OI, both expiries
  opt_call_premium: number | null; // Σ volume × mid × 100, both expiries, USD
  opt_put_premium: number | null;
  opt_unusual_contracts: number | null; // contracts with volume ≥ 3 × open interest (OI > 0)
}

export const EMPTY_OPTIONS_FEATURES: OptionsFeatures = {
  opt_features_version: OPTIONS_FEATURES_VERSION,
  opt_near_days: null,
  opt_far_days: null,
  opt_atm_iv_near: null,
  opt_atm_iv_30d: null,
  opt_iv_term_slope: null,
  opt_iv_hv20_ratio: null,
  opt_skew_25d: null,
  opt_pc_volume_ratio: null,
  opt_pc_oi_ratio: null,
  opt_call_premium: null,
  opt_put_premium: null,
  opt_unusual_contracts: null,
};

/** Days from `nowS` to the expiry's 16:00 ET close (fractional). */
export function daysToExpiry(expiry: number, nowS: number): number {
  return (expiry + EXPIRY_CLOSE_OFFSET_S - nowS) / 86_400;
}

/** The listed expiry closest to `targetDays` within [minDays, maxDays], or null. */
export function pickExpiry(expirations: number[], nowS: number, targetDays = 30, minDays = 14, maxDays = 60): number | null {
  let best: number | null = null;
  for (const e of expirations) {
    const d = daysToExpiry(e, nowS);
    if (d < minDays || d > maxDays) continue;
    if (best == null || Math.abs(d - targetDays) < Math.abs(daysToExpiry(best, nowS) - targetDays)) best = e;
  }
  return best;
}

const validIv = (c: OptionContract) => c.iv != null && c.iv >= IV_MIN && c.iv <= IV_MAX;

function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Black-Scholes delta (no dividends). Call in (0, 1), put in (−1, 0). */
export function bsDelta(kind: "call" | "put", spot: number, strike: number, iv: number, years: number, r = RISK_FREE_RATE): number {
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * years) / (iv * Math.sqrt(years));
  return kind === "call" ? normCdf(d1) : normCdf(d1) - 1;
}

/** Mean of call and put IV at the strike nearest the spot (either side alone if only one is valid). */
export function atmIv(chain: NormalizedChain, spot: number): number | null {
  const strikes = [...new Set([...chain.calls, ...chain.puts].filter(validIv).map((c) => c.strike))];
  if (strikes.length === 0) return null;
  const k = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  const ivs = [chain.calls.find((c) => c.strike === k), chain.puts.find((c) => c.strike === k)]
    .filter((c): c is OptionContract => !!c && validIv(c))
    .map((c) => c.iv!);
  return ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null;
}

/** IV(25Δ put) − IV(25Δ call), using each contract's own IV for its delta. */
export function skew25d(chain: NormalizedChain, spot: number, nowS: number): number | null {
  const years = daysToExpiry(chain.expiry, nowS) / 365;
  if (years <= 0) return null;
  const closest = (list: OptionContract[], kind: "call" | "put", target: number) => {
    let best: { c: OptionContract; dist: number } | null = null;
    for (const c of list.filter(validIv)) {
      const dist = Math.abs(bsDelta(kind, spot, c.strike, c.iv!, years) - target);
      if (!best || dist < best.dist) best = { c, dist };
    }
    // Only accept a contract reasonably near 25 delta
    return best && best.dist <= 0.1 ? best.c : null;
  };
  const put = closest(chain.puts, "put", -0.25);
  const call = closest(chain.calls, "call", 0.25);
  return put && call ? put.iv! - call.iv! : null;
}

const mid = (c: OptionContract) => (c.bid != null && c.ask != null && c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : c.last ?? 0);

export function computeOptionsFeatures(
  near: NormalizedChain | null,
  far: NormalizedChain | null,
  hv20: number | null,
  nowS: number,
): OptionsFeatures {
  if (!near && !far) return { ...EMPTY_OPTIONS_FEATURES };
  const spot = near?.spot ?? far?.spot ?? null;
  const chains = [near, far].filter((c, i, a): c is NormalizedChain => !!c && a.findIndex((x) => x?.expiry === c.expiry) === i);
  const all = (side: "calls" | "puts") => chains.flatMap((c) => c[side]);
  const calls = all("calls");
  const puts = all("puts");
  const sum = (list: OptionContract[], f: (c: OptionContract) => number) => list.reduce((s, c) => s + f(c), 0);
  const callVol = sum(calls, (c) => c.volume);
  const putVol = sum(puts, (c) => c.volume);
  const callOi = sum(calls, (c) => c.openInterest);
  const putOi = sum(puts, (c) => c.openInterest);
  const ivNear = near && spot != null ? atmIv(near, spot) : null;
  const iv30 = far && spot != null ? atmIv(far, spot) : null;
  return {
    opt_features_version: OPTIONS_FEATURES_VERSION,
    opt_near_days: near ? daysToExpiry(near.expiry, nowS) : null,
    opt_far_days: far ? daysToExpiry(far.expiry, nowS) : null,
    opt_atm_iv_near: ivNear,
    opt_atm_iv_30d: iv30,
    opt_iv_term_slope: ivNear != null && iv30 != null ? iv30 - ivNear : null,
    opt_iv_hv20_ratio: iv30 != null && hv20 != null && hv20 > 0 ? iv30 / hv20 : null,
    opt_skew_25d: far && spot != null ? skew25d(far, spot, nowS) : null,
    opt_pc_volume_ratio: callVol > 0 ? putVol / callVol : null,
    opt_pc_oi_ratio: callOi > 0 ? putOi / callOi : null,
    opt_call_premium: calls.length ? sum(calls, (c) => c.volume * mid(c) * 100) : null,
    opt_put_premium: puts.length ? sum(puts, (c) => c.volume * mid(c) * 100) : null,
    opt_unusual_contracts: calls.length + puts.length ? [...calls, ...puts].filter((c) => c.openInterest > 0 && c.volume >= 3 * c.openInterest).length : null,
  };
}
