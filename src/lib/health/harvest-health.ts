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

/** P3-0e: crypto rows carry the SPY-comparison bar keys under BTC names. */
const CRYPTO_BAR_KEYS = new Set(["btc_return_20d", "rs_vs_btc_20d"]);

/**
 * P3-0i2 live keys: log-only and not pre-registered, so they belong to no tested family
 * (candidateKeys skips them) and the health report's family stats ignore them.
 */
export function isLiveStpKey(key: string): boolean {
  return (
    /^stp_(htf_opens_rolling|trigger_rolling|trigger_type_rolling|size_factor_long|size_factor_short)$/.test(key) ||
    /^(size_combined_|pyramid_|finviz_|swing_k)/.test(key) ||
    // P3-0j funnel keys (log only, not pre-registered as candidates)
    /^(funnel_pass|funnel_rank|gate_finviz|gate_earnings5|gate_rr|event_half|event_today_inhours|rr|rr_level|open_air|countertrend|next_event|next_event_days)$/.test(key) ||
    // P3-0k aligned-trend keys (log only)
    /^(align_(stock|industry|sector|market)|optimal_entry|p3k_candidate|p3k_size_long|p3k_size_short)$/.test(key) ||
    // P3-0l watchlist keys (log only)
    /^watch_(sources|first_seen|direction|direction_source|entry_ready|size|only)$/.test(key) ||
    // P3-0k3 aligned trend v2 keys (log only)
    /^p3k3_(candidate|size_long|size_short|ma_order)$/.test(key) ||
    // P3-0m options-ext keys on snapshot rows (log only; not the 1h opt family)
    /^opt_(scanned|unusual_n|sweep|net_premium|call_premium_ratio|top_type)$/.test(key)
  );
}

/** P3-0i2: below this share of stock rows with a sector layer, the live Power Pyramid keys are flagged. */
export const PYRAMID_SECTOR_MIN_SHARE = 0.5;

export interface PyramidCoverage {
  stockRows: number;
  /** Rows whose market layer had at least one index ETF state (pyramid_market_spy_htf etc. non-null). */
  market: number;
  /** Rows with a sector ETF mapped (needs the stock's weekly profile) and its state that day. */
  sector: number;
  industry: number;
  /** Universe members with a stored sector, and all members; null when unknown. */
  profiled: number | null;
  members: number | null;
  warn: boolean;
}

/**
 * Coverage of the live Power Pyramid keys (P3-0i2) over snapshot rows that carry them.
 * Missing weekly profiles silently null every sector and industry layer, which shrinks the
 * size keys to the market layer alone, so a low sector share is a warning.
 */
export function pyramidCoverage(
  rows: ReadonlyArray<Record<string, unknown> | null>,
  profiled: number | null = null,
  members: number | null = null,
): PyramidCoverage | null {
  const withKeys = rows.filter((r): r is Record<string, unknown> => !!r && "pyramid_size_long" in r);
  if (withKeys.length === 0) return null;
  const has = (k: string) => withKeys.filter((r) => r[k] != null).length;
  const market = withKeys.filter((r) => ["spy", "qqq", "dia"].some((e) => r[`pyramid_market_${e}_htf`] != null)).length;
  const sector = has("pyramid_sector_htf");
  return {
    stockRows: withKeys.length,
    market,
    sector,
    industry: has("pyramid_industry_htf"),
    profiled,
    members,
    warn: sector / withKeys.length < PYRAMID_SECTOR_MIN_SHARE,
  };
}

/** One line for the harvest log and the health report. */
export function pyramidCoverageLine(c: PyramidCoverage): string {
  const prof = c.members != null ? `, profiles ${c.profiled ?? 0}/${c.members} members` : "";
  return `[stp-live] pyramid: market layer ${c.market}/${c.stockRows} stock rows, sector ${c.sector}/${c.stockRows}, industry ${c.industry}/${c.stockRows}${prof}`;
}

export function familyOf(key: string): TickerFamily | null {
  if (isLiveStpKey(key)) return null;
  if (key.startsWith("stp_")) return "stp";
  if (BAR_KEYS.has(key) || CRYPTO_BAR_KEYS.has(key)) return "bar";
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
  /** P3-0e: crypto snapshot features for this scan and the universe's crypto member count (latest scan only). */
  cryptoSnapshot?: Array<Record<string, unknown> | null>;
  cryptoMembers?: number | null;
  /** P3-0i2: universe members with a stored sector (weekly profile). */
  profiledMembers?: number | null;
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
  scanLevel: {
    regime: boolean;
    sectorRotation: boolean;
    stpRows: number;
    /** P3-0f: Scan.regimeFeatures.macro, or null when the scan has none. */
    macro: Record<string, unknown> | null;
  };
  families: Record<TickerFamily, FamilyStats>;
  /** P3-0c: snapshot row count and per-family stats, when loaded. */
  snapshot?: { rows: number; families: Record<TickerFamily, FamilyStats> };
  /** P3-0i2: live Power Pyramid coverage over the stock snapshot rows. */
  pyramid?: PyramidCoverage | null;
  /** P3-0e: crypto members, rows in this snapshot, and per-family stats. */
  crypto?: { members: number | null; rows: number; families: Record<TickerFamily, FamilyStats> };
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

function macroOf(rf: Record<string, unknown> | null): Record<string, unknown> | null {
  const m = rf?.macro;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
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
      regime: !!scan.regimeFeatures && Object.keys(scan.regimeFeatures).some((k) => k !== "macro"),
      sectorRotation: !!scan.sectorRotation && Object.keys(scan.sectorRotation).length > 0,
      stpRows: scan.stpRows,
      macro: macroOf(scan.regimeFeatures),
    },
    families,
    ...(scan.snapshot
      ? {
          snapshot: { rows: scan.snapshot.length, families: familyStats(scan.snapshot) },
          pyramid: pyramidCoverage(scan.snapshot, scan.profiledMembers ?? null, scan.universeSize),
        }
      : {}),
    ...(scan.cryptoSnapshot
      ? { crypto: { members: scan.cryptoMembers ?? null, rows: scan.cryptoSnapshot.length, families: familyStats(scan.cryptoSnapshot) } }
      : {}),
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
  const macro = latest.scanLevel.macro;
  if (!macro) flags.push({ level: "warn", message: "macro context missing (Scan.regimeFeatures.macro empty)" });
  else {
    const nulls = Object.entries(macro).filter(([k, v]) => k !== "dxy_source" && isNull(v)).map(([k]) => k);
    if (nulls.length) flags.push({ level: "warn", message: `macro fields null: ${nulls.join(", ")}` });
    if (macro.dxy_source === "UUP") flags.push({ level: "info", message: "macro dollar series fell back to UUP (dxy_* on UUP's price scale)" });
  }
  if (latest.snapshot) {
    if (latest.snapshot.rows === 0) flags.push({ level: "warn", message: "universe snapshot missing (no UniverseSnapshot rows for the latest scan)" });
    else if (latest.universeSize != null && latest.snapshot.rows < latest.universeSize * 0.9)
      flags.push({ level: "warn", message: `universe snapshot has ${latest.snapshot.rows} rows for a universe of ${latest.universeSize} (under 90%)` });
    for (const f of ["bar", "stp"] as const)
      for (const [k, st] of Object.entries(latest.snapshot.families[f].keys))
        if (st.nullRate >= 1) flags.push({ level: "warn", message: `snapshot ${f}.${k} is 100% null in the latest scan` });
  }
  if (latest.pyramid?.warn) {
    const p = latest.pyramid;
    flags.push({
      level: "warn",
      message:
        `live pyramid sector layer on ${p.sector}/${p.stockRows} stock rows (under ${PYRAMID_SECTOR_MIN_SHARE * 100}%)` +
        (p.members != null ? `; ${p.profiled ?? 0}/${p.members} universe members have a sector profile` : "") +
        ": pyramid_size_* and size_combined_* reflect the market layer only",
    });
  }
  if (latest.crypto) {
    const c = latest.crypto;
    if (c.members != null && c.members > 0 && c.rows === 0) flags.push({ level: "warn", message: `crypto snapshot missing (${c.members} crypto members, no rows)` });
    else if (c.members === 0) flags.push({ level: "info", message: "crypto universe empty (no crypto members stored with this universe)" });
    for (const f of ["bar", "stp"] as const)
      for (const [k, st] of Object.entries(c.families[f].keys))
        if (c.rows > 0 && st.nullRate >= 1) flags.push({ level: "warn", message: `crypto ${f}.${k} is 100% null in the latest scan` });
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
  const mac = latest.scanLevel.macro;
  out.push(
    mac
      ? `Macro (${mac.macro_bar_date ?? "no date"}): ${Object.entries(mac)
          .filter(([k]) => k !== "macro_version" && k !== "macro_bar_date")
          .map(([k, v]) => `${k}=${typeof v === "number" ? fmt(v) : v ?? "null"}`)
          .join(", ")}`
      : "Macro: MISSING",
  );
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
  if (latest.pyramid) out.push("", pyramidCoverageLine(latest.pyramid));
  if (latest.crypto) {
    const c = latest.crypto;
    out.push("", `[crypto] ${c.members ?? "?"} members, ${c.rows} snapshot rows; coverage bar ${pct(c.families.bar.coverage)}, stp ${pct(c.families.stp.coverage)}`);
    for (const f of ["bar", "stp"] as const)
      for (const [k, st] of Object.entries(c.families[f].keys).sort(([a], [b]) => a.localeCompare(b)))
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
