import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  APEWISDOM_URL,
  AW_KEYS,
  awFeatures,
  awLine,
  awLive,
  awRowFeatures,
  awSpike,
  awSpikes,
  awSymbol,
  fetchAwFilter,
  parseAwPage,
} from "@/lib/harvester/apewisdom";
import { HttpError, resetYahooHealth, withRetry } from "@/lib/yahoo-retry";
import { isLiveStpKey } from "@/lib/health/harvest-health";

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures/apewisdom", f), "utf8")) as unknown;
const url = (filter: string, page: number) => `${APEWISDOM_URL}/${filter}/page/${page}`;

describe("parse", () => {
  it("a real page: rows, page count; null 24 h-ago mentions kept null, rank 0 → null", () => {
    const p = parseAwPage(fx("all-stocks-p2.json"))!;
    expect(p.pages).toBe(2);
    const meli = p.rows.find((r) => r.ticker === "MELI")!;
    expect(meli).toEqual({ rank: 108, ticker: "MELI", mentions: 4, upvotes: 8, rankAgo: 361, mentionsAgo: null });
    expect(parseAwPage({ results: [{ rank: 1, ticker: "X", mentions: 5, rank_24h_ago: 0 }] })!.rows[0].rankAgo).toBeNull();
    expect(parseAwPage({ error: "nope" })).toBeNull();
  });

  it("symbols: share classes dashed, crypto .X → -USD", () => {
    expect(awSymbol("brk.b", "all-stocks")).toBe("BRK-B");
    expect(awSymbol("BTC.X", "all-crypto")).toBe("BTC-USD");
  });
});

describe("aw_spike", () => {
  it("≥ 20 mentions and ≥ 3 × the mentions 24 h ago, both edges inclusive", () => {
    expect(awSpike({ mentions: 21, mentionsAgo: 7 })).toBe(true); // exactly 3×
    expect(awSpike({ mentions: 20, mentionsAgo: 6 })).toBe(true); // exactly 20
    expect(awSpike({ mentions: 20, mentionsAgo: 7 })).toBe(false); // under 3×
    expect(awSpike({ mentions: 19, mentionsAgo: 1 })).toBe(false); // under 20
    expect(awSpike({ mentions: 20, mentionsAgo: null })).toBe(true); // not ranked a day ago → 0
  });

  it("on the fixture: ASTS (52 vs 17) and VTI (27 vs 7) spike, NVDA doesn't", () => {
    const p = parseAwPage(fx("all-stocks-p1.json"))!;
    expect(p.rows.filter(awSpike).map((r) => r.ticker)).toEqual(["ASTS", "VTI"]);
  });

  it("missing gives null keys", () => {
    expect(awFeatures(undefined)).toEqual({ aw_mentions: null, aw_mentions_24h_ago: null, aw_rank: null, aw_spike: null });
    expect(Object.keys(awFeatures(undefined))).toEqual([...AW_KEYS]);
  });
});

describe("pagination", () => {
  it("reads every page up to the page count", async () => {
    const get = vi.fn(async (u: string) => (u === url("all-stocks", 1) ? fx("all-stocks-p1.json") : fx("all-stocks-p2.json")));
    const r = await fetchAwFilter("all-stocks", get);
    expect(get.mock.calls.map((c) => c[0])).toEqual([url("all-stocks", 1), url("all-stocks", 2)]);
    expect(r).toMatchObject({ pages: 2, complete: true });
    expect(r.bySymbol.size).toBe(8);
    expect(r.bySymbol.get("MELI")?.mentions).toBe(4);
  });

  it("a later page failing keeps what was read (incomplete); page 1 failing throws", async () => {
    const get = vi.fn(async (u: string) => {
      if (u.endsWith("/2")) throw new Error("apewisdom 500");
      return fx("all-stocks-p1.json");
    });
    expect(await fetchAwFilter("all-stocks", get)).toMatchObject({ pages: 1, complete: false });
    await expect(fetchAwFilter("all-stocks", async () => ({ nope: 1 }))).rejects.toThrow(/unexpected/);
  });

  it("the page cap holds", async () => {
    const get = vi.fn(async () => ({ pages: 50, results: [] }));
    await fetchAwFilter("wallstreetbets", get, 3);
    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe("rate-limit backoff", () => {
  beforeEach(() => resetYahooHealth());

  it("a 429 is retried with the shared backoff (Retry-After honoured), then the page is read", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ === 0) throw new HttpError(429, 0);
      return fx("all-crypto-p1.json");
    });
    const get = () => withRetry(fn, { label: "apewisdom", baseDelayMs: 0 });
    const r = await fetchAwFilter("all-crypto", get);
    expect(fn).toHaveBeenCalledTimes(2);
    expect([...r.bySymbol.keys()]).toEqual(["BTC-USD", "ETH-USD", "ECC-USD"]);
  });
});

describe("live", () => {
  const get = async (u: string) => {
    if (u.includes("wallstreetbets")) throw new Error("apewisdom 503");
    if (u.includes("all-crypto")) return fx("all-crypto-p1.json");
    return u.endsWith("/1") ? fx("all-stocks-p1.json") : fx("all-stocks-p2.json");
  };

  it("each filter fails on its own; row features from all-stocks (and crypto rows from all-crypto)", async () => {
    const aw = await awLive(get);
    expect(aw.failed).toEqual(["wallstreetbets"]);
    expect(awRowFeatures(aw, "asts")).toEqual({ aw_mentions: 52, aw_mentions_24h_ago: 17, aw_rank: 10, aw_spike: true });
    expect(awRowFeatures(aw, "ZZZZ")).toEqual({ aw_mentions: null, aw_mentions_24h_ago: null, aw_rank: null, aw_spike: null });
    expect(awRowFeatures(aw, "BTC-USD", true)).toMatchObject({ aw_rank: 1 });
    // A failed filter leaves the keys off
    expect(awRowFeatures({ ...aw, stocks: null }, "ASTS")).toEqual({});
  });

  it("spikes are the Reddit hits; the health line compares with the scraper and warns on a failed filter", async () => {
    const aw = await awLive(get);
    const spikes = awSpikes(aw);
    expect([...spikes]).toEqual(["ASTS", "VTI"]);
    const { line, warn } = awLine(aw, spikes, new Set(["ASTS", "GME"]));
    expect(warn).toBe(true);
    expect(line).toContain("all-stocks 8 (2 pages), wallstreetbets failed, all-crypto 3 (1 pages); spikes 2; Reddit scraper tickers 2, both 1");
    expect(line).toContain("WARNING: wallstreetbets failed");
  });

  it("aw_* keys are log-only live keys", () => {
    for (const k of [...AW_KEYS, "aw_wsb_mentions"]) expect(isLiveStpKey(k), k).toBe(true);
  });
});
