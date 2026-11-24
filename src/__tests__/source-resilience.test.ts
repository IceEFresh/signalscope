import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  withYahooRetry,
  parseRetryAfter,
  HttpError,
  resetYahooHealth,
  yahooHealth,
  MAX_RETRY_AFTER_MS,
} from "@/lib/yahoo-retry";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const { fetchCongressSignals } = await import("@/lib/harvester/sources/congress");
const { fetchStockTwitsSignals } = await import("@/lib/harvester/sources/stocktwits");

const resp = (status: number, body = "", headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

// A TrendSpider page with two trending tickers, in the x-data form the parser reads.
const trendspiderPage = ["PLTR", "SOFI"]
  .map((s) => `<div x-data="ticker({&quot;symbol&quot;:&quot;${s}&quot;,&quot;lastPrice&quot;:20.5,&quot;priceChangePercent&quot;:4.2})"></div>`)
  .join("");

beforeEach(() => {
  mockFetch.mockReset();
  resetYahooHealth();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("withRetry (S2)", () => {
  it("is the same function as the 1e withYahooRetry", () => {
    expect(withYahooRetry).toBe(withRetry);
  });

  it("parses Retry-After as seconds or an HTTP date, capped at 60 s", () => {
    expect(parseRetryAfter("7")).toBe(7_000);
    expect(parseRetryAfter("600")).toBe(MAX_RETRY_AFTER_MS);
    const now = Date.parse("2027-01-01T00:00:00Z");
    expect(parseRetryAfter("Fri, 01 Jan 2027 00:00:20 GMT", now)).toBe(20_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("waits the Retry-After of a 429 before retrying, even with no base backoff", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new HttpError(429, 5_000);
        return "ok";
      },
      { baseDelayMs: 0, label: "t" },
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(2);
    vi.useRealTimers();
  });
});

describe("StockTwits (TrendSpider): retry only, no fallback", () => {
  it("recovers from 429 then 200", async () => {
    mockFetch.mockResolvedValueOnce(resp(429)).mockResolvedValueOnce(resp(200, trendspiderPage));
    const sigs = await fetchStockTwitsSignals();
    expect(sigs.map((s) => s.symbol)).toEqual(["PLTR", "SOFI"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(yahooHealth().stocktwits).toEqual({ calls: 1, retried: 1, failed: 0 });
  });

  it("recovers from 502 then 200", async () => {
    mockFetch.mockResolvedValueOnce(resp(502)).mockResolvedValueOnce(resp(200, trendspiderPage));
    expect(await fetchStockTwitsSignals()).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retries are used and returns nothing", async () => {
    mockFetch.mockResolvedValue(resp(502));
    expect(await fetchStockTwitsSignals()).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(yahooHealth().stocktwits).toEqual({ calls: 1, retried: 2, failed: 1 });
  });

  it("does not retry a non-transient error", async () => {
    mockFetch.mockResolvedValue(resp(404));
    expect(await fetchStockTwitsSignals()).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("Capitol Trades: retry", () => {
  it("retries a 429 and reads the page that follows", async () => {
    mockFetch.mockResolvedValueOnce(resp(429, "", { "retry-after": "0" })).mockResolvedValueOnce(resp(200, "<html></html>"));
    await fetchCongressSignals();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(yahooHealth().capitoltrades).toEqual({ calls: 1, retried: 1, failed: 0 });
  });

  it("retries a 502 and gives up after three attempts", async () => {
    mockFetch.mockResolvedValue(resp(502));
    expect(await fetchCongressSignals()).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(yahooHealth().capitoltrades).toEqual({ calls: 1, retried: 2, failed: 1 });
  });

  it("retries a network error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(resp(200, "<html></html>"));
    await fetchCongressSignals();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
