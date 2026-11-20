import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchVolumeData, fetchVolumeSpikeSignals } = await import(
  "@/lib/harvester/sources/volume-spike"
);

function chartResponse(
  symbol: string,
  volumes: (number | null)[],
  regularMarketVolume?: number
) {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            meta: {
              symbol,
              ...(regularMarketVolume != null
                ? { regularMarketVolume }
                : {}),
            },
            indicators: { quote: [{ volume: volumes }] },
          },
        ],
      },
    }),
  };
}

describe("fetchVolumeData — volume average computation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes average from historical bars when meta.averageDailyVolume10Day is absent", async () => {
    // 5 prior days + 1 current day
    const volumes = [100, 200, 300, 400, 500, 1000];
    mockFetch.mockResolvedValueOnce(chartResponse("TEST", volumes, 1000));

    const result = await fetchVolumeData("TEST");

    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("TEST");
    expect(result!.regularMarketVolume).toBe(1000);
    // Average of [100, 200, 300, 400, 500] = 300
    expect(result!.averageDailyVolume10Day).toBe(300);
  });

  it("uses meta.regularMarketVolume when available", async () => {
    const volumes = [100, 200, 300];
    mockFetch.mockResolvedValueOnce(chartResponse("TSLA", volumes, 999));

    const result = await fetchVolumeData("TSLA");

    expect(result!.regularMarketVolume).toBe(999);
  });

  it("falls back to last volume bar when meta.regularMarketVolume is absent", async () => {
    const volumes = [100, 200, 500];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { symbol: "XYZ" },
              indicators: { quote: [{ volume: volumes }] },
            },
          ],
        },
      }),
    });

    const result = await fetchVolumeData("XYZ");

    expect(result!.regularMarketVolume).toBe(500);
  });

  it("filters out null and zero volumes", async () => {
    // Only 100, 200, 600 are valid
    const volumes = [null, 0, 100, null, 200, 600];
    mockFetch.mockResolvedValueOnce(chartResponse("ABC", volumes, 600));

    const result = await fetchVolumeData("ABC");

    expect(result!.regularMarketVolume).toBe(600);
    // Average of [100, 200] = 150
    expect(result!.averageDailyVolume10Day).toBe(150);
  });

  it("returns null when fewer than 2 valid volumes", async () => {
    mockFetch.mockResolvedValueOnce(chartResponse("ONE", [500], 500));

    const result = await fetchVolumeData("ONE");

    expect(result).toBeNull();
  });

  it("returns null when all volumes are null/zero", async () => {
    mockFetch.mockResolvedValueOnce(chartResponse("EMPTY", [null, 0, null], 0));

    const result = await fetchVolumeData("EMPTY");

    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await fetchVolumeData("FAIL");

    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    const result = await fetchVolumeData("TIMEOUT");

    expect(result).toBeNull();
  });

  it("returns null when chart result is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chart: { result: [] } }),
    });

    const result = await fetchVolumeData("NORESULT");

    expect(result).toBeNull();
  });

  it("correctly identifies a 2x spike", async () => {
    // Prior 10 days avg = 1M, current = 2.5M → ratio 2.5x
    const prior = Array(10).fill(1_000_000);
    const volumes = [...prior, 2_500_000];
    mockFetch.mockResolvedValueOnce(chartResponse("SPIKE", volumes, 2_500_000));

    const result = await fetchVolumeData("SPIKE");

    expect(result!.regularMarketVolume).toBe(2_500_000);
    expect(result!.averageDailyVolume10Day).toBe(1_000_000);
    // Ratio would be 2.5x — above threshold
    const ratio = result!.regularMarketVolume / result!.averageDailyVolume10Day;
    expect(ratio).toBe(2.5);
  });

  it("fetches with 15d range to get enough historical data", async () => {
    mockFetch.mockResolvedValueOnce(chartResponse("CHK", [100, 200], 200));

    await fetchVolumeData("CHK");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("range=15d"),
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("interval=1d"),
      expect.any(Object)
    );
  });
});

describe("fetchVolumeSpikeSignals — rate limits (PR 1-0 review)", () => {
  const spike = () => chartResponse("X", [...Array(10).fill(1_000_000), 3_000_000], 3_000_000);
  const tooMany = { ok: false, status: 429, json: async () => ({}) };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("retries once on 429 and keeps the signal when the retry succeeds", async () => {
    mockFetch.mockResolvedValueOnce(tooMany).mockResolvedValueOnce(spike());
    const signals = await fetchVolumeSpikeSignals(["AAA"], { batchDelayMs: 0, retryDelayMs: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(signals.map((s) => s.symbol)).toEqual(["AAA"]);
  });

  it("logs ok / failed / 429 counts and does not throw when some fetches stay rate-limited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/RL1?") || url.includes("/RL2?")) return tooMany;
      if (url.includes("/BAD?")) return { ok: false, status: 500, json: async () => ({}) };
      if (url.includes("/NET?")) throw new Error("ECONNRESET");
      return spike();
    });

    const signals = await fetchVolumeSpikeSignals(["OK1", "RL1", "BAD", "RL2", "NET", "OK2"], {
      batchSize: 2,
      batchDelayMs: 0,
      retryDelayMs: 0,
    });

    expect(signals.map((s) => s.symbol)).toEqual(["OK1", "OK2"]);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("Volume Spike:"));
    expect(line).toContain("ok=2 failed=2 rate-limited(429)=2 of 6");
    // each 429 symbol was tried twice
    expect(mockFetch.mock.calls.filter(([u]) => String(u).includes("/RL1?"))).toHaveLength(2);
    warn.mockRestore();
  });

  it("waits between batches", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(async () => spike());
    const p = fetchVolumeSpikeSignals(["A", "B", "C"], { batchSize: 2, batchDelayMs: 2_000, retryDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
