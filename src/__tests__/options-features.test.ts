import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeChain } from "@/lib/harvester/options-chain";
import {
  atmIv,
  bsDelta,
  computeOptionsFeatures,
  daysToExpiry,
  EMPTY_OPTIONS_FEATURES,
  pickExpiry,
  skew25d,
} from "@/lib/harvester/universe/options-features";
import { computeOptionsExtras } from "@/lib/harvester/universe/harvest-prep";

const raw = (f: string) => JSON.parse(readFileSync(join(__dirname, `fixtures/options/yahoo-AMD-${f}.json`), "utf8"));
const nearRaw = raw("near"); // expiry 2026-11-20
const farRaw = raw("30d"); // expiry 2026-12-18
const HARVEST = new Date("2026-11-20T13:30:00Z"); // 8:30 ET
const nowS = HARVEST.getTime() / 1000;

describe("normalizeChain", () => {
  it("reads a real Yahoo v7 chain", () => {
    const c = normalizeChain(nearRaw)!;
    expect(c.spot).toBeCloseTo(424.39, 2);
    expect(c.expiry).toBe(1795132800);
    expect(c.expirations.length).toBe(23);
    expect(c.calls.length).toBeGreaterThan(50);
    expect(c.puts.length).toBeGreaterThan(50);
  });

  it("reads the yahoo-finance2 shape with Date objects", () => {
    const c = normalizeChain({
      quote: { regularMarketPrice: 10 },
      expirationDates: [new Date(1797552000 * 1000)],
      options: [{ expirationDate: new Date(1797552000 * 1000), calls: [{ strike: 10, impliedVolatility: 0.5, volume: 3, openInterest: 1 }], puts: [] }],
    })!;
    expect(c.expiry).toBe(1797552000);
    expect(c.expirations).toEqual([1797552000]);
    expect(c.calls[0]).toMatchObject({ strike: 10, iv: 0.5, volume: 3, openInterest: 1, bid: null });
  });

  it("returns null for empty or malformed responses", () => {
    expect(normalizeChain(null)).toBeNull();
    expect(normalizeChain({ optionChain: { result: [] } })).toBeNull();
    expect(normalizeChain({ options: [{ calls: [] }] })).toBeNull(); // no expiry
  });
});

describe("expiry selection", () => {
  it("counts days to the 16:00 ET close and picks the expiry closest to 30 days within 14–60", () => {
    expect(daysToExpiry(1795132800, nowS)).toBeCloseTo(0.3125, 4); // same-day expiry at 8:30 ET
    const exps = normalizeChain(nearRaw)!.expirations;
    const pick = pickExpiry(exps, nowS)!;
    const d = daysToExpiry(pick, nowS);
    for (const e of exps) {
      const de = daysToExpiry(e, nowS);
      if (de >= 14 && de <= 60) expect(Math.abs(d - 30)).toBeLessThanOrEqual(Math.abs(de - 30));
    }
    expect(pickExpiry([1795132800], nowS)).toBeNull();
  });
});

describe("Black-Scholes delta", () => {
  it("is ~0.5 at the money, put = call − 1, and → 1 deep in the money", () => {
    const c = bsDelta("call", 100, 100, 0.5, 30 / 365);
    expect(c).toBeGreaterThan(0.5);
    expect(c).toBeLessThan(0.56);
    expect(bsDelta("put", 100, 100, 0.5, 30 / 365)).toBeCloseTo(c - 1, 12);
    expect(bsDelta("call", 100, 50, 0.3, 30 / 365)).toBeGreaterThan(0.999);
  });
});

describe("computeOptionsFeatures on the real AMD chains at 8:30 ET", () => {
  const near = normalizeChain(nearRaw)!;
  const far = normalizeChain(farRaw)!;
  const f = computeOptionsFeatures(near, far, 1.34, nowS);

  it("fills every feature", () => {
    for (const [k, v] of Object.entries(f)) expect(v, k).not.toBeNull();
  });

  it("gives plausible values", () => {
    expect(f.opt_near_days!).toBeCloseTo(0.3125, 4);
    expect(f.opt_far_days!).toBeGreaterThan(20);
    expect(f.opt_atm_iv_30d!).toBeGreaterThan(0.2);
    expect(f.opt_atm_iv_30d!).toBeLessThan(3);
    expect(f.opt_iv_term_slope).toBeCloseTo(f.opt_atm_iv_30d! - f.opt_atm_iv_near!, 12);
    expect(f.opt_iv_hv20_ratio).toBeCloseTo(f.opt_atm_iv_30d! / 1.34, 12);
    expect(Math.abs(f.opt_skew_25d!)).toBeLessThan(1);
    expect(f.opt_pc_volume_ratio!).toBeGreaterThan(0);
    expect(f.opt_call_premium!).toBeGreaterThan(0);
    expect(f.opt_unusual_contracts!).toBeGreaterThanOrEqual(0);
  });

  it("is null without hv20 for the IV/HV ratio only", () => {
    const g = computeOptionsFeatures(near, far, null, nowS);
    expect(g.opt_iv_hv20_ratio).toBeNull();
    expect(g.opt_atm_iv_30d).toBe(f.opt_atm_iv_30d);
  });

  it("returns the empty set without chains, and nulls (not 0) for one-sided data", () => {
    expect(computeOptionsFeatures(null, null, 0.5, nowS)).toEqual(EMPTY_OPTIONS_FEATURES);
    const callsOnly = { ...far, puts: [] };
    const g = computeOptionsFeatures(null, callsOnly, 0.5, nowS);
    expect(g.opt_skew_25d).toBeNull();
    expect(g.opt_pc_volume_ratio).toBe(0);
    expect(g.opt_put_premium).toBeNull();
  });
});

describe("atmIv and skew25d", () => {
  const chain = (calls: Array<[number, number | null]>, puts: Array<[number, number | null]>) => ({
    spot: 100,
    expiry: 1797552000,
    expirations: [],
    calls: calls.map(([strike, iv]) => ({ strike, iv, volume: 0, openInterest: 0, bid: null, ask: null, last: null })),
    puts: puts.map(([strike, iv]) => ({ strike, iv, volume: 0, openInterest: 0, bid: null, ask: null, last: null })),
  });

  it("averages call and put IV at the strike nearest spot, ignoring junk IVs", () => {
    expect(atmIv(chain([[100, 0.4], [105, 0.00001]], [[100, 0.5]]), 101)).toBeCloseTo(0.45, 12);
    expect(atmIv(chain([[100, 0.00001]], [[100, null]]), 100)).toBeNull();
  });

  it("is null when no contract is near 25 delta", () => {
    expect(skew25d(chain([[100, 0.4]], [[100, 0.4]]), 100, nowS)).toBeNull();
  });
});

describe("computeOptionsExtras", () => {
  const far = 1797552000;
  it("uses the default chain for the expiry list, fetches the first ≥5-day and the ~30-day expiries, and skips names without options", async () => {
    // Return a chain dated to the requested expiry, as Yahoo does.
    const dated = (json: typeof nearRaw, e: number) => {
      const copy = structuredClone(json);
      copy.optionChain.result[0].options[0].expirationDate = e;
      return copy;
    };
    const fetchRaw = vi.fn(async (s: string, expiry?: number) => {
      if (s === "NONE") return { optionChain: { result: [] } };
      if (s === "BAD") throw new Error("crumb");
      if (expiry == null) return nearRaw;
      return dated(expiry === far ? farRaw : nearRaw, expiry);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await computeOptionsExtras(["AMD", "AMD", "NONE", "BAD"], { AMD: 1.34 }, { fetchRaw, now: HARVEST, batchDelayMs: 0 });
    expect(Object.keys(out)).toEqual(["AMD"]);
    const amdCalls = fetchRaw.mock.calls.filter((c) => c[0] === "AMD");
    const exps = normalizeChain(nearRaw)!.expirations;
    const near5 = exps.find((e) => daysToExpiry(e, nowS) >= 5);
    expect(amdCalls.map((c) => c[1])).toEqual([undefined, near5, pickExpiry(exps, nowS)]);
    expect(out.AMD.opt_near_days!).toBeGreaterThanOrEqual(5);
    expect(out.AMD.opt_iv_hv20_ratio).not.toBeNull();
    warn.mockRestore();
  });

  it("never uses an expired or same-day chain as the near expiry", async () => {
    const afterClose = new Date("2026-11-20T23:00:00Z");
    const fetchRaw = vi.fn(async (_s: string, expiry?: number) => (expiry == null ? nearRaw : farRaw));
    await computeOptionsExtras(["AMD"], {}, { fetchRaw, now: afterClose, batchDelayMs: 0 });
    const requested = fetchRaw.mock.calls.map((c) => c[1]).filter((e): e is number => e != null);
    for (const e of requested) expect(daysToExpiry(e, afterClose.getTime() / 1000)).toBeGreaterThanOrEqual(5);
  });
});
