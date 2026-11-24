/**
 * Harvest health report, docs/PHASE3-PREP.md P3-0a (pure). Checks that each log-only
 * feature family is actually being written before Phase 3 depends on it. A report,
 * not a gate: it never changes data.
 *
 * Feature families are derived from the code that writes them (the builders return
 * every key even for empty input), so this list can't drift from the harvester.
 * Conditional families (options, Alpaca, politicians, Reddit, insiders) exist only for
 * tickers with that kind of signal: their null rates are measured over the tickers
 * that have the family, and their coverage is reported separately.
 */
import { computeBarFeatures } from "@/lib/harvester/universe/bar-features";
import { computeEarningsFeatures } from "@/lib/harvester/earnings-features";
import { tickerSectorFeatures } from "@/lib/harvester/universe/sector-rotation";

export const NULL_JUMP_POINTS = 30;
/** [Guessing] per docs/PHASE3-PREP.md; the report prints the real number. */
export const UNIVERSE_RANGE = { min: 300, max: 1_500 } as const;

const BAR_KEYS = new Set(Object.keys(computeBarFeatures([])).filter((k) => !k.startsWith("stp_")));
const EARNINGS_KEYS = new Set(Object.keys(computeEarningsFeatures(null, new Date(0), false)));
const SECTOR_KEYS = new Set(Object.keys(tickerSectorFeatures(null, null, null, null, null)));

export const TICKER_FAMILIES = ["bar", "stp", "earnings", "sector", "opt", "alp", "politician", "reddit", "insider", "shadow_ai"] as const;
export type TickerFamily = (typeof TICKER_FAMILIES)[number];
/** Families written only for some tickers. */
export const CONDITIONAL_FAMILIES: ReadonlySet<TickerFamily> = new Set(["opt", "alp", "politician", "reddit", "insider"]);

export function familyOf(key: string): TickerFamily | null {
  if (key.startsWith("stp_")) return "stp";
  if (BAR_KEYS.has(key)) return "bar";
  if (EARNINGS_KEYS.has(key)) return "earnings";
  if (SECTOR_KEYS.has(key)) return "sector";
  for (const p of ["opt", "alp", "politician", "reddit", "insider", "shadow_ai"] as const) if (key.startsWith(`${p}_`)) return p;
  return null;
}

export interface ScanInput {
  scanId: string;
  startedAt: Date;
  universeSize: number | null;
  regimeFeatures: Record<string, unknown> | null;
  sectorRotation: Record<string, unknown> | null;
  stpRows: number;
  tickers: Array<Record<string, unknown> | null>; // ValidatedTicker.features per ticker
  /** P3-0c UniverseSnapshot features for this scan (loaded for the latest scan only). */
  snapshot?: Array<Record<string, unknown> | null>;
}

export interface KeyStats {
  nullRate: number; // 0-1, over rows that have the family
  min: number | null;
  median: number | null;
  max: number | null;
}

export interface FamilyStats {
  rowsWithFamily: number;
  coverage: number; // rows with the family / all tickers
  keys: Record<string, KeyStats>;
}

export interface ScanReport {
  scanId: string;
  startedAt: string;
  tickers: number;
  universeSize: number | null;
  scanLevel: { regime: boolean; sectorRotation: boolean; stpRows: number };
  families: Record<TickerFamily, FamilyStats>;
  /** P3-0c: snapshot row count and per-family stats, when loaded. */
  snapshot?: { rows: number; families: Record<TickerFamily, FamilyStats> };
}

const isNull = (v: unknown) => v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function familyStats(rowsIn: ReadonlyArray<Record<string, unknown> | null>): Record<TickerFamily, FamilyStats> {
  return analyzeScan({ scanId: "", startedAt: new Date(0), universeSize: null, regimeFeatures: null, sectorRotation: null, stpRows: 0, tickers: [...rowsIn] }).families;
}

export function analyzeScan(scan: ScanInput): ScanReport {
  const families = Object.fromEntries(TICKER_FAMILIES.map((f) => [f, { rowsWithFamily: 0, coverage: 0, keys: {} }])) as Record<TickerFamily, FamilyStats>;
  const values: Record<string, unknown[]> = {};
  const keyFamily: Record<string, TickerFamily> = {};
  const rows = scan.tickers.map((t) => t ?? {});
  for (const row of rows) {
    const present = new Set<TickerFamily>();
    for (const [k, v] of Object.entries(row)) {
      const f = familyOf(k);
      if (!f) continue;
      present.add(f);
      keyFamily[k] = f;
      (values[k] ??= []).push(v);
    }
    for (const f of present) families[f].rowsWithFamily++;
  }
  for (const [k, vs] of Object.entries(values)) {
    const f = keyFamily[k];
    const denom = families[f].rowsWithFamily;
    const nonNull = vs.filter((v) => !isNull(v));
    const nums = nonNull.filter((v): v is number => typeof v === "number");
    families[f].keys[k] = {
      nullRate: denom ? (denom - nonNull.length) / denom : 1,
      min: nums.length ? Math.min(...nums) : null,
      median: median(nums),
      max: nums.length ? Math.max(...nums) : null,
    };
  }
  for (const f of TICKER_FAMILIES) families[f].coverage = rows.length ? families[f].rowsWithFamily / rows.length : 0;
  return {
    scanId: scan.scanId,
    startedAt: scan.startedAt.toISOString(),
    tickers: rows.length,
    universeSize: scan.universeSize,
    scanLevel: {
      regime: !!scan.regimeFeatures && Object.keys(scan.regimeFeatures).length > 0,
      sectorRotation: !!scan.sectorRotation && Object.keys(scan.sectorRotation).length > 0,
      stpRows: scan.stpRows,
    },
    families,
    ...(scan.snapshot ? { snapshot: { rows: scan.snapshot.length, families: familyStats(scan.snapshot) } } : {}),
  };
}

export interface Flag {
  level: "warn" | "info";
  message: string;
}

/** Flags for the latest scan (reports[0], newest first) against the earlier ones. */
export function flagsFor(reports: readonly ScanReport[]): Flag[] {
  const [latest, ...previous] = reports;
  if (!latest) return [{ level: "warn", message: "no completed scans found" }];
  const flags: Flag[] = [];
  if (latest.tickers === 0) flags.push({ level: "warn", message: "latest scan has no tickers" });
  if (latest.universeSize == null) flags.push({ level: "warn", message: "latest scan has no universe (static fallback list)" });
  else if (latest.universeSize < UNIVERSE_RANGE.min || latest.universeSize > UNIVERSE_RANGE.max)
    flags.push({ level: "warn", message: `universe size ${latest.universeSize} outside ${UNIVERSE_RANGE.min}-${UNIVERSE_RANGE.max}` });
  if (!latest.scanLevel.regime) flags.push({ level: "warn", message: "family regime missing (Scan.regimeFeatures empty)" });
  if (!latest.scanLevel.sectorRotation) flags.push({ level: "warn", message: "family sectorRotation missing (Scan.sectorRotation empty)" });
  if (latest.scanLevel.stpRows === 0) flags.push({ level: "warn", message: "family stp missing (no StpSignal rows)" });
  if (latest.snapshot) {
    if (latest.snapshot.rows === 0) flags.push({ level: "warn", message: "universe snapshot missing (no UniverseSnapshot rows for the latest scan)" });
    else if (latest.universeSize != null && latest.snapshot.rows < latest.universeSize * 0.9)
      flags.push({ level: "warn", message: `universe snapshot has ${latest.snapshot.rows} rows for a universe of ${latest.universeSize} (under 90%)` });
    for (const f of ["bar", "stp"] as const)
      for (const [k, st] of Object.entries(latest.snapshot.families[f].keys))
        if (st.nullRate >= 1) flags.push({ level: "warn", message: `snapshot ${f}.${k} is 100% null in the latest scan` });
  }
  for (const f of TICKER_FAMILIES) {
    const fam = latest.families[f];
    if (fam.rowsWithFamily === 0) {
      const conditional = CONDITIONAL_FAMILIES.has(f);
      flags.push({
        level: conditional ? "info" : "warn",
        message: `family ${f} missing entirely${conditional ? " (conditional: legitimate if no ticker had that kind of signal)" : ""}`,
      });
      continue;
    }
    for (const [k, s] of Object.entries(fam.keys)) {
      if (s.nullRate >= 1) flags.push({ level: "warn", message: `${f}.${k} is 100% null in the latest scan` });
      const prev = previous.map((r) => r.families[f].keys[k]?.nullRate).filter((v): v is number => v != null);
      const base = median(prev);
      if (base != null && (s.nullRate - base) * 100 > NULL_JUMP_POINTS)
        flags.push({ level: "warn", message: `${f}.${k} null rate ${(s.nullRate * 100).toFixed(0)}% vs median ${(base * 100).toFixed(0)}% (+${((s.nullRate - base) * 100).toFixed(0)} pts)` });
    }
  }
  return flags;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const fmt = (v: number | null) => (v == null ? "-" : Math.abs(v) >= 1000 ? v.toExponential(2) : Number(v.toPrecision(4)).toString());

export function renderText(reports: readonly ScanReport[], flags: readonly Flag[]): string {
  const latest = reports[0];
  const out: string[] = [];
  if (!latest) return "No completed scans.";
  out.push(`Harvest health: latest scan ${latest.scanId} at ${latest.startedAt}, ${latest.tickers} tickers, universe ${latest.universeSize ?? "none"}`);
  out.push(`Scan-level: regime ${latest.scanLevel.regime ? "ok" : "MISSING"}, sectorRotation ${latest.scanLevel.sectorRotation ? "ok" : "MISSING"}, STP rows ${latest.scanLevel.stpRows}`);
  out.push(`Previous scans compared: ${reports.length - 1}`, "");
  for (const f of TICKER_FAMILIES) {
    const fam = latest.families[f];
    out.push(`[${f}] coverage ${pct(fam.coverage)} (${fam.rowsWithFamily}/${latest.tickers})`);
    for (const [k, s] of Object.entries(fam.keys).sort(([a], [b]) => a.localeCompare(b)))
      out.push(`  ${k.padEnd(34)} null ${pct(s.nullRate).padStart(4)}  min ${fmt(s.min)}  med ${fmt(s.median)}  max ${fmt(s.max)}`);
  }
  if (latest.snapshot) {
    const sn = latest.snapshot;
    out.push("", `[universe snapshot] ${sn.rows} rows; coverage bar ${pct(sn.families.bar.coverage)}, stp ${pct(sn.families.stp.coverage)}, sector ${pct(sn.families.sector.coverage)}`);
    for (const f of ["bar", "stp", "sector"] as const)
      for (const [k, st] of Object.entries(sn.families[f].keys).sort(([a], [b]) => a.localeCompare(b)))
        out.push(`  ${k.padEnd(34)} null ${pct(st.nullRate).padStart(4)}  min ${fmt(st.min)}  med ${fmt(st.median)}  max ${fmt(st.max)}`);
  }
  out.push("", flags.length ? "Flags:" : "Flags: none");
  for (const fl of flags) out.push(`  ${fl.level.toUpperCase()} ${fl.message}`);
  return out.join("\n");
}

/** One-line coverage summary for the ingest log (processSignals). */
export function featureCoverageLine(features: Array<Record<string, unknown> | null | undefined>): string {
  const r = analyzeScan({ scanId: "", startedAt: new Date(0), universeSize: null, regimeFeatures: null, sectorRotation: null, stpRows: 0, tickers: features.map((f) => f ?? null) });
  return `[features] ${r.tickers} tickers; coverage ${TICKER_FAMILIES.map((f) => `${f} ${pct(r.families[f].coverage)}`).join(", ")}`;
}
