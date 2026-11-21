import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEftsForm4Filings,
  parseForm4OpenMarketDates,
  eftsTotal,
  classifyInsider,
  classifyFromFilings,
  fetchInsiderForm4Filings,
  annotateInsiderClasses,
  insiderClassFeatures,
  EdgarClient,
  INSIDER_CLASS_BASIS,
  type Form4Filing,
} from "@/lib/harvester/insider-class";
import { mergeWatchEntry, strongerInsiderClass, watchEntriesFromSignals } from "@/lib/harvester/universe/watch";
import type { RawSignal } from "@/lib/harvester/types";

const fx = (f: string) => readFileSync(join(__dirname, "fixtures/edgar", f), "utf8");
// EDGAR full-text search, Form 4s naming "Huang Jen Hsun", 2021-01-01 to 2026-11-20 (first page of 110).
const efts = JSON.parse(fx("efts-form4-huang-nvda.json")) as unknown;
// Real Form 4 XMLs: open-market purchase (BOLD), Huang sale, Huang grant, Huang option exercise.
const xmlP = fx("form4-purchase-P.xml");
const xmlS = fx("form4-huang-sale-S.xml");
const xmlA = fx("form4-huang-grant-A.xml");
const xmlM = fx("form4-huang-exercise-M.xml");

/** A one-row Form 4 XML with the real element layout. */
function form4(rows: Array<[date: string, code: string]>): string {
  const tx = rows
    .map(
      ([d, c]) =>
        `<nonDerivativeTransaction><transactionDate><value>${d}</value></transactionDate>` +
        `<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${c}</transactionCode></transactionCoding></nonDerivativeTransaction>`,
    )
    .join("");
  return `<ownershipDocument><nonDerivativeTable>${tx}</nonDerivativeTable></ownershipDocument>`;
}

describe("Form 4 XML parsing", () => {
  it("counts open-market purchases (P)", () => {
    expect(parseForm4OpenMarketDates(xmlP)).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
  });
  it("counts open-market sales (S)", () => {
    const d = parseForm4OpenMarketDates(xmlS);
    expect(d.length).toBe(8);
    expect(d.every((x) => x.startsWith("2024-07"))).toBe(true);
  });
  it("ignores grants (A) and option exercises (M), including derivative rows", () => {
    expect(parseForm4OpenMarketDates(xmlA)).toEqual([]);
    expect(parseForm4OpenMarketDates(xmlM)).toEqual([]);
  });
});

describe("parseEftsForm4Filings", () => {
  it("keeps only this issuer's filings and builds each XML URL from the issuer CIK", () => {
    const f = parseEftsForm4Filings(efts, "NVDA");
    expect(f.length).toBe(58);
    expect(f[0]).toEqual({
      periodEnding: "2021-01-04",
      xmlUrl: "https://www.sec.gov/Archives/edgar/data/1045810/000104581021000004/wf-form4_160997472916849.xml",
    });
    expect(parseEftsForm4Filings(efts, "nvda")).toEqual(f);
  });
  it("returns nothing for another ticker or a malformed response", () => {
    expect(parseEftsForm4Filings(efts, "AMD")).toEqual([]);
    expect(parseEftsForm4Filings(null, "NVDA")).toEqual([]);
  });
  it("reads the total hit count", () => {
    expect(eftsTotal(efts)).toBe(110);
    expect(eftsTotal({})).toBe(0);
  });
});

describe("classifyInsider (pure rule)", () => {
  it("routine, opportunistic and unclassified", () => {
    const h = ["2024-03-05", "2023-03-09", "2022-03-01"];
    expect(classifyInsider(h, "2025-03-14").insiderClass).toBe("routine");
    expect(classifyInsider(h, "2025-05-02").insiderClass).toBe("opportunistic");
    expect(classifyInsider(["2024-03-05", "2023-03-09"], "2025-03-14")).toMatchObject({ insiderClass: "unclassified", priorYearsWithTrades: 2 });
  });
  it("ignores trades in the current year", () => {
    expect(classifyInsider(["2025-03-01", "2024-02-01", "2023-02-01"], "2025-03-20").insiderClass).toBe("unclassified");
  });
});

/** Fake EDGAR: each filing URL returns the XML given for it, grant-only by default. */
function fakeEdgar(byUrl: Record<string, string>, effts: unknown = efts) {
  const get = vi.fn(async (url: string, _ua: string) => {
    void _ua;
    if (url.startsWith("https://efts.sec.gov/")) {
      return JSON.stringify(new URL(url).searchParams.get("from") === "0" ? effts : { hits: { total: { value: 110 }, hits: [] } });
    }
    return byUrl[url] ?? xmlA;
  });
  return { get, client: new EdgarClient("UA", get, 0) };
}

const filing = (periodEnding: string, n: number): Form4Filing => ({ periodEnding, xmlUrl: `https://www.sec.gov/x/${n}.xml` });

describe("classifyFromFilings (open-market basis)", () => {
  const filings = [
    filing("2024-03-02", 1), filing("2024-03-20", 2), filing("2024-06-01", 3),
    filing("2023-03-04", 4), filing("2023-09-01", 5),
    filing("2022-01-10", 6), filing("2022-03-08", 7),
  ];

  it("routine when every prior year has a P/S in the trade's month; same-month filings are read first", async () => {
    const { get, client } = fakeEdgar({
      [filings[0].xmlUrl]: form4([["2024-03-02", "S"]]),
      [filings[3].xmlUrl]: form4([["2023-03-04", "P"]]),
      [filings[6].xmlUrl]: form4([["2022-03-08", "S"]]),
    });
    const r = await classifyFromFilings(filings, "2025-03-14", client);
    expect(r).toMatchObject({ insiderClass: "routine", priorYearsWithTrades: 3, priorYearsSameMonth: 3, capHit: false });
    expect(r.xmlFetched).toBe(3); // one per year, the rest skipped
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("a grant-only filing does not count as a trade year", async () => {
    const { client } = fakeEdgar({
      [filings[0].xmlUrl]: form4([["2024-03-02", "A"]]),
      [filings[1].xmlUrl]: form4([["2024-03-20", "M"], ["2024-03-20", "F"]]),
      [filings[3].xmlUrl]: form4([["2023-03-04", "P"]]),
      [filings[6].xmlUrl]: form4([["2022-03-08", "S"]]),
    });
    const r = await classifyFromFilings(filings, "2025-03-14", client);
    // 2024: March has only A/M/F, June filing is grant-only (default) -> no trade year
    expect(r).toMatchObject({ insiderClass: "unclassified", priorYearsWithTrades: 0 });
    expect(r.xmlFetched).toBe(3); // stops after 2024 fails
  });

  it("opportunistic when trade years exist but not all in the trade's month", async () => {
    const { client } = fakeEdgar({
      [filings[0].xmlUrl]: form4([["2024-03-02", "S"]]),
      [filings[4].xmlUrl]: form4([["2023-09-01", "S"]]),
      [filings[6].xmlUrl]: form4([["2022-03-08", "P"]]),
    });
    const r = await classifyFromFilings(filings, "2025-03-14", client);
    expect(r).toMatchObject({ insiderClass: "opportunistic", priorYearsWithTrades: 3, priorYearsSameMonth: 2 });
  });

  it("hitting the cap gives unclassified, not a guess", async () => {
    const { client } = fakeEdgar({});
    const r = await classifyFromFilings(filings, "2025-03-14", client, 2);
    expect(r).toMatchObject({ insiderClass: "unclassified", capHit: true, xmlFetched: 2 });
  });
});

describe("fetchInsiderForm4Filings", () => {
  it("queries prior years only, pages through results and sends the user agent", async () => {
    const { get, client } = fakeEdgar({});
    const f = await fetchInsiderForm4Filings("Huang Jen Hsun", "NVDA", "2025-07-14", client);
    expect(get).toHaveBeenCalledTimes(2);
    const first = new URL(get.mock.calls[0][0]);
    expect(first.hostname).toBe("efts.sec.gov");
    expect(first.searchParams.get("q")).toBe('"Huang Jen Hsun"');
    expect(first.searchParams.get("startdt")).toBe("2022-01-01");
    expect(first.searchParams.get("enddt")).toBe("2025-02-15");
    expect(new URL(get.mock.calls[1][0]).searchParams.get("from")).toBe("100");
    expect(get.mock.calls.every((c) => c[1] === "UA")).toBe(true);
    expect(f.length).toBe(58);
    expect(client.requests).toBe(2);
  });

  it("never looks past the trade date", async () => {
    const { get, client } = fakeEdgar({});
    await fetchInsiderForm4Filings("X", "NVDA", "2025-01-10", client);
    expect(new URL(get.mock.calls[0][0]).searchParams.get("enddt")).toBe("2025-01-10");
  });
});

describe("EdgarClient pacing", () => {
  it("spaces requests by the minimum interval", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => "");
    const c = new EdgarClient("UA", get, 150);
    const p = Promise.all([c.fetch("a"), c.fetch("b"), c.fetch("c")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(get).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

function insider(over: Partial<RawSignal> = {}): RawSignal {
  return {
    symbol: "NVDA",
    source: "SEC_INSIDER",
    author: "Huang Jen Hsun",
    tradeDate: "2025-07-14",
    filedAt: "2025-07-16",
    purchaseValue: 100_000,
    filingKey: "insider:NVDA|Huang Jen Hsun|2025-07-14|1|1",
    ...over,
  };
}

describe("annotateInsiderClasses", () => {
  it("skips everything without SEC_USER_AGENT", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { get } = fakeEdgar({});
    const sigs = [insider()];
    await annotateInsiderClasses(sigs, { userAgent: "", get, minIntervalMs: 0 });
    expect(get).not.toHaveBeenCalled();
    expect(sigs[0].insiderClass).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("annotates once per insider, ticker and date, and logs the summary line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // Huang's real July 2024 sale filing; everything else grant-only -> 2023 has no trade -> unclassified
    const { get } = fakeEdgar({
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581024000211/wk-form4_1720556648.xml": xmlS,
    });
    const sigs: RawSignal[] = [insider(), insider({ filingKey: "dup" }), { symbol: "NVDA", source: "REDDIT" }];
    await annotateInsiderClasses(sigs, { userAgent: "UA", get, minIntervalMs: 0 });
    expect(sigs.map((s) => s.insiderClass)).toEqual(["unclassified", "unclassified", undefined]);
    expect(sigs[0].insiderPriorYears).toBe(1);
    const efftsCalls = get.mock.calls.filter((c) => c[0].startsWith("https://efts")).length;
    expect(efftsCalls).toBe(2); // one insider key, two pages
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[insider-class\] 1 insiders, 0 routine \/ 0 opportunistic \/ 1 unclassified, \d+ EDGAR requests$/),
    );
    log.mockRestore();
  });

  it("leaves an insider unannotated when EDGAR fails, falling back to the filing date", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const get = vi.fn(async () => {
      throw new Error("edgar 503");
    });
    const sigs = [insider({ tradeDate: undefined, filedAt: "2025-01-20" })];
    await annotateInsiderClasses(sigs, { userAgent: "UA", get, minIntervalMs: 0 });
    expect(new URL((get.mock.calls[0] as unknown as [string])[0]).searchParams.get("enddt")).toBe("2025-01-20");
    expect(sigs[0].insiderClass).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
    log.mockRestore();
  });
});

describe("insiderClassFeatures", () => {
  it("is empty for a ticker with no insider signals", () => {
    expect(insiderClassFeatures([{ symbol: "X", source: "REDDIT" }])).toEqual({});
  });
  it("counts classes, picks opportunistic over routine, and records the open-market basis", () => {
    expect(
      insiderClassFeatures([
        insider({ insiderClass: "routine" }),
        insider({ insiderClass: "opportunistic" }),
        insider({ insiderClass: "unclassified" }),
        insider(),
      ]),
    ).toEqual({
      insider_opportunistic_count: 1,
      insider_routine_count: 1,
      insider_unclassified_count: 1,
      insider_class: "opportunistic",
      insider_class_basis: "form4_open_market_ps",
    });
    expect(INSIDER_CLASS_BASIS).toBe("form4_open_market_ps");
  });
  it("leaves the class null when no signal was annotated", () => {
    expect(insiderClassFeatures([insider()])).toMatchObject({ insider_class: null, insider_class_basis: null });
  });
});

describe("watch rows carry the insider class", () => {
  const now = new Date("2025-07-20T12:00:00Z");
  it("ranks opportunistic over routine over unclassified", () => {
    expect(strongerInsiderClass("routine", "opportunistic")).toBe("opportunistic");
    expect(strongerInsiderClass("unclassified", "routine")).toBe("routine");
    expect(strongerInsiderClass(null, "unclassified")).toBe("unclassified");
    expect(strongerInsiderClass(null, undefined)).toBeNull();
  });
  it("sets the class on a new row and upgrades it when an opportunistic filing joins", () => {
    const [a] = watchEntriesFromSignals([insider({ insiderClass: "routine" })], () => true);
    const row = mergeWatchEntry(null, a, now)!;
    expect(row.insiderClass).toBe("routine");
    const [b] = watchEntriesFromSignals([insider({ author: "Kress Colette", filingKey: "k2", insiderClass: "opportunistic" })], () => true);
    expect(mergeWatchEntry(row, b, now)!.insiderClass).toBe("opportunistic");
    const [c] = watchEntriesFromSignals([insider({ filingKey: "k3", insiderClass: "routine" })], () => true);
    expect(mergeWatchEntry({ ...row, insiderClass: "opportunistic" }, c, now)!.insiderClass).toBe("opportunistic");
  });
});
