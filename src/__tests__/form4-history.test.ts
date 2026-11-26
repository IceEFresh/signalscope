import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyAmendments,
  buildForm4,
  buysAccepted,
  fetchForm4History,
  form4Filings,
  form4XmlUrl,
  insiderEvents,
  insiderFeaturesAt,
  parseForm4,
  type Form4Cache,
  type InsiderEvent,
  type ParsedFiling,
} from "@/lib/harvester/form4-history";

const xml = (f: string) => readFileSync(join(__dirname, "fixtures/edgar", f), "utf8");

/** Weekdays from a to b inclusive (no holidays). */
function weekdays(a: string, b: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const SESSIONS = weekdays("2022-07-01", "2026-12-31");

const filing = (form: "4" | "4/A", accession: string, acceptance: string, filingDate = acceptance.slice(0, 10)) => ({
  form,
  accession,
  filingDate,
  acceptance,
  xmlUrl: `https://example.invalid/${accession}.xml`,
});

describe("parseForm4", () => {
  it("open-market buys (P) with the owner's role, shares, price and A/D flag", () => {
    const d = parseForm4(xml("form4-purchase-P.xml"))!;
    expect(d.documentType).toBe("4");
    expect(d.owners).toEqual([
      { cik: "1178579", name: "TANG KEVIN", director: false, officer: false, tenPct: true, officerTitle: null },
      { cik: "1232621", name: "TANG CAPITAL MANAGEMENT LLC", director: false, officer: false, tenPct: true, officerTitle: null },
    ]);
    expect(d.txns.map((t) => [t.code, t.shares, t.price, t.acquiredDisposed, t.signal])).toEqual([
      ["P", 22231, 2.4, "A", true],
      ["P", 41461, 2.37, "A", true],
      ["P", 39920, 2.32, "A", true],
    ]);
  });

  it("sales are S (signal); grants A and exercises M are kept but non-signal; 0/1 booleans read", () => {
    const s = parseForm4(xml("form4-huang-sale-S.xml"))!;
    expect(s.txns.every((t) => t.code === "S" && t.signal && t.acquiredDisposed === "D")).toBe(true);
    expect(s.owners[0].officer).toBe(true);
    const a = parseForm4(xml("form4-huang-grant-A.xml"))!;
    expect(a.txns.map((t) => [t.code, t.signal])).toEqual([["A", false]]);
    const m = parseForm4(xml("form4-huang-exercise-M.xml"))!;
    expect(m.txns.every((t) => t.code === "M" && !t.signal)).toBe(true);
  });

  it("a 4/A carries its period and original submission date; not a Form 4 → null", () => {
    const d = parseForm4(xml("form4-aapl-amend-4A.xml"))!;
    expect(d).toMatchObject({ documentType: "4/A", periodOfReport: "2022-08-17", dateOfOriginalSubmission: "2022-08-19" });
    expect(parseForm4("<html>nope</html>")).toBeNull();
  });
});

describe("form4Filings", () => {
  it("reads Form 4 and 4/A rows and builds the raw XML URL (no XSL folder)", () => {
    const cols = {
      form: ["8-K", "4", "4/A", "4"],
      accessionNumber: ["a", "0001140361-26-045775", "0000320193-22-000078", "x"],
      filingDate: ["2026-11-25", "2026-11-25", "2022-08-22", "2026-11-25"],
      acceptanceDateTime: ["2026-11-25T23:30:25.000Z", "2026-11-25T23:30:25.000Z", "2022-08-22T22:43:18.000Z", "bad"],
      primaryDocument: ["x.htm", "xslF345X06/form4.xml", "xslF345X03/wf-form4a_166120817922787.xml", "form4.xml"],
    };
    const f = form4Filings(cols, "0000320193");
    expect(f.map((x) => x.form)).toEqual(["4", "4/A"]);
    expect(f[0].xmlUrl).toBe("https://www.sec.gov/Archives/edgar/data/320193/000114036126045775/form4.xml");
    expect(form4XmlUrl("320193", "0000320193-22-000078", "xslF345X03/wf-form4a_1.xml")).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019322000078/wf-form4a_1.xml");
  });
});

describe("amendments", () => {
  const orig: ParsedFiling = { filing: filing("4", "0000320193-22-000076", "2022-08-19T22:30:27.000Z"), doc: parseForm4(xml("form4-aapl-original-S.xml"))! };
  const amend: ParsedFiling = { filing: filing("4/A", "0000320193-22-000078", "2022-08-22T22:43:18.000Z"), doc: parseForm4(xml("form4-aapl-amend-4A.xml"))! };

  it("a 4/A replaces the original (same owner and period, filed on dateOfOriginalSubmission)", () => {
    expect(applyAmendments([amend, orig]).map((f) => f.filing.accession)).toEqual(["0000320193-22-000078"]);
  });

  it("the amended rows take the 4/A's acceptance session (never back-dated)", () => {
    const ev = insiderEvents([orig, amend], SESSIONS);
    expect(ev).toHaveLength(1);
    // 22:43 UTC = 18:43 ET, after the close → next session
    expect(ev[0]).toMatchObject({ session: "2022-08-23", code: "S", signal: true, ownerCik: "1513362", officer: true, shares: 96735 });
    expect(ev[0].usd).toBeCloseTo(66390 * 174.66 + 30345 * 175.6, 0);
  });

  it("a 4/A for another owner or period leaves the original alone", () => {
    const other = { ...amend, doc: { ...amend.doc, periodOfReport: "2022-09-01" } };
    expect(applyAmendments([orig, other])).toHaveLength(2);
  });
});

describe("filing-time session mapping", () => {
  const p = parseForm4(xml("form4-purchase-P.xml"))!;
  const at = (acceptance: string) => insiderEvents([{ filing: filing("4", "acc", acceptance), doc: p }], SESSIONS)[0].session;

  it("before 16:00 ET is that day's session, at or after 16:00 the next; weekends roll forward", () => {
    expect(at("2026-11-18T20:59:00.000Z")).toBe("2026-11-18"); // 15:59 ET
    expect(at("2026-11-18T21:00:00.000Z")).toBe("2026-11-19"); // 16:00 ET
    expect(at("2026-11-21T15:00:00.000Z")).toBe("2026-11-23"); // Saturday → Monday
  });

  it("one P event per filing, shares and dollars summed; a joint filing (insider + fund) is one buyer", () => {
    const ev = insiderEvents([{ filing: filing("4", "acc", "2026-11-18T22:00:00.000Z"), doc: p }], SESSIONS);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ code: "P", ownerCik: "1178579", shares: 22231 + 41461 + 39920, tenPct: true, officer: false });
    expect(ev[0].usd).toBeCloseTo(22231 * 2.4 + 41461 * 2.37 + 39920 * 2.32, 2);
  });
});

const ev = (session: string, ownerCik: string, code = "P", usd = 1000, officer = false): InsiderEvent => ({
  session,
  acceptance: `${session}T15:00:00.000Z`,
  accession: `${session}-${ownerCik}`,
  ownerCik,
  officer,
  director: false,
  tenPct: false,
  code,
  signal: code === "P" || code === "S",
  shares: 10,
  usd,
  transactionDate: session,
});

describe("insiderFeaturesAt", () => {
  it("30-day window counts, buyers, dollars, officer flag and sales", () => {
    const events = [ev("2026-10-01", "A"), ev("2026-11-02", "A", "P", 500), ev("2026-11-10", "B", "P", 2000, true), ev("2026-11-12", "C", "S", 7000), ev("2026-11-12", "D", "A", 9999)];
    expect(insiderFeaturesAt(events, "2026-11-20", SESSIONS)).toEqual({
      ins_buy_n_30d: 2,
      ins_buy_usd_30d: 2500,
      ins_buyers_30d: 2,
      ins_cluster: false, // A (11-02) is outside the 10 sessions ending 11-20 (11-09 on)
      ins_officer_buy: true,
      ins_sell_usd_30d: 7000,
    });
  });

  it("cluster: 2 distinct buyers within 10 sessions (this one included); the 11th session back is out", () => {
    const i = SESSIONS.indexOf("2026-11-20");
    const s = (k: number) => SESSIONS[i - k];
    expect(insiderFeaturesAt([ev(s(9), "A"), ev(s(0), "B")], s(0), SESSIONS).ins_cluster).toBe(true);
    expect(insiderFeaturesAt([ev(s(10), "A"), ev(s(0), "B")], s(0), SESSIONS).ins_cluster).toBe(false);
    expect(insiderFeaturesAt([ev(s(3), "A"), ev(s(1), "A")], s(0), SESSIONS).ins_cluster).toBe(false); // same insider twice
  });

  it("no look-ahead: an event counts only from its signal session on", () => {
    const events = [ev("2026-11-19", "A"), ev("2026-11-19", "B")];
    expect(insiderFeaturesAt(events, "2026-11-18", SESSIONS)).toMatchObject({ ins_buy_n_30d: 0, ins_cluster: false });
    expect(insiderFeaturesAt(events, "2026-11-19", SESSIONS)).toMatchObject({ ins_buy_n_30d: 2, ins_cluster: true });
    // A late filing (transaction weeks earlier, accepted after the close) still waits for its acceptance session
    const p = parseForm4(xml("form4-purchase-P.xml"))!;
    const late = insiderEvents([{ filing: filing("4", "late", "2026-11-24T21:30:00.000Z"), doc: p }], SESSIONS);
    expect(late[0]).toMatchObject({ transactionDate: "2026-11-18", session: "2026-11-25" });
    expect(insiderFeaturesAt(late, "2026-11-24", SESSIONS).ins_buy_n_30d).toBe(0);
    expect(insiderFeaturesAt(late, "2026-11-25", SESSIONS).ins_buy_n_30d).toBe(1);
  });

  it("buysAccepted picks P events in an acceptance range", () => {
    const events = [ev("2026-11-19", "A"), ev("2026-11-19", "B", "S"), ev("2026-11-20", "C")];
    expect(buysAccepted(events, "2026-11-19T00:00:00Z", "2026-11-20T00:00:00Z").map((e) => e.ownerCik)).toEqual(["A"]);
  });
});

function memCache(): Form4Cache & { json: Map<string, unknown>; xml: Map<string, string> } {
  const json = new Map<string, unknown>();
  const xmlM = new Map<string, string>();
  return {
    json,
    xml: xmlM,
    readJson: (n) => json.get(n) ?? null,
    writeJson: (n, j) => void json.set(n, j),
    readXml: (a) => xmlM.get(a) ?? null,
    writeXml: (a, x) => void xmlM.set(a, x),
  };
}

describe("fetchForm4History", () => {
  const submissions = {
    filings: {
      recent: {
        form: ["4", "4", "4"],
        accessionNumber: ["0000000001-26-000001", "0000000001-26-000002", "0000000001-20-000003"],
        filingDate: ["2026-11-18", "2026-11-19", "2020-01-02"],
        acceptanceDateTime: ["2026-11-18T22:00:00.000Z", "2026-11-19T22:00:00.000Z", "2020-01-02T22:00:00.000Z"],
        primaryDocument: ["xslF345X06/a.xml", "xslF345X06/b.xml", "xslF345X06/c.xml"],
      },
      files: [{ name: "CIK0000000001-submissions-001.json", filingFrom: "2001-01-01", filingTo: "2019-12-31" }],
    },
  };

  it("caches the XML, skips filings before `from` and old pages that end before it, and counts failures", async () => {
    const client = {
      json: vi.fn(async () => submissions),
      text: vi.fn(async (url: string) => {
        if (url.endsWith("/b.xml")) throw new Error("edgar 500");
        return xml("form4-purchase-P.xml");
      }),
    };
    const cache = memCache();
    const stats = { filings: 0, xmlFetched: 0, xmlFailed: 0 };
    const out = await fetchForm4History("0000000001", "2024-11-26", client, cache, { stats });
    expect(out).toHaveLength(1);
    expect(stats).toEqual({ filings: 2, xmlFetched: 1, xmlFailed: 1 });
    expect(client.json).toHaveBeenCalledTimes(1); // the old page ends before `from`
    expect(client.text.mock.calls.map((c) => c[0])).toEqual([
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.xml",
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/b.xml",
    ]);
    // Rerun: submissions and the good XML from cache; refreshMain refetches the submissions only
    await fetchForm4History("0000000001", "2024-11-26", client, cache);
    expect(client.json).toHaveBeenCalledTimes(1);
    await fetchForm4History("0000000001", "2024-11-26", client, cache, { refreshMain: true });
    expect(client.json).toHaveBeenCalledTimes(2);
    expect(client.text.mock.calls.filter((c) => c[0].endsWith("/a.xml"))).toHaveLength(1);
  });
});

describe("buildForm4", () => {
  it("no CIK → no entry; a failed fetch → no entry (null downstream); no filings → empty list (zeros); one fetch per CIK", async () => {
    const p = parseForm4(xml("form4-purchase-P.xml"))!;
    const fetchParsed = vi.fn(async (cik: string) => {
      if (cik === "BAD") throw new Error("edgar 500");
      if (cik === "EMPTY") return [];
      return [{ filing: filing("4", "acc", "2026-11-18T22:00:00.000Z"), doc: p }];
    });
    const ciks: Record<string, string> = { BOLD: "1", "BRK-A": "2", "BRK-B": "2", BAD: "BAD", EMPTY: "EMPTY" };
    const { bySymbol, coverage } = await buildForm4(["BOLD", "BRK-A", "BRK-B", "BAD", "EMPTY", "NOCIK"], (s) => ciks[s], SESSIONS, fetchParsed);
    expect(fetchParsed).toHaveBeenCalledTimes(4);
    expect([...bySymbol.keys()]).toEqual(["BOLD", "BRK-A", "BRK-B", "EMPTY"]);
    expect(bySymbol.get("EMPTY")!.events).toEqual([]);
    expect(coverage).toMatchObject({ symbols: 6, withFilings: 3, noCik: 1, failed: 1, buys: 3 });
  });
});
