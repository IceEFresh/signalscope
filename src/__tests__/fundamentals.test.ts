import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock yahoo-finance2
const mockQuote = vi.fn();
const mockQuoteSummary = vi.fn();
vi.mock("yahoo-finance2", () => {
  return {
    default: class {
      quote = mockQuote;
      quoteSummary = mockQuoteSummary;
    },
  };
});

const { fetchFundamentals } = await import("@/lib/harvester/fundamentals");

describe("fetchFundamentals — data extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: quoteSummary returns empty data
    mockQuoteSummary.mockResolvedValue({
      assetProfile: null,
      defaultKeyStatistics: null,
    });
  });

  it("returns empty map for empty symbols", async () => {
    const result = await fetchFundamentals([]);
    expect(result.size).toBe(0);
  });

  it("extracts price, marketCap, exchange, name from Yahoo quote", async () => {
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "PTON",
        regularMarketPrice: 8.50,
        marketCap: 3_000_000_000,
        fullExchangeName: "NASDAQ",
        longName: "Peloton Interactive Inc",
        fiftyTwoWeekLow: 4.0,
        fiftyTwoWeekHigh: 15.0,
      },
    ]);

    const result = await fetchFundamentals(["PTON"]);
    const pton = result.get("PTON")!;
    expect(pton.price).toBe(8.50);
    expect(pton.marketCap).toBe(3_000_000_000);
    expect(pton.exchange).toBe("NASDAQ");
    expect(pton.name).toBe("Peloton Interactive Inc");
    expect(pton.fiftyTwoWeekRange).toBe("4.00 - 15.00");
  });

  it("extracts sector when available", async () => {
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "PTON",
        regularMarketPrice: 8.50,
        marketCap: 3_000_000_000,
        sector: "Consumer Cyclical",
      },
    ]);

    const result = await fetchFundamentals(["PTON"]);
    expect(result.get("PTON")!.sector).toBe("Consumer Cyclical");
  });

  it("retries a rate-limited quote batch instead of dropping it (PR 1e)", async () => {
    mockQuote
      .mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 }))
      .mockResolvedValueOnce([{ symbol: "AMD", regularMarketPrice: 120 }]);
    const amd = (await fetchFundamentals(["AMD"])).get("AMD");
    expect(amd?.price).toBe(120);
    expect(mockQuote).toHaveBeenCalledTimes(2);
  });

  it("keeps the industry from assetProfile (PR 1f)", async () => {
    mockQuote.mockResolvedValueOnce([{ symbol: "NVDA", regularMarketPrice: 180 }]);
    mockQuoteSummary.mockResolvedValueOnce({
      assetProfile: { sector: "Technology", industry: "Semiconductors" },
      defaultKeyStatistics: null,
    });
    const nvda = (await fetchFundamentals(["NVDA"])).get("NVDA")!;
    expect(nvda.sector).toBe("Technology");
    expect(nvda.industry).toBe("Semiconductors");
  });

  it("extracts earningsDate from earningsTimestamp", async () => {
    // 1704067200 = 2024-01-01T00:00:00Z
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "PTON",
        regularMarketPrice: 8.50,
        earningsTimestamp: 1704067200,
      },
    ]);

    const result = await fetchFundamentals(["PTON"]);
    expect(result.get("PTON")!.earningsDate).toBe("2024-01-01");
  });

  it("extracts earnings fields from the Date objects yahoo-finance2 returns (1b fix)", async () => {
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "AMD",
        regularMarketPrice: 120,
        earningsTimestamp: new Date("2026-11-24T21:05:00Z"),
        earningsTimestampStart: new Date("2026-11-24T00:00:00Z"),
        earningsTimestampEnd: new Date("2026-11-25T00:00:00Z"),
        isEarningsDateEstimate: true,
      },
    ]);

    const amd = (await fetchFundamentals(["AMD"])).get("AMD")!;
    expect(amd.earningsDate).toBe("2026-11-24");
    expect(amd.earningsTs).toBe(Date.parse("2026-11-24T21:05:00Z") / 1000);
    expect(amd.earningsTsStart).toBe(Date.parse("2026-11-24T00:00:00Z") / 1000);
    expect(amd.earningsTsEnd).toBe(Date.parse("2026-11-25T00:00:00Z") / 1000);
    expect(amd.isEarningsDateEstimate).toBe(true);
  });

  it("extracts floatShares and sharesOutstanding", async () => {
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "PTON",
        regularMarketPrice: 8.50,
        floatShares: 300_000_000,
        sharesOutstanding: 350_000_000,
      },
    ]);

    const result = await fetchFundamentals(["PTON"]);
    const pton = result.get("PTON")!;
    expect(pton.floatShares).toBe(300_000_000);
    expect(pton.sharesOutstanding).toBe(350_000_000);
  });

  it("handles missing optional fields gracefully", async () => {
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "PTON",
        regularMarketPrice: 8.50,
        // No sector, earningsTimestamp, floatShares, sharesOutstanding
      },
    ]);

    const result = await fetchFundamentals(["PTON"]);
    const pton = result.get("PTON")!;
    expect(pton.sector).toBeUndefined();
    expect(pton.earningsDate).toBeUndefined();
    expect(pton.floatShares).toBeNull();
    expect(pton.sharesOutstanding).toBeNull();
    expect(pton.shortFloat).toBeNull();
  });

  it("handles null price and marketCap", async () => {
    mockQuote.mockResolvedValueOnce([
      {
        symbol: "PTON",
        // No regularMarketPrice or marketCap
      },
    ]);

    const result = await fetchFundamentals(["PTON"]);
    const pton = result.get("PTON")!;
    expect(pton.price).toBeNull();
    expect(pton.marketCap).toBeNull();
  });

  it("extracts shortFloat from quoteSummary defaultKeyStatistics", async () => {
    mockQuote.mockResolvedValueOnce([{ symbol: "PLUG", regularMarketPrice: 2.5 }]);
    mockQuoteSummary.mockResolvedValueOnce({
      assetProfile: null,
      defaultKeyStatistics: { shortPercentOfFloat: 0.25 },
    });
    const result = await fetchFundamentals(["PLUG"]);
    expect(result.get("PLUG")!.shortFloat).toBe(0.25);
  });
});
