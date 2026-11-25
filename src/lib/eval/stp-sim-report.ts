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
  return `| ${label} | ${m.trades} | ${pct(m.winRate)} | ${r2(m.expectancy)} | ${r2(m.medianR)} | ${r2(m.avgGrossR)} | ${r2(m.profitFactor)} | ${r2(m.avgHolding)} | ${r2(m.maxDrawdownR)} | ${m.controls} | ${r2(m.controlExpectancy)} | ${r2(m.edge)} |`;
}

const HEAD = [
  "| split | trades | win | net exp R | median R | gross exp R | profit factor | avg hold | max DD R | controls | control exp R | edge R |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
];

function countsLine(label: string, counts: SymbolCounts): string {
  const fillRate = counts.filled + counts.cancelled > 0 ? counts.filled / (counts.filled + counts.cancelled) : null;
  return (
    `${label}: setups ${counts.setups}: filled ${counts.filled}, cancelled (no D+1 fill) ${counts.cancelled}, skipped gap past stop or R ≤ 0 ${counts.skippedGap}, ` +
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
    `Exit ${meta.exit}: stop at the trigger's stop, target ${rule.targetR}R, time exit at the close of session ${rule.maxSessions} after the fill${rule.trailing ? ", STP trailing exits (mX, pmX, bar stop)" : ""}. ` +
      `Costs ${(COST_ROUND_TRIP * 100).toFixed(2)}% of price round trip, in R. Net R is primary. Control seed ${CONTROL_SEED}.`,
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
    `**Primary groups (${prim.length} comparisons): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT.** A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.`,
    "",
    "| group | verdict | held-out trades | held-out net exp R | held-out control exp R | folds passed | reason |",
    "|---|---|---|---|---|---|---|",
    ...prim.map((r) => `| ${r.group} | ${r.verdict} | ${r.heldOut.trades} | ${r2(r.heldOut.expectancy)} | ${r2(r.heldOut.controlExpectancy)} | ${r.foldsPassed} | ${cell(r.reason)} |`),
    "",
  ];
  for (const r of results) {
    out.push(`## ${r.group}${r.primary ? `: ${r.verdict}` : " (descriptive)"}`, "", ...HEAD, metricsRow("all", r.all), metricsRow("held out", r.heldOut));
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
  const cols = ["variant", "symbol", "trigger_date", "fill_date", "exit_date", "direction", "type", "fired_rules", "entry", "fill", "stop", "exit", "risk", "r_gross", "r_net", "exit_reason", "holding", "control_r_net", "htf_alignment", "regime", "quarter"];
  const rows = trades.map((t) =>
    [t.variant, t.symbol, t.scanId, t.fillDate, t.exitDate, t.dir === 1 ? "long" : "short", t.type, t.firedRules.join(" "), t.entry, t.fill, t.stop, t.exit, t.risk, t.grossR, t.netR, t.reason, t.holding, t.controlNetR, t.alignment, t.regime, t.quarter]
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
    `P3-0i STP TRIGGER TRADES, backfill dataset, exit ${meta.exit} (${meta.exit === "A" ? "primary" : "secondary"}): ${meta.trades} trades, ${prim.length} primary groups. ` +
    `${keep.length} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. All trades held out: net exp ${r2(all?.heldOut.expectancy ?? null)}R vs control ${r2(all?.heldOut.controlExpectancy ?? null)}R. ` +
    `Survivorship-biased (current members only). A KEEP leads to a Phase 4 paper-trading proposal, not a rule. Report: ${meta.reportPath}.`;
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${prim.length} | STP trade sim exit ${meta.exit} (prereg) | ${keep.length ? "keep" : "discard"} | ${cell(keep.map((r) => r.group).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
