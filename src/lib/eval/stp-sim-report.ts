/**
 * P3-0i report output (pure): markdown report, trades CSV and one experiment-log row
 * per exit rule.
 */
import { SURVIVORSHIP_NOTE } from "./report";
import {
  BASE_RISK_DOLLARS, COST_ROUND_TRIP, CONTROL_SEED, EXIT_RULES, MAX_ADDS,
  type ExitRule, type GroupMetrics, type GroupResult, type Overlap, type PortfolioStats, type SymbolCounts, type Trade,
} from "./stp-sim";

/** §1f: the per-stock swing profile distribution across the universe, per k (medians of each stock's medians). */
export interface ProfileSummary {
  k: number;
  stocks: number;
  rallyAtr: number | null;
  pullbackAtr: number | null;
  rallyBars: number | null;
  pullbackBars: number | null;
}

const usd = (v: number | null) => (v == null ? "n/a" : "$" + v.toFixed(0));

const r2 = (v: number | null) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

function metricsRow(label: string, m: GroupMetrics): string {
  return `| ${label} | ${m.trades} | ${usd(m.dollarNet)} | ${r2(m.sizeWeightedR)} | ${pct(m.winRate)} | ${pct(m.targetRate)} | ${r2(m.expectancy)} | ${r2(m.medianR)} | ${r2(m.avgGrossR)} | ${r2(m.profitFactor)} | ${r2(m.avgHolding)} | ${r2(m.maxDrawdownR)} | ${m.controls} | ${r2(m.controlExpectancy)} | ${r2(m.edge)} |`;
}

const HEAD = [
  "| split | trades | net $ | size-wtd R | win | 3R hit | net exp R | median R | gross exp R | profit factor | avg hold | max DD R | controls | control exp R | edge R |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

/** P3-0i4: a trade beyond ±OUTLIER_R gets a WARNING line in the report. */
export const OUTLIER_R = 50;
/** P3-0i4: the report lists this many largest dollar losses and gains. */
export const OUTLIER_TOP = 5;

const outlierRow = (t: Trade) =>
  `| ${t.variant} | ${t.symbol} | ${t.scanId} | ${t.dir === 1 ? "long" : "short"} | ${t.type} | ${t.adds} | ${t.shares} | ${t.sharesAtExit} | ${usd(t.dollarNet)} | ${r2(t.netR)} | ${t.reason} |`;

/** P3-0i4: the 5 largest dollar losses and gains, plus a WARNING line per trade beyond ±50R. */
export function outlierLines(trades: readonly Trade[]): string[] {
  const byDollar = [...trades].sort((a, b) => a.dollarNet - b.dollarNet || a.symbol.localeCompare(b.symbol) || a.scanId.localeCompare(b.scanId));
  const losses = byDollar.filter((t) => t.dollarNet < 0).slice(0, OUTLIER_TOP);
  const gains = byDollar.filter((t) => t.dollarNet > 0).reverse().slice(0, OUTLIER_TOP);
  const head = ["| variant | symbol | trigger date | direction | type | adds | shares | shares at exit | net $ | net R | exit reason |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  const warn = trades
    .filter((t) => Math.abs(t.netR) > OUTLIER_R)
    .sort((a, b) => Math.abs(b.netR) - Math.abs(a.netR) || a.symbol.localeCompare(b.symbol))
    .map((t) => `WARNING: ${t.symbol} ${t.scanId} (${t.variant}, ${t.type}, ${t.dir === 1 ? "long" : "short"}) net ${r2(t.netR)}R (${usd(t.dollarNet)}), beyond ±${OUTLIER_R}R; ${t.adds} adds, ${t.sharesAtExit} shares at exit.`);
  return [
    `**Outliers (P3-0i4):** ${warn.length} trade(s) beyond ±${OUTLIER_R}R.`,
    "",
    ...(warn.length ? [...warn, ""] : []),
    `Largest ${OUTLIER_TOP} dollar losses:`,
    "",
    ...(losses.length ? [...head, ...losses.map(outlierRow)] : ["none"]),
    "",
    `Largest ${OUTLIER_TOP} dollar gains:`,
    "",
    ...(gains.length ? [...head, ...gains.map(outlierRow)] : ["none"]),
    "",
  ];
}

const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/**
 * P3-0j2 descriptive: matched-control expectancy split by whether the control day fell
 * before or after the trigger, per pattern. EGOP controls are drawn after the gap only.
 */
export function controlSplitLines(trades: readonly Trade[]): string[] {
  const types = [...new Set(trades.map((t) => t.type))].sort();
  const rows = types.map((type) => {
    const ts = trades.filter((t) => t.type === type && t.controlNetR != null);
    const pre = ts.filter((t) => t.controlPost === false).map((t) => t.controlNetR!);
    const post = ts.filter((t) => t.controlPost === true).map((t) => t.controlNetR!);
    return `| ${type} | ${pre.length} | ${r2(meanOf(pre))} | ${post.length} | ${r2(meanOf(post))} |`;
  });
  return [
    "**Matched controls before vs after the trigger (descriptive; EGOP controls only after the gap day, P3-0j2):**",
    "",
    "| pattern | controls before | control exp R before | controls after | control exp R after |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ];
}

function countsLine(label: string, counts: SymbolCounts): string {
  const fillRate = counts.filled + counts.cancelled > 0 ? counts.filled / (counts.filled + counts.cancelled) : null;
  return (
    `${label}: setups ${counts.setups}: filled ${counts.filled}, cancelled (no D+1 fill) ${counts.cancelled}, gap_skip (D+1 opened through the entry) ${counts.gapSkip}, ` +
    `skipped open past stop ${counts.skippedGap}, ` +
    `skipped while a position was open ${counts.skippedOverlap}, size_skip (0 shares at ${usd(BASE_RISK_DOLLARS)} × size_mult) ${counts.sizeSkip}, ` +
    `no D+1 bar ${counts.noBar}, market/sector layer without data (treated as mixed) ${counts.layerNull}. Fill rate ${pct(fillRate)}. Trades without a matched control: ${counts.noControl}.`
  );
}

export function simMarkdownReport(
  results: readonly GroupResult[],
  counts: SymbolCounts,
  meta: {
    date: string;
    commit: string;
    exit: ExitRule;
    symbols: number;
    rollingCounts?: SymbolCounts;
    overlap?: Overlap;
    portfolio?: { calendar: PortfolioStats; rolling: PortfolioStats };
    sizeSkipByType?: Record<string, number>;
    profiles?: readonly ProfileSummary[];
    /** §1g coverage: calendar trades whose stock has a stored sector. */
    sectorProfiles?: { tradesWith: number; trades: number };
    /** §1i caveat: ATR > $1.50 favours high-priced stocks. */
    finvizPrice?: { base: number | null; all: number | null };
    /** P3-0i3: symbols with EDGAR earnings sessions (EGOP needs them). */
    earnings?: { withDates: number; symbols: number };
    /** P3-0i4: this exit's trades, for the outlier lines. */
    trades?: readonly Trade[];
  },
): string {
  const rule = EXIT_RULES[meta.exit];
  const prim = results.filter((r) => r.primary);
  const n = (v: string) => prim.filter((r) => r.verdict === v).length;
  const out = [
    `# P3-0i STP trigger trades: backfill dataset, exit ${meta.exit}, ${meta.date} (${meta.commit})`,
    "",
    SURVIVORSHIP_NOTE,
    "",
    meta.exit !== "A"
      ? `Exit ${meta.exit} (${meta.exit === "B" ? "primary, verdicts" : "the §1j choppy variant, descriptive, no verdicts"}): STP management. Stop-limit entry (no fill on a gap through it); ` +
        `adds every ${meta.exit === "B" ? 2 : 1} × ATR14 of the trigger bar, never on the entry day, each floor(50%) of the current shares, at most ${MAX_ADDS} adds, stop to the ` +
        `size-weighted breakeven after each; no target; trailing from the bar after ${meta.exit === "B" ? 3 : 2}R is touched (mech1/mech2: mX; others: bar stop while close is more ` +
        `than 1 ATR from sma10, else pmX; per-bar fudge); 60-session cap. Size = stock factor × pyramid, floored at 0.25; risk ${usd(BASE_RISK_DOLLARS)} × size. ` +
        `R = dollar P&L over the base risk. Costs ${(COST_ROUND_TRIP * 100).toFixed(2)}% of each leg's value. Control seed ${CONTROL_SEED}.`
      : `Exit A (reference, no verdicts): stop, ${rule.targetR}R target as a limit (a gap through it exits at the open), time exit at session ${rule.maxSessions}. Costs ${(COST_ROUND_TRIP * 100).toFixed(2)}% round trip. Control seed ${CONTROL_SEED}.`,
    "",
    `${meta.symbols} symbols.` +
      (meta.sectorProfiles ? ` Calendar trades with a stored sector (§1g): ${meta.sectorProfiles.tradesWith} of ${meta.sectorProfiles.trades}.` : "") +
      (meta.earnings
        ? ` EDGAR earnings dates (8-K item 2.02, P3-0i3) for ${meta.earnings.withDates} of ${meta.earnings.symbols} symbols (${pct(meta.earnings.symbols ? meta.earnings.withDates / meta.earnings.symbols : null)}); EGOP can only fire on those, the rest (mostly foreign filers) are left without dates.`
        : "") +
      " The stock factor (§1j) uses the calendar stp_htf_opens for every trade, rolling-trigger trades included, as specified." +
      (meta.finvizPrice ? ` Median fill price: Finviz base-filter trades ${usd(meta.finvizPrice.base)} vs all trades ${usd(meta.finvizPrice.all)} (ATR > $1.50 favours higher-priced stocks).` : ""),
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
    ...(meta.portfolio
      ? [
          `**Account view (§1h, ${usd(BASE_RISK_DOLLARS)} × size_mult risk per position, no cap applied):**`,
          "",
          "| population | trades | net $ | max DD $ | trades per session | peak open positions | peak open risk $ | on |",
          "|---|---|---|---|---|---|---|---|",
          ...(["calendar", "rolling"] as const).map((v) => {
            const p = meta.portfolio![v];
            return `| ${v} | ${p.trades} | ${usd(p.dollarNet)} | ${usd(p.maxDrawdownDollar)} | ${r2(p.tradesPerSession)} | ${p.peakOpenPositions} | ${usd(p.peakOpenRisk)} | ${p.peakDate ?? "n/a"} |`;
          }),
          "",
        ]
      : []),
    ...(meta.trades ? outlierLines(meta.trades) : []),
    ...(meta.trades ? controlSplitLines(meta.trades.filter((t) => t.variant === "calendar")) : []),
    ...(meta.sizeSkipByType && Object.keys(meta.sizeSkipByType).length
      ? [`size_skip by pattern (calendar): ${Object.entries(meta.sizeSkipByType).map(([t, c]) => `${t} ${c}`).join(", ")}.`, ""]
      : []),
    ...(meta.profiles
      ? [
          "**Swing profiles across the universe (§1f; median of each stock's median leg at the last bar):**",
          "",
          "| k | stocks | rally (ATR) | pullback (ATR) | rally bars | pullback bars |",
          "|---|---|---|---|---|---|",
          ...meta.profiles.map((p) => `| ${p.k} | ${p.stocks} | ${r2(p.rallyAtr)} | ${r2(p.pullbackAtr)} | ${r2(p.rallyBars)} | ${r2(p.pullbackBars)} |`),
          "",
        ]
      : []),
    `Sizing (§1j): stock factor 1 on ${results.find((r) => r.group === "size:stock:1")?.all.trades ?? 0} calendar trades, 0.5 on ${results.find((r) => r.group === "size:stock:0.5")?.all.trades ?? 0}; ` +
      `the 0.25 floor applied to ${results.find((r) => r.group === "size:floorHit")?.all.trades ?? 0}; ` +
      `the old Pine abs() rule would have given full size where the fixed rule gives half on ${results.find((r) => r.group === "size:absFullFixedHalf")?.all.trades ?? 0}.`,
    "",
    meta.exit === "B"
      ? `**Primary groups (${prim.length} comparisons): ${n("KEEP")} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT, ${n("NOT_RUN")} NOT_RUN.** A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.`
      : `**${meta.exit === "A" ? "Reference" : "Descriptive"} exit: the ${prim.length} pre-registered groups are shown without verdicts.**${meta.exit === "C" ? " See the market:agree / market:notAgree groups for the choppy split." : ""}`,
    "",
    ...(meta.exit !== "A"
      ? [
          "Management (all trades in the group):",
          "",
          `| group | add rate | avg adds | max adds | add cap (${MAX_ADDS}) reached | add gap skips | reached 3R | BE exits | avg R reached 3R | avg R not | 60-session caps | initial-unit R |`,
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
          ...prim.map(
            (r) =>
              `| ${r.group} | ${pct(r.all.addRate)} | ${r2(r.all.avgAdds)} | ${r.all.maxAdds ?? "n/a"} | ${r.all.addCapReached} | ${r.all.addGapSkips} | ${pct(r.all.reached3RRate)} | ${pct(r.all.beExitRate)} | ` +
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
  const cols = ["variant", "symbol", "trigger_date", "fill_date", "exit_date", "direction", "type", "fired_rules", "entry", "fill", "stop", "exit", "risk", "r_gross", "r_net", "exit_reason", "holding", "adds", "add_cap_reached", "size_at_exit", "shares", "shares_at_exit", "base_risk", "dollar_net", "size_mult", "stock_factor", "size_combined", "floor_hit", "abs_full_fixed_half",
    "layer_market", "layer_sector", "layer_industry", "size_mult_industry", "size_mult_opens", "size_mult_trend",
    "finviz_base", "finviz_screens", "k1.5_rally_used", "k1.5_room_3r", "k2_rally_used", "k2_room_3r", "k3_rally_used", "k3_room_3r", "reached_3r", "initial_unit_r_net", "control_r_net", "htf_alignment", "week_used", "month_used", "room_w", "regime", "quarter"];
  const rows = trades.map((t) =>
    [t.variant, t.symbol, t.scanId, t.fillDate, t.exitDate, t.dir === 1 ? "long" : "short", t.type, t.firedRules.join(" "), t.entry, t.fill, t.stop, t.exit, t.risk, t.grossR, t.netR, t.reason, t.holding, t.adds, t.addCapReached, t.size, t.shares, t.sharesAtExit, t.baseRisk, t.dollarNet, t.sizeMult, t.stockFactor, t.sizeCombined, t.floorHit, t.absFullFixedHalf,
      t.layerMarket, t.layerSector, t.layerIndustry, t.sizeMultIndustry, t.sizeMultOpens, t.sizeMultTrend,
      t.finvizBase, t.finvizScreens.join(" "), t.swing["1.5"]?.rallyUsed, t.swing["1.5"]?.room3R, t.swing["2"]?.rallyUsed, t.swing["2"]?.room3R, t.swing["3"]?.rallyUsed, t.swing["3"]?.room3R, t.reached3R, t.initialUnitR, t.controlNetR, t.alignment, t.weekUsed, t.monthUsed, t.roomW, t.regime, t.quarter]
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
    `P3-0i STP TRIGGER TRADES, backfill dataset, exit ${meta.exit} (${meta.exit === "B" ? "STP management, primary" : meta.exit === "A" ? "fixed 3R, reference, no verdicts" : "choppy variant (1 x ATR adds, trail from 2R), descriptive"}): ${meta.trades} trades, ${prim.length} primary groups. ` +
    `${keep.length} KEEP, ${n("DROP")} DROP, ${n("INSUFFICIENT")} INSUFFICIENT. All trades held out: net exp ${r2(all?.heldOut.expectancy ?? null)}R vs control ${r2(all?.heldOut.controlExpectancy ?? null)}R. ` +
    `Survivorship-biased (current members only). A KEEP leads to a Phase 4 paper-trading proposal, not a rule. Report: ${meta.reportPath}.`;
  const status = meta.exit === "B" ? (keep.length ? "keep" : "discard") : meta.exit === "A" ? "reference" : "descriptive";
  return `| ${meta.number} | ${meta.date} | ${meta.commit} | n/a | n/a | n/a | ${prim.length} | STP trade sim exit ${meta.exit} (prereg${meta.exit === "B" ? "" : ", reference"}) | ${status} | ${cell(keep.map((r) => r.group).join(" ") || "none")} | n/a | n/a | n/a | ${cell(desc)} |`;
}
