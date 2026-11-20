import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseNasdaqTraded } from "@/lib/harvester/universe/symbol-directory";

const sample = readFileSync(join(__dirname, "fixtures/universe/nasdaqtraded-sample.txt"), "utf8");

describe("parseNasdaqTraded", () => {
  it("keeps common stock and ADRs, drops ETFs, test issues, warrants, units, rights and preferreds", () => {
    const symbols = parseNasdaqTraded(sample).map((d) => d.symbol);
    expect(symbols).toEqual(["AAPL", "AMD", "BRK-B", "PLTR", "SOFI", "TSM", "AACG", "BRK-A"]);
  });

  it("converts class suffixes to Yahoo form", () => {
    const brk = parseNasdaqTraded(sample).find((d) => d.symbol === "BRK-B");
    expect(brk?.listingExchange).toBe("N");
  });

  it("returns [] for an empty or unexpected file", () => {
    expect(parseNasdaqTraded("")).toEqual([]);
    expect(parseNasdaqTraded("<html>Service Unavailable</html>")).toEqual([]);
  });
});
