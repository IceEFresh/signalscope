import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  backoffMs,
  isRetryableError,
  isRetryableStatus,
  resetYahooHealth,
  withYahooRetry,
  yahooHealth,
  yahooHealthSummary,
} from "@/lib/yahoo-retry";

beforeEach(() => resetYahooHealth());

describe("retry classification (PLAN.md 1e)", () => {
  it("retries 429 and 5xx, not other 4xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(null)).toBe(false);
  });

  it("classifies yahoo-finance2 / fetch errors by status or message", () => {
    expect(isRetryableError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRetryableError(new Error("Too Many Requests"))).toBe(true);
    expect(isRetryableError(new Error("HTTPError: 502 Bad Gateway"))).toBe(true);
    expect(isRetryableError(new Error("Yahoo Finance timeout after 10000ms"))).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("HTTPError: 404 Not Found"))).toBe(false);
    expect(isRetryableError(new Error("Failed Yahoo Schema validation"))).toBe(false);
  });

  it("backs off exponentially with up to 25% jitter", () => {
    expect(backoffMs(0, 1000, () => 0)).toBe(1000);
    expect(backoffMs(1, 1000, () => 0)).toBe(2000);
    expect(backoffMs(2, 1000, () => 1)).toBe(5000);
  });
});

describe("withYahooRetry", () => {
  it("retries transient failures and returns the eventual result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("429 Too Many Requests")).mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue("ok");
    await expect(withYahooRetry(fn, { baseDelayMs: 0, label: "quote" })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(yahooHealth().quote).toEqual({ calls: 1, retried: 2, failed: 0 });
  });

  it("gives up after the retry budget and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));
    await expect(withYahooRetry(fn, { baseDelayMs: 0, retries: 2, label: "options" })).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(yahooHealth().options).toEqual({ calls: 1, retried: 2, failed: 1 });
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("404 Not Found"));
    await expect(withYahooRetry(fn, { baseDelayMs: 0, label: "quote" })).rejects.toThrow("404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits between attempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue(1);
    const p = withYahooRetry(fn, { baseDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1250);
    await expect(p).resolves.toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("summarizes calls, retries and failures per label", async () => {
    await withYahooRetry(async () => 1, { label: "chart" });
    await withYahooRetry(vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue(1), { baseDelayMs: 0, label: "chart" });
    expect(yahooHealthSummary()).toBe("[yahoo] chart: 2 calls, 1 retried, 0 failed");
    resetYahooHealth();
    expect(yahooHealthSummary()).toBe("[yahoo] no calls");
  });
});
