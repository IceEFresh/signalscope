import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEftsForm4Dates,
  eftsTotal,
  classifyInsider,
  fetchInsiderForm4Dates,
  annotateInsiderClasses,
  insiderClassFeatures,
  INSIDER_CLASS_BASIS,
} from "@/lib/harvester/insider-class";
import { mergeWatchEntry, strongerInsiderClass, watchEntriesFromSignals } from "@/lib/harvester/universe/watch";
import type { RawSignal } from "@/lib/harvester/types";

// EDGAR full-text search, Form 4s naming "Huang Jen Hsun", 2021-01-01 to 2026-11-20 (first page of 110).
const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/edgar/efts-form4-huang-nvda.json"), "utf8"),
) as unknown;

describe("parseEftsForm4Dates", () => {
  it("keeps only this issuer's filings and returns YYYY-MM-DD dates", () => {
    const dates = parseEftsForm4Dates(fixture, "NVDA");
    expect(dates.length).toBe(58);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(parseEftsForm4Dates(fixture, "nvda")).toEqual(dates);
  });

  it("returns nothing for another ticker or a malformed response", () => {
    expect(parseEftsForm4Dates(fixture, "AMD")).toEqual([]);
    expect(parseEftsForm4Dates(null, "NVDA")).toEqual([]);
    expect(parseEftsForm4Dates({ hits: {} }, "NVDA")).toEqual([]);
  });

  it("reads the total hit count", () => {
    expect(eftsTotal(fixture)).toBe(110);
    expect(eftsTotal({})).toBe(0);
  });
});

describe("classifyInsider", () => {
  const history = parseEftsForm4Dates(fixture, "NVDA");

  it("is routine when each of the 3 prior years has a trade in the same month", () => {
    // Huang has NVDA Form 4s every March in 2022-2024
    expect(classifyInsider(history, "2025-03-14")).toEqual({
      insiderClass: "routine",
      priorYearsWithTrades: 3,
      priorYearsSameMonth: 3,
    });
  });

  it("is opportunistic when the month breaks the pattern", () => {
    const r = classifyInsider(history, "2025-05-02");
    expect(r.insiderClass).toBe("opportunistic");
    expect(r.priorYearsSameMonth).toBe(0);
  });

  it("is opportunistic when only some prior years match the month", () => {
    // July: 2024 only
    expect(classifyInsider(history, "2025-07-01").insiderClass).toBe("opportunistic");
  });

  it("is unclassified without trades in all 3 prior years", () => {
    // 2020 is outside the fixture's range
    expect(classifyInsider(history, "2023-03-10")).toMatchObject({ insiderClass: "unclassified", priorYearsWithTrades: 2 });
    expect(classifyInsider([], "2025-03-10").insiderClass).toBe("unclassified");
  });

  it("ignores trades in the current year", () => {
    const h = ["2025-03-01", "2025-01-15", "2024-02-01", "2023-02-01"];
    expect(classifyInsider(h, "2025-03-20").insiderClass).toBe("unclassified");
  });
});

describe("fetchInsiderForm4Dates", () => {
  it("pages through results from Jan 1 three years back, sending the user agent", async () => {
    const urls: string[] = [];
    const agents: string[] = [];
    const get = vi.fn(async (url: string, ua: string) => {
      urls.push(url);
      agents.push(ua);
      return urls.length === 1 ? fixture : { hits: { total: { value: 110 }, hits: [] } };
    });
    const dates = await fetchInsiderForm4Dates("Huang Jen Hsun", "NVDA", "2025-03-14", "TestAgent test@example.com", get);
    expect(get).toHaveBeenCalledTimes(2);
    const first = new URL(urls[0]);
    expect(first.hostname).toBe("efts.sec.gov");
    expect(first.searchParams.get("q")).toBe('"Huang Jen Hsun"');
    expect(first.searchParams.get("forms")).toBe("4");
    expect(first.searchParams.get("startdt")).toBe("2022-01-01");
    expect(first.searchParams.get("enddt")).toBe("2025-03-14");
    expect(first.searchParams.get("from")).toBe("0");
    expect(new URL(urls[1]).searchParams.get("from")).toBe("100");
    expect(agents.every((a) => a === "TestAgent test@example.com")).toBe(true);
    expect(dates.length).toBe(58);
  });
});

function insider(over: Partial<RawSignal> = {}): RawSignal {
  return {
    symbol: "NVDA",
    source: "SEC_INSIDER",
    author: "Huang Jen Hsun",
    tradeDate: "2025-03-14",
    filedAt: "2025-03-17",
    purchaseValue: 100_000,
    filingKey: "insider:NVDA|Huang Jen Hsun|2025-03-14|1|1",
    ...over,
  };
}

describe("annotateInsiderClasses", () => {
  const onePage = async (url: string) =>
    new URL(url).searchParams.get("from") === "0" ? fixture : { hits: { total: { value: 110 }, hits: [] } };

  it("skips everything without SEC_USER_AGENT", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = vi.fn(onePage);
    const sigs = [insider()];
    await annotateInsiderClasses(sigs, { userAgent: "", get });
    expect(get).not.toHaveBeenCalled();
    expect(sigs[0].insiderClass).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("annotates insider signals, one query per insider, ticker and date", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const get = vi.fn(onePage);
    const sigs: RawSignal[] = [
      insider(),
      insider({ filingKey: "dup" }),
      insider({ tradeDate: "2025-05-02", filingKey: "may" }),
      { symbol: "NVDA", source: "REDDIT" },
    ];
    await annotateInsiderClasses(sigs, { userAgent: "UA", get });
    expect(get).toHaveBeenCalledTimes(4); // 2 distinct (insider, date) keys x 2 pages
    expect(sigs.map((s) => s.insiderClass)).toEqual(["routine", "routine", "opportunistic", undefined]);
    expect(sigs[0].insiderPriorYears).toBe(3);
    log.mockRestore();
  });

  it("falls back to the filing date and leaves an insider unannotated when EDGAR fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const get = vi.fn(async () => {
      throw new Error("efts 503");
    });
    const sigs = [insider({ tradeDate: undefined })];
    await annotateInsiderClasses(sigs, { userAgent: "UA", get });
    expect(get).toHaveBeenCalledTimes(1);
    expect(new URL((get.mock.calls[0] as unknown as [string])[0]).searchParams.get("enddt")).toBe("2025-03-17");
    expect(sigs[0].insiderClass).toBeUndefined();
    log.mockRestore();
  });
});

describe("insiderClassFeatures", () => {
  it("is empty for a ticker with no insider signals", () => {
    expect(insiderClassFeatures([{ symbol: "X", source: "REDDIT" }])).toEqual({});
  });

  it("counts classes and picks opportunistic over routine", () => {
    const f = insiderClassFeatures([
      insider({ insiderClass: "routine" }),
      insider({ insiderClass: "opportunistic" }),
      insider({ insiderClass: "unclassified" }),
      insider(),
    ]);
    expect(f).toEqual({
      insider_opportunistic_count: 1,
      insider_routine_count: 1,
      insider_unclassified_count: 1,
      insider_class: "opportunistic",
      insider_class_basis: INSIDER_CLASS_BASIS,
    });
  });

  it("leaves the class null when no signal was annotated", () => {
    expect(insiderClassFeatures([insider()])).toMatchObject({ insider_class: null, insider_class_basis: null });
  });
});

describe("watch rows carry the insider class", () => {
  const now = new Date("2025-03-20T12:00:00Z");

  it("ranks opportunistic over routine over unclassified", () => {
    expect(strongerInsiderClass("routine", "opportunistic")).toBe("opportunistic");
    expect(strongerInsiderClass("unclassified", "routine")).toBe("routine");
    expect(strongerInsiderClass(null, "unclassified")).toBe("unclassified");
    expect(strongerInsiderClass(null, undefined)).toBeNull();
  });

  it("sets the class on a new row and upgrades it when an opportunistic filing joins", () => {
    const [a] = watchEntriesFromSignals([insider({ insiderClass: "routine" })], () => true);
    expect(a.insiderClass).toBe("routine");
    const row = mergeWatchEntry(null, a, now)!;
    expect(row.insiderClass).toBe("routine");
    const [b] = watchEntriesFromSignals(
      [insider({ author: "Kress Colette", filingKey: "k2", insiderClass: "opportunistic" })],
      () => true,
    );
    expect(mergeWatchEntry(row, b, now)!.insiderClass).toBe("opportunistic");
    const [c] = watchEntriesFromSignals([insider({ filingKey: "k3", insiderClass: "routine" })], () => true);
    expect(mergeWatchEntry({ ...row, insiderClass: "opportunistic" }, c, now)!.insiderClass).toBe("opportunistic");
  });
});
