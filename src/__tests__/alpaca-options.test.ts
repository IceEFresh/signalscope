import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseOcc,
  etToUtc,
  sessionWindow,
  computeChainStats,
  countLargePrints,
  alpacaFeaturesFor,
  computeAlpacaOptionsExtras,
  AlpacaDataClient,
  TOP_CONTRACTS_FOR_TRADES,
  ALPACA_OPTIONS_VERSION,
  type Snapshot,
  type Trade,
} from "@/lib/harvester/alpaca-options";

// Real Alpaca responses saved on the NAS (2026-11-20 session): AMD chain snapshots (page 1 of the
// chain, feed=indicative) and trades for AMD Dec-18-2026 calls and puts at strikes $100-$400.
const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures/alpaca", f), "utf8")) as Record<string, unknown>;
const snapJson = fx("alpaca-snapshots-AMD.json");
const tradeJson = fx("alpaca-trades-AMD.json");
const snapshots = snapJson.snapshots as Record<string, Snapshot>;
const trades = tradeJson.trades as Record<string, Trade[]>;

const SESSION = "2026-11-20";
const NOW = new Date("2026-11-23T13:30:00Z"); // Monday 08:30 ET, the harvest time
const CREDS = { apiKey: "k", apiSecret: "s", paper: true };

describe("parseOcc", () => {
  it("parses OCC symbols from the right", () => {
    expect(parseOcc("AMD261127P00445000")).toEqual({ root: "AMD", expiry: "2026-11-27", type: "P", strike: 445 });
    expect(parseOcc("GOOGL261218C00212500")).toEqual({ root: "GOOGL", expiry: "2026-12-18", type: "C", strike: 212.5 });
  });
  it("rejects malformed symbols", () => {
    expect(parseOcc("AMD")).toBeNull();
    expect(parseOcc("AMD261127X00445000")).toBeNull();
  });
});

describe("session window (no look-ahead)", () => {
  it("converts ET wall-clock times across DST", () => {
    expect(etToUtc("2026-11-20", 9, 30).toISOString()).toBe("2026-11-20T14:30:00.000Z");
    expect(etToUtc("2026-07-15", 9, 30).toISOString()).toBe("2026-07-15T13:30:00.000Z");
  });
  it("is the regular session, clipped to now", () => {
    const w = sessionWindow(SESSION, NOW)!;
    expect([w.start.toISOString(), w.end.toISOString()]).toEqual(["2026-11-20T14:30:00.000Z", "2026-11-20T21:00:00.000Z"]);
    expect(sessionWindow(SESSION, new Date("2026-11-20T18:00:00Z"))!.end.toISOString()).toBe("2026-11-20T18:00:00.000Z");
    expect(sessionWindow(SESSION, new Date("2026-11-20T12:00:00Z"))).toBeNull();
  });
});

describe("computeChainStats", () => {
  it("sums the real chain per bucket from session-dated bars only", () => {
    const { features, topContracts } = computeChainStats(snapshots, SESSION);
    // Page 1 holds Nov 23-27 expiries: all within 0-7 days of the session
    expect(features.alp_contracts).toBe(1000);
    expect(features.alp_call_volume_0_7).toBe(128_778);
    expect(features.alp_put_volume_0_7).toBe(149_183);
    expect(features.alp_trades_0_7).toBe(80_398);
    expect(features.alp_call_premium_0_7).toBeCloseTo(136_634_941, -1);
    expect(features.alp_put_premium_0_7).toBeCloseTo(196_747_376, -1);
    expect(features.alp_call_volume_8_30).toBe(0);
    expect(topContracts.slice(0, 3)).toEqual(["AMD261127P00400000", "AMD261123P00450000", "AMD261127P00430000"]);
  });

  it("ignores stale daily bars (the contract's last trade was an earlier session)", () => {
    const s: Record<string, Snapshot> = {
      AMD261127C00400000: { dailyBar: { t: "2026-11-20T05:00:00Z", v: 10, vw: 2, n: 3 } },
      AMD261127C00410000: { dailyBar: { t: "2026-11-12T05:00:00Z", v: 999, vw: 5, n: 50 } },
      AMD261127P00400000: {},
    };
    const { features, topContracts } = computeChainStats(s, SESSION);
    expect(features.alp_call_volume_0_7).toBe(10);
    expect(features.alp_call_premium_0_7).toBe(2_000);
    expect(features.alp_trades_0_7).toBe(3);
    expect(features.alp_contracts).toBe(3);
    expect(topContracts).toEqual(["AMD261127C00400000"]);
  });

  it("buckets by days to expiry and drops expiries past 60 days or malformed symbols", () => {
    const bar = { t: "2026-11-20T05:00:00Z", v: 1, vw: 1, n: 1 };
    const s: Record<string, Snapshot> = {
      AMD261204C00400000: { dailyBar: bar }, // 14 days
      AMD270101P00400000: { dailyBar: bar }, // 42 days
      AMD270301C00400000: { dailyBar: bar }, // 101 days: out
      BAD: { dailyBar: bar },
    };
    const { features } = computeChainStats(s, SESSION);
    expect(features.alp_call_volume_8_30).toBe(1);
    expect(features.alp_put_volume_31_60).toBe(1);
    expect(features.alp_contracts).toBe(2);
  });

  it("handles an empty chain", () => {
    const { features, topContracts } = computeChainStats({}, SESSION);
    expect(features.alp_contracts).toBe(0);
    expect(topContracts).toEqual([]);
  });
});

describe("countLargePrints", () => {
  const window = sessionWindow(SESSION, NOW)!;
  it("counts the real prints of $100K premium or more", () => {
    const r = countLargePrints(trades, window);
    expect(r.count).toBe(40);
    expect(r.premium).toBeCloseTo(22_395_799, -1);
    expect(r.callCount).toBe(40);
  });
  it("ignores prints outside the session and malformed rows", () => {
    const r = countLargePrints(
      {
        AMD261218P00200000: [
          { p: 10, s: 200, t: "2026-11-20T15:00:00Z" }, // $200K, in session, put
          { p: 10, s: 200, t: "2026-11-23T14:00:00Z" }, // after the window: look-ahead, ignored
          { p: 10, s: 99, t: "2026-11-20T15:00:00Z" }, // $99K
          { s: 500, t: "2026-11-20T15:00:00Z" }, // no price
        ],
      },
      window,
    );
    expect(r).toEqual({ count: 1, premium: 200_000, callCount: 0 });
  });
});

/** Fake data API: snapshots page 1 = real fixture, page 2 empty; trades = real fixture, then empty. */
function fakeAlpaca() {
  const calls: URL[] = [];
  const get = vi.fn(async (url: string, headers: Record<string, string>) => {
    const u = new URL(url);
    calls.push(u);
    expect(headers["APCA-API-KEY-ID"]).toBe("k");
    const paged = u.searchParams.has("page_token");
    if (u.pathname.startsWith("/v1beta1/options/snapshots/")) return paged ? { snapshots: {}, next_page_token: null } : snapJson;
    if (u.pathname === "/v1beta1/options/trades") return paged ? { trades: {}, next_page_token: null } : tradeJson;
    throw new Error(`unexpected ${url}`);
  });
  return { get, calls, client: new AlpacaDataClient(CREDS, get, 0) };
}

describe("alpacaFeaturesFor", () => {
  it("queries the 60-day chain and the previous session's trades for the top contracts", async () => {
    const { calls, client } = fakeAlpaca();
    const f = await alpacaFeaturesFor(client, "AMD", SESSION, NOW);
    const snap = calls.filter((u) => u.pathname.includes("snapshots"));
    expect(snap).toHaveLength(2);
    expect(snap[0].searchParams.get("feed")).toBe("indicative");
    expect(snap[0].searchParams.get("expiration_date_gte")).toBe("2026-11-23");
    expect(snap[0].searchParams.get("expiration_date_lte")).toBe("2027-01-22");
    expect(snap[1].searchParams.get("page_token")).toBe(snapJson.next_page_token);
    const tr = calls.filter((u) => u.pathname.endsWith("/trades"));
    expect(tr[0].searchParams.get("symbols")!.split(",")).toHaveLength(TOP_CONTRACTS_FOR_TRADES);
    expect(tr[0].searchParams.get("start")).toBe("2026-11-20T14:30:00.000Z");
    expect(tr[0].searchParams.get("end")).toBe("2026-11-20T21:00:00.000Z");
    expect(f).toMatchObject({
      alp_version: ALPACA_OPTIONS_VERSION,
      alp_contracts: 1000,
      alp_snapshots_capped: 0,
      alp_large_prints: 40,
      alp_large_print_calls: 40,
      alp_trades_capped: 0,
    });
    expect(client.requests).toBe(4);
  });

  it("marks a chain cut short by the page cap", async () => {
    const get = vi.fn(async (url: string) =>
      new URL(url).pathname.includes("snapshots") ? { snapshots: {}, next_page_token: "more" } : { trades: {} },
    );
    const f = await alpacaFeaturesFor(new AlpacaDataClient(CREDS, get, 0), "AMD", SESSION, NOW);
    expect(f.alp_snapshots_capped).toBe(1);
    expect(f.alp_large_prints).toBeNull(); // no traded contracts: trades not queried
    expect(get).toHaveBeenCalledTimes(4);
  });
});

describe("computeAlpacaOptionsExtras", () => {
  it("skips without credentials or a session date", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = vi.fn();
    expect(await computeAlpacaOptionsExtras(["AMD"], SESSION, { creds: null, get })).toEqual({});
    expect(await computeAlpacaOptionsExtras(["AMD"], null, { creds: CREDS, get })).toEqual({});
    expect(get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("isolates a failing ticker and logs the request count", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { get } = fakeAlpaca();
    const wrapped = vi.fn(async (url: string, h: Record<string, string>) => {
      if (url.includes("/snapshots/BAD")) throw Object.assign(new Error("alpaca 404"), { status: 404 });
      return get(url, h);
    });
    const out = await computeAlpacaOptionsExtras(["AMD", "BAD", "AMD"], SESSION, { creds: CREDS, get: wrapped, minIntervalMs: 0, now: NOW });
    expect(Object.keys(out)).toEqual(["AMD"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[alpaca-options\] 1\/2 tickers, 1 failed, \d+ requests, session 2026-11-20$/));
    log.mockRestore();
  });
});
