import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  metrics,
  timeSplit,
  walkForwardFolds,
  evaluateCandidate,
  beats,
  MIN_HELDOUT_ROWS,
  type EvalRow,
  type Candidate,
} from "@/lib/eval/rules";
import { buildEvalRows, lastCompletedClose, spyReturn, type SpyClose, type StoredTickerRow } from "@/lib/eval/dataset";
import { CANDIDATES } from "@/lib/eval/candidates";
import { experimentRows, lastExperimentNumber, consoleTable } from "@/lib/eval/report";
import { etParts, parseChartBars } from "@/lib/harvester/universe/bar-metrics";

// ── Synthetic rows with controlled outcomes ───────────────────────────────────
const DAY = 86_400_000;
const T0 = Date.parse("2027-01-04T13:30:00Z");

/** `scans` scans of `perScan` rows; `flag(scanIdx, i)` marks selected rows, `excess(...)` sets their 7d excess. */
function synth(scans: number, perScan: number, flag: (s: number, i: number) => boolean, excess: (s: number, flagged: boolean) => number): EvalRow[] {
  const out: EvalRow[] = [];
  for (let s = 0; s < scans; s++) {
    for (let i = 0; i < perScan; i++) {
      const f = flag(s, i);
      const x = excess(s, f);
      out.push({
        scanId: `scan${String(s).padStart(3, "0")}`,
        scanStart: new Date(T0 + s * DAY),
        symbol: `S${i}`,
        ret: { "1d": x, "3d": x, "7d": x + 0.001 },
        excess: { "1d": x, "3d": x, "7d": x },
        attrs: { x: f },
      });
    }
  }
  return out;
}
const pick: Candidate = { id: "x", description: "x flag", select: (r) => r.attrs.x === true };

describe("time split and walk-forward", () => {
  const rows = synth(20, 10, () => false, () => 0);

  it("tests on the newest 30% of scans and never splits a scan", () => {
    const { train, test } = timeSplit(rows);
    const trainScans = new Set(train.map((r) => r.scanId));
    const testScans = new Set(test.map((r) => r.scanId));
    expect(testScans.size).toBe(6);
    expect([...trainScans].some((s) => testScans.has(s))).toBe(false);
    const maxTrain = Math.max(...train.map((r) => r.scanStart.getTime()));
    const minTest = Math.min(...test.map((r) => r.scanStart.getTime()));
    expect(minTest).toBeGreaterThan(maxTrain);
  });

  it("orders by scan time even when rows arrive shuffled", () => {
    const shuffled = [...rows].reverse();
    expect(new Set(timeSplit(shuffled).test.map((r) => r.scanId))).toEqual(new Set(timeSplit(rows).test.map((r) => r.scanId)));
  });

  it("builds 3 expanding folds, each testing a later block", () => {
    const folds = walkForwardFolds(rows);
    expect(folds).toHaveLength(3);
    for (const f of folds) {
      expect(f.test.length).toBeGreaterThan(0);
      expect(Math.min(...f.test.map((r) => r.scanStart.getTime()))).toBeGreaterThan(Math.max(...f.train.map((r) => r.scanStart.getTime())));
    }
    expect(folds[2].train.length).toBeGreaterThan(folds[0].train.length);
  });
});

describe("metrics", () => {
  it("uses excess return for the hit rate and ignores missing values", () => {
    const rows = synth(1, 4, () => false, () => 0).map((r, i) => ({ ...r, excess: { "7d": [0.02, -0.01, null, 0.04][i] } }));
    const m = metrics(rows, "7d");
    expect(m.n).toBe(3);
    expect(m.hitRate).toBeCloseTo(2 / 3);
    expect(m.meanExcess).toBeCloseTo(0.05 / 3);
  });
  it("needs both a higher mean excess and a higher hit rate to beat the baseline", () => {
    expect(beats({ n: 1, hitRate: 0.6, meanExcess: 0.01, meanRaw: 0 }, { n: 1, hitRate: 0.5, meanExcess: 0.0, meanRaw: 0 })).toBe(true);
    expect(beats({ n: 1, hitRate: 0.4, meanExcess: 0.05, meanRaw: 0 }, { n: 1, hitRate: 0.5, meanExcess: 0.0, meanRaw: 0 })).toBe(false);
    expect(beats({ n: 0, hitRate: null, meanExcess: null, meanRaw: null }, { n: 1, hitRate: 0.5, meanExcess: 0, meanRaw: 0 })).toBe(false);
  });
});

describe("evaluateCandidate verdicts", () => {
  it("is insufficient below 100 held-out rows", () => {
    const r = evaluateCandidate(synth(20, 10, (_s, i) => i === 0, (_s, f) => (f ? 0.05 : -0.01)), pick);
    expect(r.verdict).toBe("insufficient");
    expect(r.heldOut["7d"].n).toBeLessThan(MIN_HELDOUT_ROWS);
  });

  it("keeps a candidate that beats the baseline held-out and in every fold", () => {
    const r = evaluateCandidate(synth(40, 30, (_s, i) => i < 12, (_s, f) => (f ? 0.03 : -0.01)), pick);
    expect(r.verdict).toBe("keep");
    expect(r.folds.every((f) => f.passed)).toBe(true);
  });

  it("discards a candidate that loses on the held-out set", () => {
    const r = evaluateCandidate(synth(40, 30, (_s, i) => i < 12, (_s, f) => (f ? -0.02 : 0.01)), pick);
    expect(r.verdict).toBe("discard");
  });

  it("discards an edge that only shows up in the last block (fails 2 of 3 folds)", () => {
    // Selected rows lose before scan 30 and win after: the held-out set looks good, the folds don't.
    const r = evaluateCandidate(synth(40, 30, (_s, i) => i < 12, (s, f) => (f ? (s >= 30 ? 0.04 : -0.03) : 0)), pick);
    expect(r.heldOut["7d"].meanExcess!).toBeGreaterThan(0);
    expect(r.verdict).toBe("discard");
    expect(r.reason).toMatch(/holds in only 1 of 3 folds/);
  });
});

// ── Dataset: SPY benchmark from the real saved SPY chart ──────────────────────
const spyJson = JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-SPY-3mo.json"), "utf8")) as unknown;
const SPY: SpyClose[] = parseChartBars(spyJson, new Date("2030-01-01T00:00:00Z"))
  .filter((b) => b.time != null)
  .map((b) => ({ date: etParts(new Date(b.time! * 1000)).date, close: b.close }));

describe("SPY window", () => {
  const d = SPY[SPY.length - 5];
  const prev = SPY[SPY.length - 6];
  const [y, m, day] = d.date.split("-").map(Number);

  it("an 08:30 ET scan uses the previous session's close; after 16:00 ET it uses that day's", () => {
    // 13:30Z / 21:30Z are 08:30 / 16:30 ET (EST) or 09:30 / 17:30 (EDT): before and after the close either way
    expect(lastCompletedClose(SPY, new Date(Date.UTC(y, m - 1, day, 13, 30)))).toBe(prev.close);
    expect(lastCompletedClose(SPY, new Date(Date.UTC(y, m - 1, day, 21, 30)))).toBe(d.close);
    expect(lastCompletedClose(SPY, new Date("1990-01-01T00:00:00Z"))).toBeNull();
  });

  it("computes SPY's return over the ticker's window", () => {
    const later = SPY[SPY.length - 1];
    const [y2, m2, d2] = later.date.split("-").map(Number);
    const r = spyReturn(SPY, new Date(Date.UTC(y, m - 1, day, 21, 30)), new Date(Date.UTC(y2, m2 - 1, d2, 21, 30)));
    expect(r).toBeCloseTo(later.close / d.close - 1, 10);
  });
});

describe("buildEvalRows", () => {
  const scanAt = (s: SpyClose) => { const [y, m, d] = s.date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 13, 30)); };
  const start = SPY[SPY.length - 10];
  const end7 = SPY[SPY.length - 3];
  const base: StoredTickerRow = {
    scanId: "s1", scanStartedAt: scanAt(start), symbol: "AMD", inUniverse: true, stage: "EARLY", recommendation: "Buy",
    aiScore: 70, opportunityScore: 40, sourceCount: 2, signalType: "insider_buy",
    features: { insider_class: "opportunistic", nr7: true }, regimeFeatures: { spy_above_sma20: true },
    performance: {
      corporateActionDetected: false, return1d: 0.01, return3d: null, return7d: 0.05,
      snapped1dAt: null, snapped3dAt: null, snapped7dAt: new Date(scanAt(end7).getTime() + 10 * 3600_000), // 18:30Z: after that day's close
    },
  };

  it("computes excess return vs SPY and keeps only scan-time attributes", () => {
    const [row] = buildEvalRows([base], SPY);
    const spy7 = spyReturn(SPY, base.scanStartedAt, base.performance!.snapped7dAt!)!;
    expect(row.excess["7d"]).toBeCloseTo(0.05 - spy7, 10);
    expect(row.excess["1d"]).toBeNull(); // no snapshot time, no benchmark
    expect(row.excess["3d"]).toBeNull();
    expect(row.attrs).toMatchObject({ insider_class: "opportunistic", nr7: true, "regime.spy_above_sma20": true, recommendation: "Buy" });
    expect(Object.keys(row.attrs).some((k) => /return|price\d|snapped/.test(k))).toBe(false);
  });

  it("drops rows outside the universe, with a corporate action, or without performance", () => {
    expect(buildEvalRows([{ ...base, inUniverse: false }, { ...base, inUniverse: null }], SPY)).toHaveLength(0);
    expect(buildEvalRows([{ ...base, performance: { ...base.performance!, corporateActionDetected: true } }], SPY)).toHaveLength(0);
    expect(buildEvalRows([{ ...base, performance: null }], SPY)).toHaveLength(0);
  });
});

describe("pre-registered candidates", () => {
  it("have unique ids and select nothing when their data is missing", () => {
    expect(new Set(CANDIDATES.map((c) => c.id)).size).toBe(CANDIDATES.length);
    const empty: EvalRow = { scanId: "s", scanStart: new Date(T0), symbol: "X", ret: {}, excess: {}, attrs: {} };
    for (const c of CANDIDATES) expect(c.select(empty)).toBe(false);
  });
  it("select on the features the harvester actually writes", () => {
    const row = (attrs: Record<string, unknown>): EvalRow => ({ scanId: "s", scanStart: new Date(T0), symbol: "X", ret: {}, excess: {}, attrs });
    const get = (id: string) => CANDIDATES.find((c) => c.id === id)!;
    expect(get("insider_opportunistic").select(row({ insider_class: "opportunistic" }))).toBe(true);
    expect(get("reddit_hype_only").select(row({ reddit_hype_count: 2, reddit_dd_count: 0 }))).toBe(true);
    expect(get("reddit_hype_only").select(row({ reddit_hype_count: 2, reddit_dd_count: 1 }))).toBe(false);
    expect(get("alp_large_prints").select(row({ alp_large_prints: 3 }))).toBe(true);
    expect(get("opt_iv_cheap").select(row({ opt_iv_hv20_ratio: 0.8 }))).toBe(true);
    expect(get("spy_above_sma20").select(row({ "regime.spy_above_sma20": true }))).toBe(true);
    expect(get("rec_buy_or_strong").select(row({ recommendation: "Strong Buy" }))).toBe(true);
  });
});

describe("experiment-log output", () => {
  const md = readFileSync(join(__dirname, "../../scripts/backtesting-experiments.md"), "utf8");
  it("continues numbering after the last logged experiment", () => {
    expect(lastExperimentNumber(md)).toBeGreaterThanOrEqual(27);
    expect(lastExperimentNumber("no table")).toBe(0);
  });
  it("writes rows with the log's column count and the verdict", () => {
    const header = md.split("\n").find((l) => l.startsWith("| # |"))!;
    const cols = header.split("|").length;
    const results = [evaluateCandidate(synth(40, 30, (_s, i) => i < 12, (_s, f) => (f ? 0.03 : -0.01)), pick)];
    const [line] = experimentRows(results, { date: "2027-03-01", commit: "abc1234", startAfter: 27 });
    expect(line.startsWith("| 28 | 2027-03-01 | abc1234 |")).toBe(true);
    expect(line.split("|").length).toBe(cols);
    expect(line).toContain("| keep |");
    expect(consoleTable(results)).toMatch(/^candidate/);
  });
});
