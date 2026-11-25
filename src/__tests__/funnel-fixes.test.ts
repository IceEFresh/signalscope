import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { limitEntryOnNextBar } from "@/lib/eval/funnel";
import { evaluateFunnel, inPopulation, rankCandidates, type Candidate, type FunnelTrade } from "@/lib/eval/funnel-sim";
import { eventCounterfactualLines, rrDiagnosticLines } from "@/lib/eval/funnel-report";
import { PROVISIONAL_AFTER_ONLY, initialShares, simulateExitB } from "@/lib/eval/stp-sim";

function bars(ohlc: Array<[number, number, number, number]>): DailyBar[] {
  let t = Date.UTC(2026, 0, 5, 14, 30) / 1000;
  return ohlc.map(([open, high, low, close]) => {
    while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
    const b = { open, high, low, close, volume: 1, time: t };
    t += 86_400;
    return b;
  });
}

describe("P3-0j3 pullback sizing: shares fixed by the limit risk", () => {
  // limit 105, stop 99: planned risk 6, $200 → 33 shares
  it("an open 1 cent above the stop fills at the open but sizes from the limit; a gap through the stop next day loses ≤ 1R plus costs", () => {
    const b = bars([[100, 110, 100, 108], [99.01, 104, 99.01, 103], [94, 95, 93, 94]]);
    const e = limitEntryOnNextBar(b[1], 1, 105, 99);
    expect(e).toEqual({ status: "filled", fill: 99.01, risk: 6 });
    if (e.status !== "filled") throw new Error("not filled");
    expect(initialShares(200, e.risk)).toBe(33); // not floor(200 / 0.01) = 20,000
    const x = simulateExitB(b, b.map((y) => y.close), b.map(() => 2), 1, 1, e.fill, e.risk, 99, 0.22, "inside", 200, 1000, 3, {});
    expect(x).toMatchObject({ reason: "stop_gap", shares: 33, exit: 94 });
    expect(x.grossR).toBeGreaterThanOrEqual(-1);
    expect(x.netR).toBeGreaterThan(-1.01);
  });
  it("an open at the limit is unchanged", () => {
    expect(limitEntryOnNextBar(bars([[105, 106, 104, 105]])[0], 1, 105, 99)).toEqual({ status: "filled", fill: 105, risk: 6 });
    expect(limitEntryOnNextBar(bars([[95, 101, 94, 96]])[0], -1, 95, 101)).toEqual({ status: "filled", fill: 95, risk: 6 });
  });
});

describe("P3-0j3 controls: a KEEP only under the after-trigger control is provisional", () => {
  const trades = (windowR: number): FunnelTrade[] =>
    Array.from({ length: 900 }, (_, k) => {
      const d = new Date(Date.UTC(2023, 0, 2) + k * 86_400_000).toISOString().slice(0, 10);
      const netR = k % 3 === 0 ? -1 : 1;
      return {
        population: "top5", arm: "stop", dir: 1, symbol: "S", scanId: d, scanStart: new Date(`${d}T21:00:00Z`), fillDate: d, exitDate: d,
        netR, grossR: netR, controlNetR: -0.5, controlWindowNetR: windowR, reached3R: false, holding: 1, adds: 0, addGapSkips: 0, addCapReached: false,
        initialUnitR: netR, dollarNet: netR * 200, reason: "stop", eventTiers: [], netRNoEvent: null, sizeMult: 1,
      } as unknown as FunnelTrade;
    });
  const get = (ts: FunnelTrade[]) => evaluateFunnel(ts).find((r) => r.id === "stop:top5-vs-control:long")!;
  it("passes the after-only control but not the ±20 control → KEEP, provisional", () => {
    const r = get(trades(5));
    expect(r.verdict).toBe("KEEP");
    expect(r.reason).toContain(PROVISIONAL_AFTER_ONLY);
    expect(r.heldOut.controlWindowExpectancy).toBe(5);
  });
  it("passes both → KEEP, not provisional", () => {
    const r = get(trades(-1));
    expect(r.verdict).toBe("KEEP");
    expect(r.reason).not.toContain(PROVISIONAL_AFTER_ONLY);
  });
});

describe("P3-0j3 descriptive reports", () => {
  const t = (p: string, arm: string, netR: number, noEvent: number | null, tiers: string[], extra: Partial<FunnelTrade> = {}) =>
    ({ population: p, arm, symbol: "S", fillDate: "2026-01-05", exitDate: "2026-01-06", netR, grossR: netR, netRNoEvent: noEvent, eventTiers: tiers, reached3R: netR > 2, holding: 1, adds: 0, addGapSkips: 0, initialUnitR: netR, dollarNet: 0, reason: "stop", controlNetR: null, ...extra }) as unknown as FunnelTrade;
  it("event rule counterfactual: per tier, R with the rule, without, and the difference", () => {
    const lines = eventCounterfactualLines([t("top5", "stop", 3, 2, ["event_bar"]), t("top5", "stop", 1, 1.5, ["event_be"]), t("top5", "stop", -1, -1, []), t("all", "stop", 9, 0, ["event_bar"])]);
    expect(lines).toContain("| stop | event_bar | 1 | 3.000 | 2.000 | 1.000 |");
    expect(lines).toContain("| stop | event_be | 1 | 1.000 | 1.500 | -0.500 |");
    expect(lines).toContain("| stop | no event | 1 | -1.000 | -1.000 | 0.000 |");
    expect(lines).toContain("| stop | all | 3 | 1.000 | 0.833 | 0.167 |");
  });
  it("R/R quintiles and the stop distance in ATR, top 5 vs all", () => {
    const top = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((rr) => t("top5", "stop", rr > 5 ? 1 : -1, null, [], { rr, openAir: rr > 8, stopAtr: 0.5 } as Partial<FunnelTrade>));
    const all = [t("all", "stop", 0, null, [], { stopAtr: 1.5 } as Partial<FunnelTrade>)];
    const text = rrDiagnosticLines([...top, ...all]).join("\n");
    expect(text).toContain("open_air: 2 of 10 top-5 trades. Median stop distance: top 5 0.500 ATR vs all trades 1.500 ATR.");
    expect(text).toContain("| Q1 | 1.00–2.00 | 2 | 0 | -1.000 |");
    expect(text).toContain("| Q5 | 9.00–10.00 | 2 | 2 | 1.000 |");
  });
  it("the no-open_air ranking ranks only candidates with a level", () => {
    const cand = (symbol: string, rr: number, openAir: boolean): Candidate =>
      ({ symbol, date: "2026-01-12", dir: 1, rr: { rr, room: 1, level: openAir ? "open_air" : "swing", levelPrice: 1, openAir }, gates: { pass: true }, rallyUsed: null, rank: null, rankNoAir: null }) as unknown as Candidate;
    const c = [cand("A", 9, true), cand("B", 8, false), cand("C", 7, true), cand("D", 6, false)];
    rankCandidates(c);
    expect(c.map((x) => [x.rank, x.rankNoAir])).toEqual([[1, null], [2, 1], [3, null], [4, 2]]);
    expect(c.filter((x) => inPopulation(x, "top5_noair")).map((x) => x.symbol)).toEqual(["B", "D"]);
  });
});
