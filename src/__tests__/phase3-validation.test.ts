import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metrics, timeSplit, walkForwardFolds, beats, type EvalRow } from "@/lib/eval/rules";
import {
  buildEvalRows,
  assertNoLookAhead,
  lastCompletedClose,
  spyReturn,
  LookAheadError,
  type SpyClose,
  type StoredTickerRow,
} from "@/lib/eval/dataset";
import { candidateKeys, evaluateFeature, quintileCuts, bucketOf, featureKind, testSplit, EXCLUDED_KEYS, MISSING } from "@/lib/eval/features";
import { experimentSummaryRow, lastExperimentNumber, markdownReport } from "@/lib/eval/report";
import { etParts, parseChartBars } from "@/lib/harvester/universe/bar-metrics";

// ── Synthetic fixture with known answers ──────────────────────────────────────
/** Deterministic PRNG (mulberry32) so the fixture is identical on every run. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const T0 = Date.parse("2027-01-04T13:30:00Z");

/**
 * 40 scans x 50 tickers. `planted_edge` (numeric): its top quintile earns +3% excess in
 * every period, the rest -0.5%. `pure_noise`: unrelated to outcomes. `rare_flag`: set on
 * 1 ticker per scan. Every outcome also carries random noise.
 */
function fixture(): EvalRow[] {
  const r = rng(42);
  const rows: EvalRow[] = [];
  for (let s = 0; s < 40; s++) {
    for (let i = 0; i < 50; i++) {
      const planted = r();
      const top = planted > 0.8;
      const x = (top ? 0.03 : -0.005) + (r() - 0.5) * 0.04;
      rows.push({
        scanId: `scan${String(s).padStart(3, "0")}`,
        scanStart: new Date(T0 + s * DAY),
        symbol: `S${i}`,
        ret: { "1d": x, "3d": x, "7d": x },
        excess: { "1d": x, "3d": x, "7d": x },
        attrs: {
          rs_vs_spy_20d: planted, // a real bar-family key, so candidateKeys picks it up
          rsi14: r() * 100, // pure noise
          politician_only_catalyst: i === 0 ? true : undefined, // rare
          features_version: 1, // excluded
        },
      });
    }
  }
  return rows;
}

describe("known-answer fixture", () => {
  const rows = fixture();

  it("tests the logged feature keys and skips the excluded ones", () => {
    const keys = candidateKeys(rows);
    expect(keys).toEqual(["politician_only_catalyst", "rs_vs_spy_20d", "rsi14"]);
    expect(EXCLUDED_KEYS.has("features_version")).toBe(true);
  });

  it("KEEPs the planted edge, selecting its top quintile on training data", () => {
    const r = evaluateFeature(rows, "rs_vs_spy_20d");
    expect(r.kind).toBe("numeric");
    expect(r.heldOut.selected).toBe("q5");
    expect(r.verdict).toBe("KEEP");
    expect(r.folds.filter((f) => f.passed).length).toBeGreaterThanOrEqual(2);
  });

  it("does not KEEP pure noise", () => {
    const r = evaluateFeature(rows, "rsi14");
    expect(r.verdict).not.toBe("KEEP");
    expect(["DROP", "INSUFFICIENT"]).toContain(r.verdict);
  });

  it("marks a feature with too few rows INSUFFICIENT", () => {
    const r = evaluateFeature(rows, "politician_only_catalyst");
    expect(r.verdict).toBe("INSUFFICIENT");
  });

  it("drops an edge that only appears in the last block of time", () => {
    const late = rows.map((row) => {
      const s = Number(row.scanId.slice(4));
      const top = (row.attrs.rs_vs_spy_20d as number) > 0.8;
      const x = top ? (s >= 30 ? 0.03 : -0.02) : 0;
      return { ...row, excess: { "1d": x, "3d": x, "7d": x } };
    });
    const r = evaluateFeature(late, "rs_vs_spy_20d");
    // The top quintile lost money in the training period, so selection on training data
    // never picks it: the late edge can't be cherry-picked from the test set.
    expect(r.heldOut.selected).not.toBe("q5");
    expect(r.verdict).toBe("DROP");
    expect(r.folds.filter((f) => f.passed).length).toBeLessThan(2);
  });
});

describe("folds test the held-out bucket, not their own best (review of #33)", () => {
  const rows = fixture();

  it("every fold tests exactly the bucket chosen on the held-out split", () => {
    for (const k of ["rs_vs_spy_20d", "rsi14"]) {
      const r = evaluateFeature(rows, k);
      expect(r.folds.map((f) => f.selected)).toEqual([r.heldOut.selected, r.heldOut.selected, r.heldOut.selected]);
    }
  });

  it("does not KEEP a feature whose winning bucket flips between periods", () => {
    // 4 blocks of 10 scans: q5 wins in blocks 0 and 2, q1 wins in blocks 1 and 3.
    // Per-fold selection would find a winner in every fold; a fixed bucket can't.
    const flipping = rows.map((row) => {
      const block = Math.floor(Number(row.scanId.slice(4)) / 10);
      const v = row.attrs.rs_vs_spy_20d as number;
      const q5 = v > 0.8;
      const q1 = v <= 0.2;
      const winner = block % 2 === 0 ? q5 : q1;
      const x = winner ? 0.03 : -0.005;
      return { ...row, excess: { "1d": x, "3d": x, "7d": x } };
    });
    const r = evaluateFeature(flipping, "rs_vs_spy_20d");
    expect(r.verdict).not.toBe("KEEP");
    expect(r.folds.filter((f) => f.passed).length).toBeLessThan(2);
    // Each fold, left to pick its own best bucket, would have found a winner every time
    const ownBest = walkForwardFolds(flipping).map((f) => testSplit(f.train, f.test, "rs_vs_spy_20d", "numeric", 30).selected);
    expect(new Set(ownBest).size).toBeGreaterThan(1);
  });

  it("reports distinct tickers beside n for each test bucket", () => {
    const r = evaluateFeature(rows, "rs_vs_spy_20d");
    const b = r.heldOut.buckets.find((x) => x.bucket === r.heldOut.selected)!;
    expect(b.testTickers).toBeGreaterThan(0);
    expect(b.testTickers).toBeLessThanOrEqual(50);
    expect(b.testTickers).toBeLessThanOrEqual(b.test.n);
  });
});

describe("buckets", () => {
  it("cuts quintiles on training values and assigns test values with those cuts", () => {
    const cuts = quintileCuts(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(cuts).toEqual([20, 40, 60, 80]);
    expect([0, 20, 21, 80, 81, 1000].map((v) => bucketOf(v, "numeric", cuts))).toEqual(["q1", "q1", "q2", "q4", "q5", "q5"]);
    expect(bucketOf(null, "numeric", cuts)).toBe(MISSING);
    expect(bucketOf(true, "categorical", [])).toBe("true");
  });

  it("uses only training rows for the cut points", () => {
    // Training values 1..100; a test row at 10,000 must land in q5 under training cuts
    const train: EvalRow[] = Array.from({ length: 100 }, (_, i) => ({ scanId: "a", scanStart: new Date(T0), symbol: `T${i}`, ret: {}, excess: { "7d": 0 }, attrs: { k: i + 1 } }));
    const cuts = quintileCuts(train.map((r) => r.attrs.k as number));
    expect(bucketOf(10_000, "numeric", cuts)).toBe("q5");
  });

  it("classifies features as numeric, categorical or skipped", () => {
    const row = (v: unknown): EvalRow => ({ scanId: "a", scanStart: new Date(T0), symbol: "X", ret: {}, excess: {}, attrs: { k: v } });
    expect(featureKind([row(1), row(2.5), row(null)], "k")).toBe("numeric");
    expect(featureKind([row("opportunistic"), row("routine")], "k")).toBe("categorical");
    expect(featureKind(Array.from({ length: 20 }, (_, i) => row(`c${i}`)), "k")).toBe("skipped");
    expect(featureKind([row(null)], "k")).toBe("skipped");
  });
});

describe("time split, folds and metrics", () => {
  const rows = fixture();
  it("holds out the newest 30% of scans without splitting a scan", () => {
    const { train, test } = timeSplit(rows);
    expect(new Set(test.map((r) => r.scanId)).size).toBe(12);
    expect(Math.min(...test.map((r) => r.scanStart.getTime()))).toBeGreaterThan(Math.max(...train.map((r) => r.scanStart.getTime())));
    expect(new Set(timeSplit([...rows].reverse()).test.map((r) => r.scanId))).toEqual(new Set(test.map((r) => r.scanId)));
  });
  it("builds 3 expanding folds, each testing a later block", () => {
    const folds = walkForwardFolds(rows);
    expect(folds).toHaveLength(3);
    for (const f of folds) expect(Math.min(...f.test.map((r) => r.scanStart.getTime()))).toBeGreaterThan(Math.max(...f.train.map((r) => r.scanStart.getTime())));
  });
  it("computes hit rate on excess return and needs both measures to beat", () => {
    const m = metrics(rows.slice(0, 3).map((r, i) => ({ ...r, excess: { "7d": [0.02, -0.01, null][i] } })), "7d");
    expect(m).toMatchObject({ n: 2, hitRate: 0.5 });
    expect(beats({ n: 1, hitRate: 0.4, meanExcess: 0.05, meanRaw: 0 }, { n: 1, hitRate: 0.5, meanExcess: 0, meanRaw: 0 })).toBe(false);
  });
});

// ── Dataset: look-ahead guard and SPY benchmark (real saved SPY chart) ───────
const spyJson = JSON.parse(readFileSync(join(__dirname, "fixtures/universe/chart-SPY-3mo.json"), "utf8")) as unknown;
const SPY: SpyClose[] = parseChartBars(spyJson, new Date("2030-01-01T00:00:00Z"))
  .filter((b) => b.time != null)
  .map((b) => ({ date: etParts(new Date(b.time! * 1000)).date, close: b.close }));
const at = (s: SpyClose, hourUtc: number) => { const [y, m, d] = s.date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, hourUtc, 30)); };

const stored = (over: Partial<StoredTickerRow> = {}): StoredTickerRow => ({
  scanId: "s1", scanStartedAt: at(SPY[SPY.length - 10], 13), symbol: "AMD", inUniverse: true, stage: "EARLY", recommendation: "Buy",
  aiScore: 70, opportunityScore: 40, sourceCount: 2, signalType: "insider_buy",
  features: { insider_class: "opportunistic" }, regimeFeatures: { spy_above_sma20: true },
  performance: {
    corporateActionDetected: false, return1d: null, return3d: null, return7d: 0.05,
    snapped1dAt: null, snapped3dAt: null, snapped7dAt: at(SPY[SPY.length - 3], 18),
  },
  ...over,
});

describe("look-ahead guard", () => {
  it("refuses to run when an outcome is snapped before its scan", () => {
    const leak = stored({ performance: { ...stored().performance!, snapped7dAt: new Date(stored().scanStartedAt.getTime() - 3600_000) } });
    expect(() => buildEvalRows([stored(), leak], SPY)).toThrow(LookAheadError);
    expect(() => assertNoLookAhead([leak])).toThrow(/refusing to run/);
  });
  it("refuses a return with no snapshot time, and accepts clean rows", () => {
    expect(() => assertNoLookAhead([stored({ performance: { ...stored().performance!, snapped7dAt: null } })])).toThrow(LookAheadError);
    expect(() => assertNoLookAhead([stored()])).not.toThrow();
  });
});

describe("SPY benchmark", () => {
  it("an 08:30 ET scan starts from the previous session's close", () => {
    const d = SPY[SPY.length - 5];
    expect(lastCompletedClose(SPY, at(d, 13))).toBe(SPY[SPY.length - 6].close);
    expect(lastCompletedClose(SPY, at(d, 21))).toBe(d.close);
  });
  it("builds excess return and keeps only scan-time attributes", () => {
    const [row] = buildEvalRows([stored()], SPY);
    const s = stored();
    expect(row.excess["7d"]).toBeCloseTo(0.05 - spyReturn(SPY, s.scanStartedAt, s.performance!.snapped7dAt!)!, 10);
    expect(row.attrs).toMatchObject({ insider_class: "opportunistic", "regime.spy_above_sma20": true });
    expect(Object.keys(row.attrs).some((k) => /return|snapped/.test(k))).toBe(false);
    expect(buildEvalRows([stored({ inUniverse: false }), stored({ performance: null })], SPY)).toHaveLength(0);
  });
});

describe("report output", () => {
  const results = ["rs_vs_spy_20d", "rsi14", "politician_only_catalyst"].map((k) => evaluateFeature(fixture(), k));
  it("writes a markdown report with the comparison count and per-bucket tables", () => {
    const md = markdownReport(results, { date: "2027-03-01", commit: "abc1234", rows: 2000, scans: 40 });
    expect(md).toContain("3 features tested (= 3 comparisons)");
    expect(md).toContain("## rs_vs_spy_20d: KEEP");
    expect(md).toMatch(/\| q5 ← \| \d+ \|/);
    expect(md).toContain("held-out n (distinct tickers)");
    expect(md).toContain("**Fold 3 of 3**");
  });
  it("appends one summary row in the experiment log's column layout", () => {
    const log = readFileSync(join(__dirname, "../../scripts/backtesting-experiments.md"), "utf8");
    const cols = log.split("\n").find((l) => l.startsWith("| # |"))!.split("|").length;
    const row = experimentSummaryRow(results, { number: lastExperimentNumber(log) + 1, date: "2027-03-01", commit: "abc1234", rows: 2000, scans: 40, reportPath: "scripts/output/x.md" });
    expect(row.split("|").length).toBe(cols);
    expect(row).toContain(`| ${lastExperimentNumber(log) + 1} | 2027-03-01 | abc1234 |`);
    expect(row).toContain("| keep | rs_vs_spy_20d |");
  });
});

describe("pre-registration document", () => {
  const md = readFileSync(join(__dirname, "../../docs/PHASE3-PREREG.md"), "utf8");
  const rows = [...md.matchAll(/^\| ([a-z_]+) \([^)]*\) \| (\d+) \| ([^|]+) \|$/gm)];
  const keys = rows.flatMap((m) => m[3].split(",").map((k) => k.trim()));

  it("states 94 comparisons and its family counts add up", () => {
    expect(md).toContain("**94 comparisons**");
    expect(rows.reduce((s, m) => s + Number(m[2]), 0)).toBe(94);
    for (const m of rows) expect(m[3].split(",").length).toBe(Number(m[2]));
  });

  it("lists only keys the harness tests: none excluded, each in a logged family or the regime", () => {
    expect(new Set(keys).size).toBe(keys.length);
    const row: EvalRow = { scanId: "s", scanStart: new Date(T0), symbol: "X", ret: {}, excess: {}, attrs: Object.fromEntries(keys.map((k) => [k, 1])) };
    expect(candidateKeys([row]).sort()).toEqual([...keys].sort());
  });
});
