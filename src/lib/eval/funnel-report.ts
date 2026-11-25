/**
 * P3-0j report output (pure): markdown, trades CSV and one experiment-log row.
 */
import { SURVIVORSHIP_NOTE } from "./report";
import { BASE_RISK_DOLLARS, CONTROL_SEED, groupMetrics, portfolioStats, type GroupMetrics } from "./stp-sim";
import { controlSplitLines, outlierLines } from "./stp-sim-report";
import { FUNNEL_TOP, RR_MIN, RR_MIN_COUNTERTREND } from "./funnel";
import type { ComparisonResult, FunnelCounts, FunnelTrade, Population } from "./funnel-sim";
import type { EntryArm } from "./funnel";

const r2 = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null) => (v == null ? "n/a" : "$" + v.toFixed(0));
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

const row = (label: string, m: GroupMetrics) =>
  `| ${label} | ${m.trades} | ${usd(m.dollarNet)} | ${pct(m.winRate)} | ${r2(m.expectancy)} | ${r2(m.medianR)} | ${r2(m.profitFactor)} | ${r2(m.avgHolding)} | ${m.controls} | ${r2(m.controlExpectancy)} | ${r2(m.edge)} |`;
const HEAD = ["| group | trades | net $ | win | net exp R | median R | profit factor | avg hold | controls | control exp R | edge R |", "|---|---|---|---|---|---|---|---|---|---|---|"];

export interface FunnelReportMeta {
  date: string;
  commit: string;
  symbols: number;
  sessions: number;
  candidates: number;
  passing: number;
  counts: Record<string, FunnelCounts>;
  earningsSymbols: number;
  calendarEvents: number;
  calendarLine: string;
}

export function funnelMarkdownReport(results: readonly ComparisonResult[], trades: readonly FunnelTrade[], meta: FunnelReportMeta): string {
  const pick = (p: Population, a: EntryArm, f: (t: FunnelTrade) => boolean = () => true) => trades.filter((t) => t.population === p && t.arm === a && f(t));
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const top5 = pick("top5", "stop");
  const out: string[] = [
    `# P3-0j stock selection funnel: backfill, exit B management, ${meta.date} (${meta.commit})`,
    "",
    SURVIVORSHIP_NOTE,
    "",
    `Funnel: Finviz base (avg vol > 2M, ATR > $1.50) → no own earnings within 5 sessions → calendar STP trigger → R/R ≥ ${RR_MIN} (counter-trend short ≥ ${RR_MIN_COUNTERTREND}) to the nearest level → rank by R/R (ties: k = 2 rally_used) → top ${FUNNEL_TOP} per day. ` +
      `Exit B (adds every 2 × ATR, max 3, breakeven, trail after 3R) plus the event stop rule and the earnings rule; size = stock × pyramid × 0.5 with an out-of-hours event within 5 sessions, floored at 0.25; risk ${usd(BASE_RISK_DOLLARS)} × size. Control seed ${CONTROL_SEED}.`,
    "",
    `${meta.symbols} symbols, ${meta.sessions} sessions. ${meta.candidates} calendar triggers, ${meta.passing} pass the gates. EDGAR earnings dates for ${meta.earningsSymbols} of ${meta.symbols} symbols (the rest aren't blocked by the earnings gate and can't use the earnings rule). ${meta.calendarLine}`,
    "",
    "| population / arm | candidates | filled | not filled | skipped (position open) | size_skip | no control |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(meta.counts).map(([k, c]) => `| ${k} | ${c.candidates} | ${c.filled} | ${c.notFilled} | ${c.skippedOverlap} | ${c.sizeSkip} | ${c.noControl} |`),
    "",
    `**Pre-registered (${results.length} comparisons): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT.** Pullback-entry KEEPs are provisional until confirmed on ≥ 6 months of live data. A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.`,
    "",
    "| comparison | verdict | held-out trades | held-out net exp R | baseline held-out exp R | ±20 control held-out exp R (descriptive) | folds passed | reason |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.group} | ${r.verdict}${r.provisional && r.verdict === "KEEP" ? " (provisional)" : ""} | ${r.heldOut.trades} | ${r2(r.heldOut.expectancy)} | ${r2(r.kind === "control" ? r.heldOut.controlExpectancy : r.benchHeldOut?.expectancy)} | ${r.kind === "control" ? r2(r.heldOut.controlWindowExpectancy) : "n/a"} | ${r.foldsPassed} | ${cell(r.reason)} |`,
    ),
    "",
    "**Descriptive (all trades in each group, no verdicts):**",
    "",
    ...HEAD,
  ];
  const desc: Array<[string, readonly FunnelTrade[]]> = [];
  for (const a of ["stop", "pullback"] as const)
    for (const p of ["all", "funnel", "top5", "top3"] as const) desc.push([`${p} / ${a}`, pick(p, a)]);
  desc.push(["top5 / pullback_low (limit at low + fudge)", pick("top5", "pullback_low")]);
  desc.push(["top5_noair / stop (ranking without open_air, P3-0j3)", pick("top5_noair", "stop")]);
  desc.push(["top5 / stop: event-halved", top5.filter((t) => t.eventHalf)], ["top5 / stop: not halved", top5.filter((t) => !t.eventHalf)]);
  desc.push(["top5 / stop: open_air", top5.filter((t) => t.openAir)], ["top5 / stop: level within 10 ATR", top5.filter((t) => !t.openAir)]);
  desc.push(["top5 / stop: counter-trend shorts", top5.filter((t) => t.countertrend)]);
  for (const tier of ["event_bar", "event_be", "event_hold"] as const) desc.push([`top5 / stop: had ${tier}`, top5.filter((t) => t.eventTiers.includes(tier))]);
  desc.push(["top5 / stop: exited for earnings", top5.filter((t) => t.reason === "earnings")]);
  out.push(...desc.map(([l, ts]) => row(l, groupMetrics(ts))), "");

  const halved = top5.filter((t) => t.eventHalf).length;
  const ct = top5.filter((t) => t.countertrend);
  const sizes = [1, 0.5, 0.25].map((s) => `${s}: ${ct.filter((t) => t.sizeCombined === s).length}`).join(", ");
  const exitsOf = (tier: string) => {
    const by: Record<string, number> = {};
    for (const t of top5.filter((x) => x.eventTiers.includes(tier as never))) by[t.reason] = (by[t.reason] ?? 0) + 1;
    return Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  };
  out.push(
    `Event sizing: ${halved} of ${top5.length} top-5 stop-entry trades (${pct(top5.length ? halved / top5.length : null)}) were halved for an out-of-hours event within 5 sessions.`,
    `Counter-trend shorts (market agrees with long): ${ct.length}; size distribution ${sizes}.`,
    `Event stop tiers (top-5, stop entry), exits by tier: event_bar → ${exitsOf("event_bar")}; event_be → ${exitsOf("event_be")}; event_hold → ${exitsOf("event_hold")}.`,
    `Earnings look-ahead: ${top5.filter((t) => t.earningsSoon).length} top-5 trades had their next EDGAR earnings session < 10 sessions after entry (dates are usually announced 2–4 weeks ahead).`,
    "",
  );
  // P3-0j2: EDGAR earnings dates vs none (the earnings gate and exit rule can't act without dates)
  out.push(
    "**Top 5 by earnings-date coverage (descriptive):**",
    "",
    "| arm | earnings dates | trades | net exp R | reached 3R |",
    "|---|---|---|---|---|",
  );
  for (const a of ["stop", "pullback"] as const)
    for (const unknown of [false, true]) {
      const m = groupMetrics(pick("top5", a, (t) => t.earningsUnknown === unknown));
      out.push(`| ${a} | ${unknown ? "none (earnings_unknown)" : "EDGAR"} | ${m.trades} | ${r2(m.expectancy)} | ${pct(m.reached3RRate)} |`);
    }
  out.push("", ...controlSplitLines([...top5, ...pick("top5", "pullback")]));
  out.push(...eventCounterfactualLines(trades), ...rrDiagnosticLines(trades));
  const acct = (a: EntryArm) => portfolioStats(pick("top5", a), meta.sessions);
  out.push("**Account view (top 5 new per day, no position cap):**", "", "| arm | trades | net $ | max DD $ | peak open positions | peak open risk $ | on |", "|---|---|---|---|---|---|---|");
  for (const a of ["stop", "pullback"] as const) {
    const p = acct(a);
    out.push(`| ${a} | ${p.trades} | ${usd(p.dollarNet)} | ${usd(p.maxDrawdownDollar)} | ${p.peakOpenPositions} | ${usd(p.peakOpenRisk)} | ${p.peakDate ?? "n/a"} |`);
  }
  out.push("", ...outlierLines(top5));
  for (const r of results) {
    out.push(`## ${r.group}: ${r.verdict}`, "", ...HEAD, row("all", r.all), row("held out", r.heldOut));
    r.folds.forEach((f, i) => out.push(row(`fold ${i + 1}`, f)));
    out.push("");
  }
  return out.join("\n");
}

const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const medianOf = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * P3-0j3 descriptive: each top-5 trade rerun with the event stop rule off. Per tier (a trade
 * counts under every tier it had; "no event" = none), R with the rule, R without, difference.
 */
export function eventCounterfactualLines(trades: readonly FunnelTrade[]): string[] {
  const out = [
    "**Event stop rule counterfactual (top 5; each trade rerun with the rule off; descriptive, P3-0j3):**",
    "",
    "| arm | tier | trades | net exp R with the rule | without | difference |",
    "|---|---|---|---|---|---|",
  ];
  for (const a of ["stop", "pullback"] as const) {
    const ts = trades.filter((t) => t.population === "top5" && t.arm === a && t.netRNoEvent != null);
    const groups: Array<[string, FunnelTrade[]]> = [
      ...(["event_bar", "event_be", "event_hold"] as const).map((tier): [string, FunnelTrade[]] => [tier, ts.filter((t) => t.eventTiers.includes(tier))]),
      ["no event", ts.filter((t) => t.eventTiers.length === 0)],
      ["all", ts],
    ];
    for (const [tier, g] of groups) {
      const w = meanOf(g.map((t) => t.netR));
      const wo = meanOf(g.map((t) => t.netRNoEvent!));
      out.push(`| ${a} | ${tier} | ${g.length} | ${r2(w)} | ${r2(wo)} | ${r2(w != null && wo != null ? w - wo : null)} |`);
    }
  }
  return [...out, ""];
}

/** P3-0j3 descriptive: top-5 by R/R quintile and the stop distance in ATR, top-5 vs all (stop entry). */
export function rrDiagnosticLines(trades: readonly FunnelTrade[]): string[] {
  const top = trades.filter((t) => t.population === "top5" && t.arm === "stop" && t.rr != null).sort((a, b) => a.rr! - b.rr!);
  const all = trades.filter((t) => t.population === "all" && t.arm === "stop");
  const out = [
    "**R/R diagnostics (top 5, stop entry; descriptive, P3-0j3):**",
    "",
    `open_air: ${top.filter((t) => t.openAir).length} of ${top.length} top-5 trades. Median stop distance: top 5 ${r2(medianOf(top.map((t) => t.stopAtr).filter((v): v is number => v != null)))} ATR vs all trades ${r2(medianOf(all.map((t) => t.stopAtr).filter((v): v is number => v != null)))} ATR.`,
    "",
    "| R/R quintile | R/R range | trades | open_air | net exp R | reached 3R |",
    "|---|---|---|---|---|---|",
  ];
  for (let q = 0; q < 5; q++) {
    const g = top.slice(Math.floor((q * top.length) / 5), Math.floor(((q + 1) * top.length) / 5));
    const m = groupMetrics(g);
    out.push(`| Q${q + 1} | ${g.length ? `${g[0].rr!.toFixed(2)}–${g[g.length - 1].rr!.toFixed(2)}` : "n/a"} | ${g.length} | ${g.filter((t) => t.openAir).length} | ${r2(m.expectancy)} | ${pct(m.reached3RRate)} |`);
  }
  return [...out, ""];
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function funnelTradesCsv(trades: readonly FunnelTrade[]): string {
  const cols = ["population", "arm", "symbol", "trigger_date", "fill_date", "exit_date", "direction", "type", "rank", "rr", "rr_level", "open_air", "countertrend", "event_half", "event_tiers", "earnings_session", "earnings_soon", "earnings_unknown",
    "entry", "fill", "stop", "exit", "risk", "r_net", "exit_reason", "holding", "adds", "add_cap_reached", "size_combined", "base_risk", "shares", "shares_at_exit", "dollar_net", "layer_market", "layer_sector", "control_r_net"];
  const rows = trades.map((t) =>
    [t.population, t.arm, t.symbol, t.scanId, t.fillDate, t.exitDate, t.dir === 1 ? "long" : "short", t.type, t.rank, t.rr, t.rrLevel, t.openAir, t.countertrend, t.eventHalf, t.eventTiers.join(" "), t.earningsSession, t.earningsSoon, t.earningsUnknown,
      t.entry, t.fill, t.stop, t.exit, t.risk, t.netR, t.reason, t.holding, t.adds, t.addCapReached, t.sizeCombined, t.baseRisk, t.shares, t.sharesAtExit, t.dollarNet, t.layerMarket, t.layerSector, t.controlNetR]
      .map(csvCell)
      .join(","),
  );
  return [cols.join(","), ...rows].join("\n") + "\n";
}

export function funnelExperimentRow(results: readonly ComparisonResult[], meta: { number: number; date: string; commit: string; reportPath: string; trades: number }): string {
  const keep = results.filter((r) => r.verdict === "KEEP");
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const desc =
    `P3-0j SELECTION FUNNEL, backfill, exit B + event and earnings rules: ${meta.trades} trades across populations and arms, ${results.length} pre-registered comparisons. ` +
    `${keep.length} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. Pullback-entry KEEPs are provisional (proposed after P3-0i). Survivorship-biased (current members only). Report: ${meta.reportPath}.`;
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${results.length} | STP selection funnel (prereg) | ${keep.length ? "keep" : "discard"} | ${cell(keep.map((r) => r.id).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
