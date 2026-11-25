/**
 * P3-0i report output (pure): markdown report, trades CSV and one experiment-log row
 * per exit rule.
 */
import { SURVIVORSHIP_NOTE } from "./report";
import { COST_ROUND_TRIP, CONTROL_SEED, EXIT_RULES, type ExitRule, type GroupMetrics, type GroupResult, type Overlap, type SymbolCounts, type Trade } from "./stp-sim";

const r2 = (v: number | null) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

function metricsRow(label: string, m: GroupMetrics): string {
  return `| ${label} | ${m.trades} | ${pct(m.winRate)} | ${pct(m.targetRate)} | ${r2(m.expectancy)} | ${r2(m.medianR)} | ${r2(m.avgGrossR)} | ${r2(m.profitFactor)} | ${r2(m.avgHolding)} | ${r2(m.maxDrawdownR)} | ${m.controls} | ${r2(m.controlExpectancy)} | ${r2(m.edge)} |`;
}

const HEAD = [
  "| split | trades | win | 3R hit | net exp R | median R | gross exp R | profit factor | avg hold | max DD R | controls | control exp R | edge R |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

function countsLine(label: string, counts: SymbolCounts): string {
  const fillRate = counts.filled + counts.cancelled > 0 ? counts.filled / (counts.filled + counts.cancelled) : null;
  return (
    `${label}: setups ${counts.setups}: filled ${counts.filled}, cancelled (no D+1 fill) ${counts.cancelled}, gap_skip (D+1 opened through the entry) ${counts.gapSkip}, ` +
    `skipped open past stop ${counts.skippedGap}, ` +
    `skipped while a position was open ${counts.skippedOverlap}, no D+1 bar ${counts.noBar}. Fill rate ${pct(fillRate)}. Trades without a matched control: ${counts.noControl}.`
  );
}

export function simMarkdownReport(
  results: readonly GroupResult[],
  counts: SymbolCounts,
  meta: { date: string; commit: string; exit: ExitRule; symbols: number; rollingCounts?: SymbolCounts; overlap?: Overlap },
): string {
  const rule = EXIT_RULES[meta.exit];
  const prim = results.filter((r) => r.primary);
  const n = (v: string) => prim.filter((r) => r.verdict === v).length;
  const out = [
    `# P3-0i STP trigger trades: backfill dataset, exit ${meta.exit}, ${meta.date} (${meta.commit})`,
    "",
    SURVIVORSHIP_NOTE,
    "",
    meta.exit === "B"
      ? "Exit B (primary, verdicts): STP management. Stop-limit entry (no fill on a gap through it); adds every 2R at 50% of the current size, stop to the " +
        "size-weighted breakeven after each; no target; trailing from the bar after 3R is touched (mech1/mech2: mX; others: bar stop while close is more " +
        `than 1 ATR from sma10, else pmX); 60-session cap. R = all units over the initial 1-unit R. Costs ${(COST_ROUND_TRIP * 100).toFixed(2)}% of notional per leg. Control seed ${CONTROL_SEED}.`
      : `Exit A (reference, no verdicts): stop, ${rule.targetR}R target as a limit (a gap through it exits at the open), time exit at session ${rule.maxSessions}. Costs ${(COST_ROUND_TRIP * 100).toFixed(2)}% round trip. Control seed ${CONTROL_SEED}.`,
    "",
    `${meta.symbols} symbols.`,
    "",
    countsLine("Calendar opens (computeStp)", counts),
    "",
    ...(meta.rollingCounts ? [countsLine("Rolling opens (inside and U-turn, 5/20 sessions)", meta.rollingCounts), ""] : []),
    ...(meta.overlap
      ? [
          `Overlap of the two trend definitions, inside and U-turn setups (same ticker, date, direction): both fire ${meta.overlap.both}, ` +
            `calendar only ${meta.overlap.calendarOnly}, rolling only ${meta.overlap.rollingOnly}.`,
          "",
        ]
      : []),
    meta.exit === "B"
      ? `**Primary groups (${prim.length} comparisons): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT.** A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.`
      : `**Reference exit: the ${prim.length} pre-registered groups are shown without verdicts.**`,
    "",
    ...(meta.exit === "B"
      ? [
          "Management (all trades in the group):",
          "",
          "| group | add rate | avg adds | max adds | add gap skips | reached 3R | BE exits | avg R reached 3R | avg R not | 60-session caps | initial-unit R |",
          "|---|---|---|---|---|---|---|---|---|---|---|",
          ...prim.map(
            (r) =>
              `| ${r.group} | ${pct(r.all.addRate)} | ${r2(r.all.avgAdds)} | ${r.all.maxAdds ?? "n/a"} | ${r.all.addGapSkips} | ${pct(r.all.reached3RRate)} | ${pct(r.all.beExitRate)} | ` +
              `${r2(r.all.avgRReached3R)} | ${r2(r.all.avgRNot3R)} | ${r.all.timeCaps} | ${r2(r.all.avgInitialUnitR)} |`,
          ),
          "",
        ]
      : []),
    "| group | verdict | held-out trades | held-out net exp R | held-out control exp R | folds passed | reason |",
    "|---|---|---|---|---|---|---|",
    ...prim.map((r) => `| ${r.group} | ${r.verdict} | ${r.heldOut.trades} | ${r2(r.heldOut.expectancy)} | ${r2(r.heldOut.controlExpectancy)} | ${r.foldsPassed} | ${cell(r.reason)} |`),
    "",
  ];
  for (const r of results) {
    out.push(`## ${r.group}${r.primary ? `: ${r.verdict ?? "reference"}` : " (descriptive)"}`, "", ...HEAD, metricsRow("all", r.all), metricsRow("held out", r.heldOut));
    r.folds.forEach((f, i) => out.push(metricsRow(`fold ${i + 1}`, f)));
    out.push("");
  }
  return out.join("\n");
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function tradesCsv(trades: readonly Trade[]): string {
  const cols = ["variant", "symbol", "trigger_date", "fill_date", "exit_date", "direction", "type", "fired_rules", "entry", "fill", "stop", "exit", "risk", "r_gross", "r_net", "exit_reason", "holding", "adds", "size_at_exit", "reached_3r", "initial_unit_r_net", "control_r_net", "htf_alignment", "week_used", "month_used", "room_w", "regime", "quarter"];
  const rows = trades.map((t) =>
    [t.variant, t.symbol, t.scanId, t.fillDate, t.exitDate, t.dir === 1 ? "long" : "short", t.type, t.firedRules.join(" "), t.entry, t.fill, t.stop, t.exit, t.risk, t.grossR, t.netR, t.reason, t.holding, t.adds, t.size, t.reached3R, t.initialUnitR, t.controlNetR, t.alignment, t.weekUsed, t.monthUsed, t.roomW, t.regime, t.quarter]
      .map(csvCell)
      .join(","),
  );
  return [cols.join(","), ...rows].join("\n") + "\n";
}

export function simExperimentRow(results: readonly GroupResult[], meta: { number: number; date: string; commit: string; exit: ExitRule; reportPath: string; trades: number }): string {
  const prim = results.filter((r) => r.primary);
  const keep = prim.filter((r) => r.verdict === "KEEP");
  const n = (v: string) => prim.filter((r) => r.verdict === v).length;
  const all = results.find((r) => r.group === "all");
  const desc =
    `P3-0i STP TRIGGER TRADES, backfill dataset, exit ${meta.exit} (${meta.exit === "B" ? "STP management, primary" : "fixed 3R, reference, no verdicts"}): ${meta.trades} trades, ${prim.length} primary groups. ` +
    `${keep.length} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. All trades held out: net exp ${r2(all?.heldOut.expectancy ?? null)}R vs control ${r2(all?.heldOut.controlExpectancy ?? null)}R. ` +
    `Survivorship-biased (current members only). A KEEP leads to a Phase 4 paper-trading proposal, not a rule. Report: ${meta.reportPath}.`;
  const status = meta.exit === "B" ? (keep.length ? "keep" : "discard") : "reference";
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${prim.length} | STP trade sim exit ${meta.exit} (prereg${meta.exit === "B" ? "" : ", reference"}) | ${status} | ${cell(keep.map((r) => r.group).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
