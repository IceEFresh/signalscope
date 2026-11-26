import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildCongress,
  CONG_KEYS,
  congressEvents,
  congressFeaturesAt,
  fetchPtrIndex,
  fetchPtrParsed,
  houseLive,
  houseVsCapitolLine,
  newCongressBuys,
  parseAmount,
  parsePtrIndex,
  parsePtrText,
  pdfText,
  PTR_PARSER_VERSION,
  sessionAfter,
  unzip,
  withNextWeekdays,
  type CongressEvent,
  type HouseCache,
  type PtrFiling,
} from "@/lib/harvester/house-ptr";
import { isLiveStpKey } from "@/lib/health/harvest-health";

const fx = (f: string) => readFileSync(join(__dirname, "fixtures/house", f));

function weekdays(a: string, b: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const SESSIONS = weekdays("2025-01-01", "2026-12-31");

function memCache(): HouseCache & { bytes: Map<string, Uint8Array>; json: Map<string, unknown> } {
  const bytes = new Map<string, Uint8Array>();
  const json = new Map<string, unknown>();
  return {
    bytes,
    json,
    readBytes: (n) => bytes.get(n) ?? null,
    writeBytes: (n, d) => void bytes.set(n, d),
    readJson: (n) => json.get(n) ?? null,
    writeJson: (n, j) => void json.set(n, j),
  };
}

describe("index", () => {
  it("unzips the yearly index and keeps the PTRs (FilingType P) only", () => {
    const files = unzip(fx("2026FD-trimmed.zip"));
    expect([...files.keys()].sort()).toEqual(["2026FD.txt", "2026FD.xml"]);
    const ptrs = parsePtrIndex(files.get("2026FD.xml")!.toString("utf8"));
    expect(ptrs.map((p) => p.docId).sort()).toEqual(["20033918", "20035780", "9116361"]);
    expect(ptrs.find((p) => p.docId === "20033918")).toEqual({
      docId: "20033918",
      year: 2026,
      member: "Taylor, David J. (OH02)",
      stateDst: "OH02",
      filingDate: "2026-02-02",
      electronic: true,
    });
    expect(ptrs.find((p) => p.docId === "9116361")!.electronic).toBe(false);
  });

  it("fetchPtrIndex caches the ZIP; the current year is refetched with refresh", async () => {
    const get = vi.fn(async () => new Uint8Array(fx("2026FD-trimmed.zip")));
    const cache = memCache();
    expect(await fetchPtrIndex(2026, get, cache)).toHaveLength(3);
    await fetchPtrIndex(2026, get, cache);
    expect(get).toHaveBeenCalledTimes(1);
    await fetchPtrIndex(2026, get, cache, true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(await fetchPtrIndex(2027, async () => null, memCache())).toEqual([]);
  });
});

describe("PTR PDFs", () => {
  it("a clean PTR: every row parsed with ticker, type, dates and amount range", async () => {
    const p = parsePtrText(await pdfText(new Uint8Array(fx("ptr-clean-20033918.pdf"))));
    expect(p.noText).toBe(false);
    expect(p.unparsed).toBe(0);
    expect(p.txns.map((t) => [t.ticker, t.type, t.transactionDate, t.amountMid])).toEqual([
      ["AAPL", "purchase", "2026-01-16", 8000.5],
      ["IBP", "sale", "2026-01-16", 8000.5],
      ["JPM", "purchase", "2026-01-29", 8000.5],
      ["KR", "purchase", "2026-01-16", 8000.5],
    ]);
    expect(p.txns[0]).toMatchObject({ assetType: "ST", owner: "self", notificationDate: "2026-01-30", amountLow: 1001, amountHigh: 15000 });
  });

  it("a messy PTR: a row split by a page break is counted as unparsed, never guessed; owner codes read", async () => {
    const p = parsePtrText(await pdfText(new Uint8Array(fx("ptr-messy-20026731.pdf"))));
    expect(p.txns).toHaveLength(17);
    expect(p.unparsed).toBe(1);
    expect(p.txns.slice(0, 4).map((t) => [t.ticker, t.owner, t.type])).toEqual([
      ["ABT", "self", "sale"],
      ["ABT", "DC", "sale"],
      ["ABT", "DC", "sale"],
      ["ABBV", "DC", "purchase"],
    ]);
  });

  it("a scanned paper filing has no text: flagged, no rows", async () => {
    const p = parsePtrText(await pdfText(new Uint8Array(fx("ptr-paper-9116361.pdf"))));
    expect(p).toEqual({ txns: [], unparsed: 0, noText: true });
  });
});

describe("parsePtrText", () => {
  const header = "Clerk of the House • Washington, DC 20515\nID Owner Asset Transaction\nType\nDate Notification\nDate\nAmount Cap.\nGains >\n$200?\n";

  it("tickers (share classes normalised), no-ticker rows kept with a null ticker, spouse owner, open-ended amounts", () => {
    const text =
      header +
      "SP Berkshire Hathaway Inc. New\nCommon Stock (BRK.B) [ST]\nS (partial) 09/24/2026 10/01/2026 $1,001 - $15,000\nF      S     : New\n" +
      "Treasury Bill (6-Week) [GS]\nP 10/20/2026 10/20/2026 $15,001 -\n$50,000\n" +
      "JT Exchange Corp (XC) [ST] E 10/21/2026 10/22/2026 Over $50,000,000\n";
    const p = parsePtrText(text);
    expect(p.unparsed).toBe(0);
    expect(p.txns.map((t) => [t.ticker, t.assetType, t.type, t.owner, t.amountLow, t.amountHigh, t.amountMid])).toEqual([
      ["BRK-B", "ST", "sale_partial", "SP", 1001, 15000, 8000.5],
      [null, "GS", "purchase", "self", 15001, 50000, 32500.5],
      ["XC", "ST", "exchange", "JT", 50000000, null, 50000000],
    ]);
  });

  it("the page header's 'Washington, DC' is never read as the dependent-child owner", () => {
    expect(parsePtrText(header + "Apple Inc. (AAPL) [ST] P 01/02/2026 01/05/2026 $1,001 - $15,000").txns[0].owner).toBe("self");
  });

  it("a transaction-shaped line that doesn't match a row is counted", () => {
    const text = header + "Apple Inc. (AAPL) [ST] P 01/02/2026 01/05/2026 $1,001 - $15,000\nSomething odd P 01/02/2026 01/05/2026 $1,001 - $15,000\n";
    expect(parsePtrText(text)).toMatchObject({ unparsed: 1 });
  });

  it("amount-range midpoints", () => {
    expect(parseAmount("$1,001 - $15,000")).toEqual({ low: 1001, high: 15000, mid: 8000.5 });
    expect(parseAmount("$1,000,001 -\n$5,000,000")).toEqual({ low: 1000001, high: 5000000, mid: 3000000.5 });
    expect(parseAmount("Over $50,000,000")).toEqual({ low: 50000000, high: null, mid: 50000000 });
    expect(parseAmount("Spouse/DC Over $1,000,000")).toEqual({ low: null, high: null, mid: null });
  });
});

const filing = (docId: string, filingDate: string, member = "Doe, Jane (XX01)"): PtrFiling => ({ docId, year: Number(filingDate.slice(0, 4)), member, stateDst: "XX01", filingDate, electronic: true });

describe("filing-date mapping and features", () => {
  it("the signal session is the first session after the filing date (the index has no time); weekends roll", () => {
    expect(sessionAfter("2026-01-30", SESSIONS)).toBe("2026-02-02"); // Friday → Monday
    expect(sessionAfter("2026-02-03", SESSIONS)).toBe("2026-02-04");
    expect(sessionAfter("2026-12-31", SESSIONS)).toBeNull();
    const p = parsePtrText("$200?\nApple Inc. (AAPL) [ST] P 01/02/2026 01/05/2026 $1,001 - $15,000\nBond [CS] P 01/02/2026 01/05/2026 $1,001 - $15,000");
    const ev = congressEvents(filing("1", "2026-01-30"), p, SESSIONS);
    expect(ev).toEqual([{ session: "2026-02-02", filingDate: "2026-01-30", docId: "1", member: "Doe, Jane (XX01)", ticker: "AAPL", type: "purchase", amountMid: 8000.5, transactionDate: "2026-01-02" }]);
  });

  const ev = (session: string, member: string, type: CongressEvent["type"], amountMid: number | null = 8000.5, ticker = "AAPL"): CongressEvent => ({
    session,
    filingDate: session,
    docId: `${session}${member}`,
    member,
    ticker,
    type,
    amountMid,
    transactionDate: null,
  });

  it("30-day counts, midpoint sum and distinct members; other tickers ignored; nothing before its session (no look-ahead)", () => {
    const events = [
      ev("2026-01-21", "A", "purchase"), // 30 days before 02-19 is 01-20 (excluded)
      ev("2026-02-10", "A", "purchase", 32500.5),
      ev("2026-02-12", "B", "sale_partial"),
      ev("2026-02-12", "C", "exchange"),
      ev("2026-02-13", "D", "purchase", 8000.5, "MSFT"),
      ev("2026-02-20", "E", "purchase"),
    ];
    expect(congressFeaturesAt(events, "aapl", "2026-02-19")).toEqual({ cong_buy_n_30d: 2, cong_buy_amt_mid_30d: 40501, cong_sell_n_30d: 1, cong_members_30d: 2 });
    // On 02-20 the 01-21 buy drops out (01-21 is 30 days back) and E's 02-20 buy comes in
    expect(congressFeaturesAt(events, "AAPL", "2026-02-20").cong_buy_n_30d).toBe(2);
    expect(congressFeaturesAt(events, "AAPL", "2026-03-20")).toEqual({ cong_buy_n_30d: 1, cong_buy_amt_mid_30d: 8000.5, cong_sell_n_30d: 0, cong_members_30d: 1 });
    expect(Object.keys(congressFeaturesAt([], "X", "2026-01-01"))).toEqual([...CONG_KEYS]);
  });
});

describe("fetching and building", () => {
  it("fetchPtrParsed caches the PDF and the parse; a new parser version reparses from the cached PDF", async () => {
    const get = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const text = vi.fn(async () => "$200?\nApple Inc. (AAPL) [ST] P 01/02/2026 01/05/2026 $1,001 - $15,000");
    const cache = memCache();
    const f = filing("20000001", "2026-01-30");
    expect((await fetchPtrParsed(f, get, cache, text))!.txns).toHaveLength(1);
    await fetchPtrParsed(f, get, cache, text);
    expect(get).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledTimes(1);
    cache.json.set("parsed/20000001.json", { v: PTR_PARSER_VERSION - 1, txns: [], unparsed: 0, noText: false });
    await fetchPtrParsed(f, get, cache, text);
    expect(get).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledTimes(2);
    expect(await fetchPtrParsed(filing("404", "2026-01-30"), async () => null, memCache(), text)).toBeNull();
  });

  it("buildCongress: coverage counts paper filings, ticker rows, unparsed lines and failures", async () => {
    const parses: Record<string, ReturnType<typeof parsePtrText> | null | Error> = {
      a: parsePtrText("$200?\nApple Inc. (AAPL) [ST] P 01/02/2026 01/05/2026 $1,001 - $15,000\nBond [CS] P 01/02/2026 01/05/2026 $1,001 - $15,000\nodd P 01/02/2026 01/05/2026 x"),
      b: { txns: [], unparsed: 0, noText: true },
      c: null,
      d: new Error("house 500"),
    };
    const onError = vi.fn();
    const { events, coverage } = await buildCongress(
      ["a", "b", "c", "d"].map((id) => filing(id, "2026-01-30")),
      SESSIONS,
      async (f) => {
        const r = parses[f.docId];
        if (r instanceof Error) throw r;
        return r;
      },
      onError,
    );
    expect(coverage).toEqual({ ptrs: 4, paper: 1, rows: 2, tickerRows: 1, unparsed: 1, failed: 2 });
    expect(events.map((e) => e.ticker)).toEqual(["AAPL"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("houseLive: the current year's index refetched, last year's added in Jan–Feb, only PTRs from the last 45 days parsed", async () => {
    const get = vi.fn(async (url: string) => (url ? new Uint8Array(fx("2026FD-trimmed.zip")) : null));
    const parse = vi.fn(async (f: PtrFiling) => parsePtrText(f.docId && "$200?\nApple Inc. (AAPL) [ST] P 01/02/2026 01/05/2026 $1,001 - $15,000"));
    // Fixture PTRs are filed 2026-02-02, 2026-10-02 (paper) and 2026-11-06
    await houseLive("2026-02-20", weekdays("2025-12-01", "2026-02-19"), get, memCache(), parse);
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025FD.zip",
      "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip",
    ]);
    get.mockClear();
    parse.mockClear();
    const r = await houseLive("2026-11-20", weekdays("2026-09-01", "2026-11-19"), get, memCache(), parse);
    expect(get).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls.map((c) => c[0].docId)).toEqual(["20035780"]); // 45 days back is 10-06
    expect(r.events.map((e) => [e.filingDate, e.session])).toEqual([["2026-11-06", "2026-11-09"]]);
  });

  it("new purchases since the last session are the P3-0l congress hits; the comparison line", () => {
    const e = (filingDate: string, ticker: string, type: CongressEvent["type"]): CongressEvent => ({ session: filingDate, filingDate, docId: "x", member: "m", ticker, type, amountMid: 1, transactionDate: null });
    const house = newCongressBuys([e("2026-11-24", "OLD", "purchase"), e("2026-11-25", "AAPL", "purchase"), e("2026-11-25", "MSFT", "sale")], "2026-11-25");
    expect([...house]).toEqual(["AAPL"]);
    expect(houseVsCapitolLine(house, new Set(["AAPL", "NVDA"]))).toBe("[house-ptr] new purchase tickers: House Clerk 1, Capitol Trades 2, both 1");
  });

  it("withNextWeekdays extends the session list past the last bar (a filing dated today maps forward)", () => {
    expect(withNextWeekdays(["2026-11-25"], 3)).toEqual(["2026-11-25", "2026-11-26", "2026-11-27", "2026-11-30"]);
  });

  it("cong_* are log-only live keys", () => {
    for (const k of CONG_KEYS) expect(isLiveStpKey(k), k).toBe(true);
  });
});
