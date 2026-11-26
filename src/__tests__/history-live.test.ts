import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { finraLive, form4Live, form4LiveLine } from "@/lib/harvester/history-live";
import { INS_KEYS, type Form4Cache } from "@/lib/harvester/form4-history";
import { SI_KEYS, SV_KEYS, siFileUrl, svFileUrl, type FinraCache } from "@/lib/harvester/finra";
import { isLiveStpKey } from "@/lib/health/harvest-health";

const fx = (dir: string, f: string) => readFileSync(join(__dirname, "fixtures", dir, f), "utf8");

function weekdays(a: string, b: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const memForm4 = (): Form4Cache => {
  const j = new Map<string, unknown>();
  const x = new Map<string, string>();
  return { readJson: (n) => j.get(n) ?? null, writeJson: (n, v) => void j.set(n, v), readXml: (a) => x.get(a) ?? null, writeXml: (a, v) => void x.set(a, v) };
};
const memFinra = (): FinraCache => {
  const m = new Map<string, string>();
  return { read: (n) => m.get(n) ?? null, write: (n, t) => void m.set(n, t) };
};

describe("form4Live", () => {
  const SESSIONS = weekdays("2026-09-01", "2026-11-27");
  const submissions = {
    filings: {
      recent: {
        form: ["4"],
        accessionNumber: ["0001232621-26-000001"],
        filingDate: ["2026-11-18"],
        acceptanceDateTime: ["2026-11-18T22:10:00.000Z"],
        primaryDocument: ["xslF345X06/form4.xml"],
      },
    },
  };

  it("ins_* keys from the issuer's recent Form 4s; no CIK or a failed issuer → no keys; one submissions fetch per CIK, always refreshed", async () => {
    const client = {
      json: vi.fn(async (url: string) => {
        if (url.includes("CIK0000000002")) throw new Error("edgar 500");
        return submissions;
      }),
      text: vi.fn(async () => fx("edgar", "form4-purchase-P.xml")),
    };
    const ciks: Record<string, string> = { BOLD: "0000000001", BOLDW: "0000000001", BAD: "0000000002" };
    const rows = [
      { symbol: "BOLD", sessionDate: "2026-11-25" },
      { symbol: "BOLDW", sessionDate: "2026-11-18" },
      { symbol: "BAD", sessionDate: "2026-11-25" },
      { symbol: "NOCIK", sessionDate: "2026-11-25" },
    ];
    const cache = memForm4();
    const r = await form4Live(rows, SESSIONS, "2026-11-26", (s) => ciks[s], client, cache);
    expect(Object.keys(r.features).sort()).toEqual(["BOLD", "BOLDW"]);
    expect(Object.keys(r.features.BOLD).sort()).toEqual([...INS_KEYS].sort());
    // Accepted 17:10 ET on 11-18 → session 11-19: counted on the 11-25 row, not on the 11-18 row
    expect(r.features.BOLD).toMatchObject({ ins_buy_n_30d: 1, ins_buyers_30d: 1, ins_cluster: false, ins_officer_buy: false });
    expect(r.features.BOLDW.ins_buy_n_30d).toBe(0);
    expect(r.stats).toMatchObject({ symbols: 4, withCik: 3, failed: 1, xmlFetched: 1 });
    expect(client.json).toHaveBeenCalledTimes(2);
    // Next run: the submissions JSON is refetched (new filings), the XML isn't
    await form4Live(rows.slice(0, 1), SESSIONS, "2026-11-26", (s) => ciks[s], client, cache);
    expect(client.json).toHaveBeenCalledTimes(3);
    expect(client.text).toHaveBeenCalledTimes(1);
  });

  it("the health line compares EDGAR P-code buys with the live insider source over the same rows", async () => {
    const client = { json: async () => submissions, text: async () => fx("edgar", "form4-purchase-P.xml") };
    const r = await form4Live([{ symbol: "BOLD", sessionDate: "2026-11-19" }, { symbol: "XYZ", sessionDate: "2026-11-19" }], SESSIONS, "2026-11-19", () => "0000000001", client, memForm4());
    const { line, warn } = form4LiveLine(r, new Set(["BOLD", "OFFROWS"]), "2026-11-18T12:00:00.000Z", "2026-11-19T12:00:00.000Z");
    expect(warn).toBe(false);
    expect(line).toContain("EDGAR 2 (2 symbols), live insider source 1 symbols, both 1");
  });
});

describe("finraLive", () => {
  // Sessions through 2024-12-10 (Thanksgiving off); rows on 11-22 and 12-10
  const SESSIONS = weekdays("2024-10-01", "2024-12-10").filter((d) => d !== "2024-11-28");

  it("si_* from the newest published report, sv_* on the row's session; floats file feeds si_pct_float", async () => {
    const files: Record<string, string> = {
      [siFileUrl("2024-11-15")]: fx("finra", "shrt20241115.csv"),
      [svFileUrl("2024-11-22")]: fx("finra", "CNMSshvol20241122.txt"),
    };
    const get = vi.fn(async (url: string) => files[url] ?? null);
    const rows = [
      { symbol: "AAPL", sessionDate: "2024-11-22" },
      { symbol: "GME", sessionDate: "2024-11-22" },
      { symbol: "ZZZZ", sessionDate: "2024-11-22" },
    ];
    const r = await finraLive(rows, SESSIONS, "2024-11-26", { AAPL: 14_800_000_000 }, get, memFinra());
    expect(Object.keys(r.features.AAPL).sort()).toEqual([...SI_KEYS, ...SV_KEYS].sort());
    // The 11-15 report is published 11-26: not usable on the 11-22 row
    expect(r.features.AAPL.si_shares).toBeNull();
    expect(r.features.AAPL.sv_ratio).toBeCloseTo(4854930 / 12352802, 4);
    expect(r.features.AAPL.sv_z).toBeNull(); // no 20-session baseline cached
    expect(r.features.ZZZZ.sv_ratio).toBeNull();
    expect(r.line).toContain("short volume 2024-11-22: file ok, 1/3 rows");
    expect(r.warn).toBe(true); // short interest on 0/3 rows

    const later = await finraLive([{ symbol: "AAPL", sessionDate: "2024-12-10" }, { symbol: "GME", sessionDate: "2024-12-10" }], SESSIONS, "2024-12-10", { AAPL: 14_800_000_000 }, get, memFinra());
    expect(later.features.AAPL).toMatchObject({ si_shares: 141037864, si_pct_float: 0.95, si_high: false, si_settlement: "2024-11-15" });
    expect(later.features.GME).toMatchObject({ si_shares: 31866496, si_pct_float: null, si_high: null });
    expect(later.line).toContain("short volume 2024-12-10: file missing");
  });
});

describe("health registration", () => {
  it("ins_*, si_* and sv_* are log-only live keys", () => {
    for (const k of [...INS_KEYS, ...SI_KEYS, ...SV_KEYS]) expect(isLiveStpKey(k), k).toBe(true);
    expect(isLiveStpKey("insider_class")).toBe(false);
  });
});
