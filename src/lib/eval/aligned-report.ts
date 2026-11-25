/**
 * P3-0k report output (pure): markdown, trades CSV and one experiment-log row.
 */
import { SURVIVORSHIP_NOTE } from "./report";
import { BASE_RISK_DOLLARS, CONTROL_SEED, groupMetrics, stoppedEarly, STOPPED_EARLY_SESSIONS, type GroupMetrics } from "./stp-sim";
import { controlSplitLines, outlierLines } from "./stp-sim-report";
import { funnelTradesCsv } from "./funnel-report";
import type { ComparisonResult, FunnelCounts, FunnelTrade } from "./funnel-sim";
import type { GateCounts, P3kCandidate } from "./aligned-sim";

const r2 = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
const row = (label: string, m: GroupMetrics) =>
  `| ${label} | ${m.trades} | ${r2(m.expectancy)} | ${r2(m.medianR)} | ${pct(m.winRate)} | ${pct(m.reached3RRate)} | ${m.controls} | ${r2(m.controlExpectancy)} |`;
const HEAD = ["| group | trades | net exp R | median R | win | reached 3R | controls | control exp R (after trigger) |", "|---|---|---|---|---|---|---|---|"];

export interface AlignedReportMeta {
  date: string;
  commit: string;
  symbols: number;
  sessions: number;
  gates: { long: GateCounts; short: GateCounts };
  counts: Record<string, FunnelCounts>;
  /** Candidates passing every P3-0k gate (for the layer-state counts). */
  passing: readonly P3kCandidate[];
  /** First session on which SPY's alignment is computable (sma200 + slope needs ~205 bars). */
  alignFrom: string | null;
}

export function alignedMarkdownReport(results: readonly ComparisonResult[], trades: readonly FunnelTrade[], meta: AlignedReportMeta): string {
  const pick = (p: string, a: string, f: (t: FunnelTrade) => boolean = () => true) => trades.filter((t) => t.population === p && t.arm === a && f(t));
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const g = meta.gates;
  const out: string[] = [
    `# P3-0k aligned-trend setups: backfill, exit B management, ${meta.date} (${meta.commit})`,
    "",
    SURVIVORSHIP_NOTE,
    "",
    "Candidate: Finviz base, the stock aligned in the trade's direction (close above the monthly, weekly, rolling-20 and rolling-5 opens, and close > sma10 > sma20 > sma50 > sma200 with all four rising over 5 sessions; shorts mirrored), no earnings within 5 sessions. " +
      "Entry: a calendar or rolling STP trigger (inside, U-turn, mech1, mech2), R/R ≥ 3 to the nearest level, and an optimal entry (the stop at most 0.5 ATR beyond the nearest support). " +
      `Size 1.0 when industry, sector and market are all aligned, halved per mixed or against layer, × 0.5 for an out-of-hours event, floor 0.25; risk $${BASE_RISK_DOLLARS} × size. Exit B plus the event and earnings rules. Control seed ${CONTROL_SEED}; controls after the trigger only.`,
    "",
    `${meta.symbols} symbols, ${meta.sessions} sessions. Alignment is computable from ${meta.alignFrom ?? "n/a"} (SPY; sma200 and its 5-session slope need about 205 bars, so earlier sessions are mixed and can't produce candidates). **A small sample is expected; INSUFFICIENT means wait for more data, not a rule change.**`,
    "",
    "**Candidates left after each gate:**",
    "",
    "| direction | STP triggers | Finviz base | stock aligned | no earnings ≤ 5 sessions | R/R ≥ 3 | optimal entry |",
    "|---|---|---|---|---|---|---|",
    `| long | ${g.long.triggers} | ${g.long.finviz} | ${g.long.aligned} | ${g.long.earnings} | ${g.long.rr} | ${g.long.optimal} |`,
    `| short | ${g.short.triggers} | ${g.short.finviz} | ${g.short.aligned} | ${g.short.earnings} | ${g.short.rr} | ${g.short.optimal} |`,
    "",
    "| population / arm | candidates | filled | not filled | skipped (position open) | size_skip | no control |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(meta.counts).map(([k, c]) => `| ${k} | ${c.candidates} | ${c.filled} | ${c.notFilled} | ${c.skippedOverlap} | ${c.sizeSkip} | ${c.noControl} |`),
    "",
    `**Pre-registered (${results.length} comparisons): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT.** A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.`,
    "",
    "| comparison | verdict | held-out trades | held-out net exp R | baseline held-out exp R | ±20 control held-out exp R (descriptive) | folds passed | reason |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.group} | ${r.verdict} | ${r.heldOut.trades} | ${r2(r.heldOut.expectancy)} | ${r2(r.kind === "control" ? r.heldOut.controlExpectancy : r.benchHeldOut?.expectancy)} | ${r.kind === "control" ? r2(r.heldOut.controlWindowExpectancy) : "n/a"} | ${r.foldsPassed} | ${cell(r.reason)} |`,
    ),
    "",
    "**Descriptive (all trades, no verdicts):**",
    "",
    ...HEAD,
  ];
  const p3k = pick("p3k", "stop");
  const desc: Array<[string, readonly FunnelTrade[]]> = [
    ["all STP trades (stop)", pick("p3k_all", "stop")],
    ["aligned + optimal (stop)", p3k],
    ["aligned + optimal (pullback, after the P3-0j3 sizing fix)", pick("p3k", "pullback")],
    ["aligned, without the optimal-entry gate (stop)", pick("p3k_noopt", "stop")],
    ["opens-only alignment + optimal (stop)", pick("p3k_opens", "stop")],
    ["MAs-only alignment + optimal (stop)", pick("p3k_mas", "stop")],
    ...[1, 0.5, 0.25].map((s): [string, FunnelTrade[]] => [`aligned + optimal, layer size ${s} (stop)`, p3k.filter((t) => t.p3kLayerSize === s)]),
    ["aligned + optimal, calendar trigger (stop)", p3k.filter((t) => t.setupVariant === "calendar")],
    ["aligned + optimal, rolling trigger (stop)", p3k.filter((t) => t.setupVariant === "rolling")],
  ];
  out.push(...desc.map(([l, ts]) => row(l, groupMetrics(ts))), "");
  out.push(...stoppedEarlyLines(trades));
  const states = ["aligned", "mixed", "against", null] as const;
  out.push("**Layer states of the candidates passing every gate:**", "", "| layer | aligned | mixed | against | no data |", "|---|---|---|---|---|");
  for (const layer of ["industry", "sector", "market"] as const)
    out.push(`| ${layer} | ${states.map((s) => meta.passing.filter((c) => c[layer] === s).length).join(" | ")} |`);
  out.push("", ...controlSplitLines(p3k), ...outlierLines(p3k));
  for (const r of results) {
    out.push(`## ${r.group}: ${r.verdict}`, "", ...HEAD, row("all", r.all), row("held out", r.heldOut));
    r.folds.forEach((f, i) => out.push(row(`fold ${i + 1}`, f)));
    out.push("");
  }
  return out.join("\n");
}

/**
 * P3-0k2 descriptive: share of trades stopped out at the initial stop within 3 sessions (fill
 * day = session 1), p3k vs p3k_all vs p3k_noopt, stop entry. Do support-based stops survive the
 * first days better?
 */
export function stoppedEarlyLines(trades: readonly FunnelTrade[]): string[] {
  const out = [
    `**Stopped out within ${STOPPED_EARLY_SESSIONS} sessions (initial stop or a gap through it; fill day = session 1; stop entry; descriptive):**`,
    "",
    "| population | trades | stopped within 3 sessions | share | net exp R of the rest |",
    "|---|---|---|---|---|",
  ];
  for (const [p, label] of [["p3k", "aligned + optimal entry"], ["p3k_all", "all STP trades"], ["p3k_noopt", "aligned, no optimal-entry gate"]] as const) {
    const ts = trades.filter((t) => t.population === p && t.arm === "stop");
    const early = ts.filter(stoppedEarly);
    out.push(`| ${label} (${p}) | ${ts.length} | ${early.length} | ${pct(ts.length ? early.length / ts.length : null)} | ${r2(groupMetrics(ts.filter((t) => !stoppedEarly(t))).expectancy)} |`);
  }
  return [...out, ""];
}

export const alignedTradesCsv = funnelTradesCsv;

export function alignedExperimentRow(results: readonly ComparisonResult[], meta: { number: number; date: string; commit: string; reportPath: string; trades: number }): string {
  const keep = results.filter((r) => r.verdict === "KEEP");
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  const desc =
    `P3-0k ALIGNED-TREND SETUPS, backfill, exit B + event and earnings rules: ${meta.trades} trades across populations, ${results.length} pre-registered comparisons. ` +
    `${keep.length} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. Survivorship-biased (current members only). Report: ${meta.reportPath}.`;
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${results.length} | Aligned-trend setups (prereg) | ${keep.length ? "keep" : "discard"} | ${cell(keep.map((r) => r.id).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
