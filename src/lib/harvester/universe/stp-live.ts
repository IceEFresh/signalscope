/**
 * P3-0i2: live, log-only keys from the P3-0i work, added to the universe snapshot rows and
 * the ticker features JSON on every harvest. Pure; nothing here feeds a score, stage or
 * label, and none of these keys is a pre-registered candidate (they're excluded in
 * src/lib/eval/features.ts until a pre-registration update adds them).
 *
 * - §1c rolling opens: stp_htf_opens_rolling, stp_trigger_rolling, stp_trigger_type_rolling
 *   (inside and U-turn only); 5/20 sessions for stocks, 7/30 bars for crypto.
 * - §1j sizing: stp_size_factor_long / _short (the fixed rule; the live stp_size_factor keeps
 *   Pine's abs() for parity) and size_combined_long / _short (stock × pyramid, floor 0.25).
 * - §1g Power Pyramid: pyramid_market_{spy,qqq,dia}_htf and the market vote per direction,
 *   pyramid_sector_* and pyramid_industry_* (ETF, htf, state per direction), and
 *   pyramid_size_long / _short.
 * - §1i Finviz: finviz_base and finviz_screens (space-joined IDs). Earnings and short-float
 *   screens are null until those inputs exist.
 * - §1f swings: swing_k{1.5,2,3}_{rally_used,rally_age,room_3r_at_entry,pullback_ratio} and
 *   the profile medians. With an STP trigger, the trade's direction, entry and stop are used
 *   (room_3r from entry − stop); without one, the long side at the close, and room_3r is null.
 *
 * The StpSignal table and the calendar trigger are unchanged.
 */
import type { DailyBar } from "./bar-metrics";
import { etParts } from "./bar-metrics";
import type { StpResult } from "./stp";
import { computeStpRolling, rollingWindowsFor } from "./stp-rolling";
import { layerState, marketVote, MARKET_ETFS, sizeMult, type EtfState } from "./pyramid";
import { passingScreens, screensOn } from "./finviz-screens";
import { SWING_KS, swingEntry, swingProfile, zigzag } from "./swings";
import { combinedSize, stockFactor } from "@/lib/eval/stp-sim";
import { wilderAtr } from "./bar-features";

export type LiveValue = number | string | boolean | null;

export interface LiveContext {
  assetClass: "stock" | "crypto";
  /** ETF state maps by date for SPY, QQQ, DIA (in MARKET_ETFS order); stocks only. */
  market?: ReadonlyArray<ReadonlyMap<string, EtfState> | null>;
  sectorEtf?: string | null;
  sectorStates?: ReadonlyMap<string, EtfState> | null;
  industryEtf?: string | null;
  industryStates?: ReadonlyMap<string, EtfState> | null;
}

/** P3-0i2 keys, all logged for every row (null when not computable), so the health report sees each family. */
export const LIVE_STP_KEY_PREFIXES = ["stp_htf_opens_rolling", "stp_trigger_rolling", "stp_trigger_type_rolling", "stp_size_factor_long", "stp_size_factor_short", "size_combined_", "pyramid_", "finviz_", "swing_k"] as const;

const atrOf = (bars: readonly DailyBar[]) => {
  const s = wilderAtr(bars);
  return bars.map((_, i) => (i >= 14 ? s[i - 14] ?? null : null));
};

/** Live keys for the last bar of `bars`; `stp` is computeStp on the same bars (calendar). */
export function liveStpKeys(bars: readonly DailyBar[], stp: StpResult | undefined, ctx: LiveContext): Record<string, LiveValue> {
  const out: Record<string, LiveValue> = {};
  const t = bars.length - 1;
  const last = bars[t];
  const date = last?.time != null ? etParts(new Date(last.time * 1000)).date : null;
  const sameBar = !!stp && stp.barDate === date;

  // §1c rolling opens
  const r = bars.length ? computeStpRolling(bars, rollingWindowsFor(ctx.assetClass)) : null;
  out.stp_htf_opens_rolling = r?.htfOpensRolling ?? null;
  out.stp_trigger_rolling = r?.trigger ?? null;
  out.stp_trigger_type_rolling = r?.triggerType ?? null;

  // §1j stock factor per direction (fixed rule)
  const htf = sameBar ? stp!.htfOpens : null;
  const ma = sameBar ? stp!.maState : null;
  const stockLong = sameBar ? stockFactor(htf, ma, 1) : null;
  const stockShort = sameBar ? stockFactor(htf, ma, -1) : null;
  out.stp_size_factor_long = stockLong;
  out.stp_size_factor_short = stockShort;

  if (ctx.assetClass === "stock") {
    // §1g Power Pyramid
    const at = (m: ReadonlyMap<string, EtfState> | null | undefined) => (date && m ? m.get(date) ?? null : null);
    const market = ctx.market ?? [null, null, null];
    MARKET_ETFS.forEach((etf, i) => {
      out[`pyramid_market_${etf.toLowerCase()}_htf`] = at(market[i])?.opens ?? null;
    });
    const sec = at(ctx.sectorStates);
    const ind = at(ctx.industryStates);
    out.pyramid_sector_etf = ctx.sectorEtf ?? null;
    out.pyramid_sector_htf = sec?.opens ?? null;
    out.pyramid_industry_etf = ctx.industryEtf ?? null;
    out.pyramid_industry_htf = ind?.opens ?? null;
    for (const [dir, name] of [[1, "long"], [-1, "short"]] as const) {
      const m = marketVote(market.map((x) => layerState(at(x), dir)));
      const s = layerState(sec, dir);
      out[`pyramid_market_${name}`] = m;
      out[`pyramid_sector_${name}`] = s;
      out[`pyramid_industry_${name}`] = layerState(ind, dir);
      const pyr = sizeMult(m, s);
      out[`pyramid_size_${name}`] = pyr;
      const stock = name === "long" ? stockLong : stockShort;
      out[`size_combined_${name}`] = stock == null ? null : combinedSize(stock, pyr);
    }

    // §1i Finviz screens (earnings and short float unknown live for now → those screens null)
    const atr = atrOf(bars);
    const sc = bars.length ? screensOn(bars, t, atr) : null;
    out.finviz_base = sc?.base ?? null;
    out.finviz_screens = sc ? passingScreens(sc).join(" ") : null;
  }

  // §1f swing scores and profile medians
  const trig = sameBar && (stp!.trigger === 1 || stp!.trigger === -1) && stp!.entry != null && stp!.stop != null ? stp! : null;
  const dir: 1 | -1 = trig ? (trig.trigger as 1 | -1) : 1;
  const price = trig ? trig.entry! : last?.close ?? null;
  const risk = trig ? Math.abs(trig.entry! - trig.stop!) : null;
  for (const k of SWING_KS) {
    const pref = `swing_k${k}`;
    const piv = bars.length ? zigzag(bars, k) : [];
    const e = price != null && bars.length ? swingEntry(bars, t, price, risk ?? 1, dir, k, piv) : null;
    const p = bars.length ? swingProfile(bars, t, k, piv) : { rally: null, pullback: null };
    out[`${pref}_rally_used`] = e?.rallyUsed ?? null;
    out[`${pref}_rally_age`] = e?.rallyAge ?? null;
    out[`${pref}_room_3r_at_entry`] = risk != null ? e?.room3R ?? null : null;
    out[`${pref}_pullback_ratio`] = e?.pullbackRatio ?? null;
    out[`${pref}_rally_median_atr`] = p.rally?.medianAtr ?? null;
    out[`${pref}_pullback_median_atr`] = p.pullback?.medianAtr ?? null;
    out[`${pref}_rally_median_bars`] = p.rally?.medianBars ?? null;
    out[`${pref}_pullback_median_bars`] = p.pullback?.medianBars ?? null;
  }
  return out;
}
