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
import { swingHistory } from "./bar-store";
import { pyramidLayers } from "./pyramid";
import { inHoursOn, macroCalendar, nextEvent, outOfHoursWithin, type MacroEvent } from "../macro-calendar";
import { funnelGates, LEVEL_SWING_K, riskReward, RR_MIN } from "@/lib/eval/funnel";
import { alignmentAt, marketAlignment, optimalEntry, p3kSize, type Alignment } from "@/lib/eval/aligned";
import { layerStates, P3K_TYPES, type LayerSeries } from "@/lib/eval/aligned-sim";
import type { WatchKeys } from "../watchlist";

export type LiveValue = number | string | boolean | null;

export interface LiveContext {
  assetClass: "stock" | "crypto";
  /** ETF state maps by date for SPY, QQQ, DIA (in MARKET_ETFS order); stocks only. */
  market?: ReadonlyArray<ReadonlyMap<string, EtfState> | null>;
  sectorEtf?: string | null;
  sectorStates?: ReadonlyMap<string, EtfState> | null;
  industryEtf?: string | null;
  industryStates?: ReadonlyMap<string, EtfState> | null;
  /** P3-0i2b: the symbol's stored bar history; the swing keys use it plus this run's chart (≤ D). */
  history?: readonly DailyBar[];
  /** P3-0j: the macro calendar (default: the checked-in one). */
  events?: readonly MacroEvent[];
  /** P3-0j: whether the stock reports earnings within 5 sessions (Yahoo); null/undefined = unknown, not blocking. */
  earnings5?: boolean | null;
  /** P3-0k: long-direction alignment by date for the stock's industry, sector and market ETFs (store + chart). */
  alignLayers?: LayerSeries;
  /** P3-0l: the ticker's watchlist keys (all null when not watched). */
  watch?: WatchKeys;
}

/** P3-0i2 keys, all logged for every row (null when not computable), so the health report sees each family. */
export const LIVE_STP_KEY_PREFIXES = ["stp_htf_opens_rolling", "stp_trigger_rolling", "stp_trigger_type_rolling", "stp_size_factor_long", "stp_size_factor_short", "size_combined_", "pyramid_", "finviz_", "swing_k"] as const;
/** P3-0j funnel keys (stock rows; log only). funnel_rank is set across the run's rows by applyFunnelRanks. */
/** P3-0k aligned-trend keys (stock rows; log only). */
/** P3-0l watchlist keys (stock rows; log only). */
export const LIVE_WATCH_KEYS = ["watch_sources", "watch_first_seen", "watch_direction", "watch_direction_source", "watch_entry_ready", "watch_size", "watch_only"] as const;
export const LIVE_P3K_KEYS = ["align_stock", "align_industry", "align_sector", "align_market", "optimal_entry", "p3k_candidate", "p3k_size_long", "p3k_size_short"] as const;
export const LIVE_FUNNEL_KEYS = [
  "funnel_pass", "gate_finviz", "gate_earnings5", "gate_rr", "event_half", "event_today_inhours", "rr", "rr_level", "open_air", "funnel_rank", "countertrend", "next_event", "next_event_days",
] as const;

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
  const marketLong = ctx.assetClass === "stock" ? pyramidLayers({ market: ctx.market ?? [null, null, null], sector: null, industry: null }, date ?? "", 1).market : null;

  // §1f swing scores and profile medians
  const trig = sameBar && (stp!.trigger === 1 || stp!.trigger === -1) && stp!.entry != null && stp!.stop != null ? stp! : null;
  const dir: 1 | -1 = trig ? (trig.trigger as 1 | -1) : 1;
  const price = trig ? trig.entry! : last?.close ?? null;
  const risk = trig ? Math.abs(trig.entry! - trig.stop!) : null;
  // Swings alone read the longer stored history (P3-0i2b); every other key keeps the chart, matching the backfill.
  const sb = ctx.history ? swingHistory(ctx.history, bars) : bars;
  const st = sb.length - 1;
  for (const k of SWING_KS) {
    const pref = `swing_k${k}`;
    const piv = sb.length ? zigzag(sb, k) : [];
    const e = price != null && sb.length ? swingEntry(sb, st, price, risk ?? 1, dir, k, piv) : null;
    const p = sb.length ? swingProfile(sb, st, k, piv) : { rally: null, pullback: null };
    out[`${pref}_rally_used`] = e?.rallyUsed ?? null;
    out[`${pref}_rally_age`] = e?.rallyAge ?? null;
    out[`${pref}_room_3r_at_entry`] = risk != null ? e?.room3R ?? null : null;
    out[`${pref}_pullback_ratio`] = e?.pullbackRatio ?? null;
    out[`${pref}_rally_median_atr`] = p.rally?.medianAtr ?? null;
    out[`${pref}_pullback_median_atr`] = p.pullback?.medianAtr ?? null;
    out[`${pref}_rally_median_bars`] = p.rally?.medianBars ?? null;
    out[`${pref}_pullback_median_bars`] = p.pullback?.medianBars ?? null;
  }

  // P3-0j funnel (stocks): gates and R/R on an STP trigger today; the event keys on every stock row
  if (ctx.assetClass === "stock") {
    const events = ctx.events ?? macroCalendar();
    const half = date ? outOfHoursWithin(date, events) : null;
    const next = date ? nextEvent(date, events) : null;
    // An empty or expired calendar is unknown, not "no event"
    const known = !!date && events.length > 0 && events[events.length - 1].date > date;
    out.event_half = known ? !!half : null;
    out.event_today_inhours = known ? !!inHoursOn(date!, events) : null;
    out.next_event = next ? `${next.event.event} ${next.event.date}` : null;
    out.next_event_days = next?.sessions ?? null;
    out.gate_finviz = out.finviz_base ?? null;
    out.gate_earnings5 = ctx.earnings5 == null ? null : !ctx.earnings5;
    for (const k of ["rr", "rr_level", "open_air", "countertrend", "gate_rr", "funnel_pass", "funnel_rank"] as const) out[k] = null;
    if (trig && sb.length) {
      const sbAtr = atrOf(sb);
      const rr = riskReward(sb, sb.map((b) => b.close), st, dir, trig.entry!, trig.stop!, sbAtr[st], zigzag(sb, LEVEL_SWING_K));
      const g = funnelGates({ dir, finvizBase: (out.finviz_base as boolean | null) ?? null, earnings5: ctx.earnings5 ?? null, rr: rr.rr, marketLong });
      out.rr = rr.rr;
      out.rr_level = rr.level;
      out.open_air = rr.openAir;
      out.countertrend = g.countertrend;
      out.gate_rr = rr.rr == null ? null : rr.rr >= (g.countertrend ? g.rrMin : RR_MIN);
      out.funnel_pass = g.pass;
    }

    // P3-0k aligned-trend keys. align_*: "long" (aligned for a long), "short" (aligned for a short),
    // "mixed", or null when not computable (sma200 + slope need ~205 bars).
    const L: LayerSeries = ctx.alignLayers ?? { industry: null, sector: null, market: [null, null, null] };
    const code = (a: Alignment | null | undefined) => (!a || !a.complete ? null : a.state === "aligned" ? "long" : a.state === "against" ? "short" : "mixed");
    const at = (m: ReadonlyMap<string, Alignment> | null) => (date && m ? m.get(date) : undefined);
    const sbCloses = sb.map((b) => b.close);
    out.align_stock = sb.length ? code(alignmentAt(sb, sbCloses, st, 1)) : null;
    out.align_industry = code(at(L.industry));
    out.align_sector = code(at(L.sector));
    const mkt = marketAlignment(L.market.map((m) => (at(m)?.complete ? at(m)!.state : null)));
    out.align_market = mkt == null ? null : mkt === "aligned" ? "long" : mkt === "against" ? "short" : "mixed";
    const halfP3k = out.event_half === true;
    const sizeFor = (d: 1 | -1) => {
      const l = layerStates(L, date ?? "", d);
      return date ? p3kSize([l.industry, l.sector, l.market], halfP3k) : null;
    };
    out.p3k_size_long = sizeFor(1);
    out.p3k_size_short = sizeFor(-1);
    out.optimal_entry = null;
    out.p3k_candidate = null;
    // The calendar trigger first, else the rolling one (P3-0k takes both)
    const cal = trig && trig.triggerType && P3K_TYPES.has(trig.triggerType) ? { d: trig.trigger as 1 | -1, entry: trig.entry!, stop: trig.stop! } : null;
    const rol = r && (r.trigger === 1 || r.trigger === -1) && r.entry != null && r.stop != null ? { d: r.trigger as 1 | -1, entry: r.entry, stop: r.stop } : null;
    const p = cal ?? rol;
    if (p && sb.length) {
      const sbAtr = atrOf(sb);
      const piv = zigzag(sb, LEVEL_SWING_K);
      const opt = optimalEntry(sb, sbCloses, st, p.d, p.entry, p.stop, sbAtr[st], piv);
      const rr = riskReward(sb, sbCloses, st, p.d, p.entry, p.stop, sbAtr[st], piv);
      out.optimal_entry = opt.optimal;
      out.p3k_candidate =
        out.finviz_base === true && alignmentAt(sb, sbCloses, st, p.d).state === "aligned" && ctx.earnings5 !== true && rr.rr != null && rr.rr >= RR_MIN && opt.optimal;
    }

    // P3-0l watchlist: entry readiness needs only an STP trigger (any calendar type, or rolling) in
    // the watch direction with R/R ≥ 3; no Finviz, alignment or opens gate. Size: the P3-0k layer
    // rule for that direction (the align_* keys above log the layer states).
    const w = ctx.watch;
    out.watch_sources = w?.watch_sources ?? null;
    out.watch_first_seen = w?.watch_first_seen ?? null;
    out.watch_direction = w?.watch_direction ?? null;
    out.watch_direction_source = w?.watch_direction ? "source" : null;
    out.watch_entry_ready = null;
    out.watch_size = null;
    if (w?.watch_sources && !w.directional) {
      // P3-0l2 (Chris): only directionless sources (social, Polymarket) → any STP trigger with R/R ≥ 3
      // counts, and its direction becomes the watch direction (flagged watch_direction_source = trigger)
      const cal = trig ? { d: trig.trigger as 1 | -1, entry: trig.entry!, stop: trig.stop! } : null;
      const rol = r && (r.trigger === 1 || r.trigger === -1) && r.entry != null && r.stop != null ? { d: r.trigger as 1 | -1, entry: r.entry, stop: r.stop } : null;
      const t = cal ?? rol;
      out.watch_entry_ready = false;
      if (t && sb.length) {
        const rr = riskReward(sb, sbCloses, st, t.d, t.entry, t.stop, atrOf(sb)[st], zigzag(sb, LEVEL_SWING_K));
        if (rr.rr != null && rr.rr >= RR_MIN) {
          out.watch_entry_ready = true;
          out.watch_direction = t.d === 1 ? "bullish" : "bearish";
          out.watch_direction_source = "trigger";
          out.watch_size = sizeFor(t.d);
        }
      }
    } else if (w?.watch_sources && w.watch_direction) {
      const wd: 1 | -1 = w.watch_direction === "bullish" ? 1 : -1;
      out.watch_size = sizeFor(wd);
      const calW = trig && trig.trigger === wd ? { entry: trig.entry!, stop: trig.stop! } : null;
      const rolW = r && r.trigger === wd && r.entry != null && r.stop != null ? { entry: r.entry, stop: r.stop } : null;
      const t = calW ?? rolW;
      out.watch_entry_ready = false;
      if (t && sb.length) {
        const rr = riskReward(sb, sbCloses, st, wd, t.entry, t.stop, atrOf(sb)[st], zigzag(sb, LEVEL_SWING_K));
        out.watch_entry_ready = rr.rr != null && rr.rr >= RR_MIN;
      }
    }
  }
  return out;
}

/**
 * P3-0j: rank today's passing candidates across the run's rows by R/R (ties: k = 2
 * rally_used, then symbol) and set funnel_rank; other rows keep null.
 */
export function applyFunnelRanks(rows: ReadonlyArray<{ symbol: string; features: Record<string, unknown> }>): number {
  const c = rows.filter((r) => r.features.funnel_pass === true && typeof r.features.rr === "number");
  const num = (v: unknown) => (typeof v === "number" ? v : Infinity);
  c.sort((a, b) => (b.features.rr as number) - (a.features.rr as number) || num(a.features.swing_k2_rally_used) - num(b.features.swing_k2_rally_used) || a.symbol.localeCompare(b.symbol));
  c.forEach((r, k) => (r.features.funnel_rank = k + 1));
  return c.length;
}
