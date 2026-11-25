import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEarnings,
  cik10,
  earningsCoverageLine,
  earningsEvents,
  earningsFilings,
  earningsSession,
  earningsSessionsFromFile,
  EdgarEarningsClient,
  fetchEarningsFilings,
  normTicker,
  pagesNeeded,
  parseItems,
  parseTickerMap,
  type EarningsCache,
} from "@/lib/harvester/edgar-earnings";
import { scanSymbol } from "@/lib/eval/stp-sim";
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";

const FIX = join(__dirname, "fixtures/edgar");
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as unknown;
const aapl = load("submissions-CIK0000320193.json") as { filings: { recent: unknown } };
const jpm = load("submissions-CIK0000019617.json") as { filings: { recent: unknown } };
const jpmPage12 = load("submissions-CIK0000019617-submissions-012.json");

/** Weekday dates from..to, minus `holidays`. */
function weekdays(from: string, to: string, holidays: string[] = []): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const s = d.toISOString().slice(0, 10);
    if (d.getUTCDay() % 6 !== 0 && !holidays.includes(s)) out.push(s);
  }
  return out;
}
const SESSIONS = weekdays("2023-01-01", "2026-11-25", ["2024-07-04", "2025-12-25", "2026-01-19"]);

describe("ticker map and filing rows", () => {
  it("maps normalized tickers to 10-digit CIKs; share classes keep their own ticker, the first listing wins", () => {
    const m = parseTickerMap(load("company_tickers.json"));
    expect(m.get("AAPL")).toBe("0000320193");
    expect(m.get(normTicker("BRK.B"))).toBe("0001067983");
    expect(m.get("JPM-PC")).toBe("0000019617");
    expect(m.get("NOPE")).toBeUndefined();
    expect(cik10(19617)).toBe("0000019617");
    expect(parseTickerMap(null).size).toBe(0);
  });

  it("keeps only 8-K rows whose items include 2.02 (not 8.01, not 10-Q, not an 8-K/A amendment)", () => {
    expect(parseItems("2.02,9.01")).toEqual(["2.02", "9.01"]);
    expect(parseItems(" 12.02 , 2.020")).toEqual(["12.02", "2.020"]); // exact item match only
    const f = earningsFilings(aapl.filings.recent);
    expect(f).toHaveLength(16);
    expect(f.every((x) => x.items.includes("2.02"))).toBe(true);
    expect(f[0]).toMatchObject({ filingDate: "2026-11-02", acceptance: "2026-11-02T21:30:23.000Z" });
    const cols = { form: ["8-K/A", "8-K", "8-K"], items: ["2.02,9.01", "12.02", "2.02"], acceptanceDateTime: ["2025-01-01T21:00:00.000Z", "2025-01-02T21:00:00.000Z", "bad"], filingDate: ["2025-01-01", "2025-01-02", "2025-01-03"], accessionNumber: ["a", "b", "c"] };
    expect(earningsFilings(cols)).toEqual([]);
    expect(earningsFilings(undefined)).toEqual([]);
  });
});

describe("before / after the open, across DST", () => {
  const at = (iso: string) => earningsSession(iso, SESSIONS);
  it("16:30 ET after the close maps to the next session, in winter (EST, 21:30Z) and summer (EDT, 20:30Z)", () => {
    expect(at("2024-02-01T21:30:30.000Z")).toEqual({ session: "2024-02-02", timing: "post" }); // AAPL, EST
    expect(at("2024-08-01T20:30:26.000Z")).toEqual({ session: "2024-08-02", timing: "post" }); // AAPL, EDT
  });
  it("before 09:30 ET maps to the same day's session (JPM 06:30 EDT, 06:41 EST)", () => {
    expect(at("2026-10-13T10:30:38.000Z")).toEqual({ session: "2026-10-13", timing: "pre" });
    expect(at("2026-01-13T11:41:09.000Z")).toEqual({ session: "2026-01-13", timing: "pre" });
  });
  it("the 09:30 and 16:00 ET boundaries move with DST", () => {
    expect(at("2026-01-13T14:29:00.000Z")!.timing).toBe("pre"); // 09:29 EST
    expect(at("2026-01-13T14:30:00.000Z")!.timing).toBe("during"); // 09:30 EST
    expect(at("2026-07-14T13:29:00.000Z")!.timing).toBe("pre"); // 09:29 EDT
    expect(at("2026-07-14T13:30:00.000Z")!.timing).toBe("during"); // 09:30 EDT
    expect(at("2026-01-13T20:59:00.000Z")).toEqual({ session: "2026-01-13", timing: "during" }); // 15:59 EST
    expect(at("2026-01-13T21:00:00.000Z")).toEqual({ session: "2026-01-14", timing: "post" }); // 16:00 EST
    expect(at("2026-07-14T20:00:00.000Z")).toEqual({ session: "2026-07-15", timing: "post" }); // 16:00 EDT
  });
  it("Friday after the close → Monday; before the open on a holiday → the next session; past the data → null", () => {
    expect(at("2026-01-16T21:30:00.000Z")!.session).toBe("2026-01-20"); // Fri post → Mon is a holiday (2026-01-19) → Tue
    expect(at("2024-07-04T11:00:00.000Z")!.session).toBe("2024-07-05");
    expect(at("2026-11-25T21:30:00.000Z")).toBeNull();
  });
  it("one event per session (the earliest acceptance), oldest first, from `from` on", () => {
    const f = earningsFilings(aapl.filings.recent);
    const dup = [...f, { ...f[0], acceptance: "2026-11-02T22:10:00.000Z", accession: "later" }];
    const ev = earningsEvents(dup, SESSIONS, "2025-01-01");
    expect(ev.map((e) => e.session)).toEqual(["2025-01-31", "2025-05-02", "2025-08-01", "2025-10-31", "2026-01-30", "2026-05-01", "2026-07-31", "2026-11-03"]);
    expect(ev.at(-1)!.accession).not.toBe("later");
  });
});

describe("older pages and the client", () => {
  const memCache = (): EarningsCache & { store: Map<string, unknown> } => {
    const store = new Map<string, unknown>();
    return { store, read: (n) => store.get(n) ?? null, write: (n, j) => void store.set(n, j) };
  };
  const empty = { form: [], items: [], acceptanceDateTime: [], filingDate: [], accessionNumber: [] };

  it("reads the older pages that reach back to `from`, and caches every JSON", async () => {
    expect(pagesNeeded(jpm, "2024-10-01").map((p) => p.name).at(-1)).toBe("CIK0000019617-submissions-012.json");
    expect(pagesNeeded(jpm, "2024-10-01")).toHaveLength(12);
    expect(pagesNeeded(jpm, "2025-11-24")).toHaveLength(0); // recent alone covers it
    const urls: string[] = [];
    const client = new EdgarEarningsClient(async (url) => {
      urls.push(url);
      if (url.endsWith("CIK0000019617.json")) return JSON.stringify(jpm);
      if (url.endsWith("-012.json")) return JSON.stringify(jpmPage12);
      return JSON.stringify(empty);
    }, 0);
    const cache = memCache();
    const f = await fetchEarningsFilings("0000019617", "2024-10-01", client, cache);
    expect(urls[0]).toBe("https://data.sec.gov/submissions/CIK0000019617.json");
    expect(urls).toHaveLength(13);
    expect(f.map((x) => x.filingDate)).toEqual(["2026-10-13", "2026-07-14", "2026-04-14", "2026-01-13", "2024-10-11"]);
    expect(cache.store.size).toBe(13);
    // a rerun is served from the cache: no requests
    await fetchEarningsFilings("0000019617", "2024-10-01", client, cache);
    expect(client.requests).toBe(13);
  });

  it("a 429 is retried; a 404 (missing CIK) fails at once", async () => {
    let n = 0;
    const flaky = new EdgarEarningsClient(async () => {
      if (n++ === 0) throw new Error("edgar 429");
      return "{}";
    }, 0);
    await expect(flaky.json("u")).resolves.toEqual({});
    expect(n).toBe(2);
    const get = vi.fn(async () => {
      throw new Error("edgar 404");
    });
    await expect(new EdgarEarningsClient(get, 0).json("u")).rejects.toThrow("edgar 404");
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("coverage", () => {
  it("counts symbols with dates, without a CIK, with no 8-K 2.02, and failed fetches; one fetch per CIK", async () => {
    const map = parseTickerMap(load("company_tickers.json"));
    const fetchFilings = vi.fn(async (cik: string) => {
      if (cik === "0000320193") return earningsFilings(aapl.filings.recent);
      if (cik === "0001306965") return []; // SHEL: files 6-K, no 8-K 2.02
      throw new Error("edgar 404");
    });
    const errors: string[] = [];
    const { bySymbol, coverage } = await buildEarnings(["AAPL", "SHEL", "BRK.B", "BRK-A", "XYZ"], map, SESSIONS, "2025-01-01", fetchFilings, (s) => errors.push(s));
    expect(coverage).toEqual({ symbols: 5, withDates: 1, noCik: 1, noFilings: 1, failed: 2, events: 8, during: 0 });
    expect(fetchFilings).toHaveBeenCalledTimes(3); // BRK.B and BRK-A share one CIK
    expect(errors).toEqual(["BRK.B"]);
    expect(bySymbol.get("AAPL")!.events).toHaveLength(8);
    expect(bySymbol.has("SHEL")).toBe(false);
    expect(earningsCoverageLine(coverage)).toBe(
      "[earnings] 1/5 symbols (20.0%) with EDGAR earnings dates; 1 without a CIK, 1 with no 8-K 2.02 in range, 2 failed; 8 sessions, 0 accepted during the session (flagged)",
    );
    expect(earningsSessionsFromFile({ events: bySymbol.get("AAPL")!.events })).toEqual(new Set(bySymbol.get("AAPL")!.events.map((e) => e.session)));
    expect(earningsSessionsFromFile(null).size).toBe(0);
  });
});

describe("EGOP on the backfill", () => {
  // 70 quiet sessions, then a gap above the prior high closing above its open
  function series(): DailyBar[] {
    let t = Date.UTC(2025, 0, 6, 14, 30) / 1000;
    const out: DailyBar[] = [];
    for (let i = 0; i < 71; i++) {
      while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86_400;
      const p = 100 + (i % 2 ? 0.5 : -0.5);
      out.push(i < 70 ? { open: p, high: p + 1, low: p - 1, close: p, volume: 1, time: t } : { open: 106, high: 109, low: 105.5, close: 108.5, volume: 1, time: t });
      t += 86_400;
    }
    return out;
  }
  it("fires on the earnings session only when that session is in the EDGAR set", () => {
    const b = series();
    const d = new Date(b[70].time! * 1000).toISOString().slice(0, 10);
    const egop = (s: ReturnType<typeof scanSymbol>) => s.setups.filter((x) => x.firedRules.includes("egop+"));
    expect(egop(scanSymbol("T", b))).toHaveLength(0);
    expect(egop(scanSymbol("T", b, undefined, undefined, new Set(["2025-01-02"])))).toHaveLength(0);
    const hit = egop(scanSymbol("T", b, undefined, undefined, new Set([d])));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ date: d, i: 70, dir: 1 });
  });
});
