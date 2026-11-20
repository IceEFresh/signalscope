import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.stubEnv("HARVEST_API_KEY", "k");
const mockLoad = vi.fn();
const mockWatch = vi.fn();
const mockSave = vi.fn();
vi.mock("@/lib/harvester/universe/store", () => ({
  loadUniverse: (...a: unknown[]) => mockLoad(...a),
  getActiveWatch: (...a: unknown[]) => mockWatch(...a),
  saveUniverse: (...a: unknown[]) => mockSave(...a),
}));

const { GET, POST } = await import("@/app/api/harvest/universe/route");

const req = (method: string, body?: unknown, key: string | null = "k") =>
  new NextRequest("http://localhost:3000/api/harvest/universe", {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "x-harvest-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const member = { symbol: "AAA", price: 10, marketCap: 1e9, dollarVolume20d: 3e7, atrPct: 0.04, hv20: null, hasOptions: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockWatch.mockResolvedValue([]);
});

describe("GET /api/harvest/universe", () => {
  it("rejects a missing or wrong key", async () => {
    expect((await GET(req("GET", undefined, null))).status).toBe(401);
    expect((await GET(req("GET", undefined, "nope"))).status).toBe(401);
  });

  it("returns null universe before the first build", async () => {
    mockLoad.mockResolvedValue(null);
    const res = await GET(req("GET"));
    expect(await res.json()).toEqual({ universe: null, watch: [] });
  });

  it("returns sorted symbols and the active watch", async () => {
    mockLoad.mockResolvedValue({ id: "u1", refreshedAt: new Date("2026-11-20T00:00:00Z"), symbols: new Set(["BBB", "AAA"]) });
    mockWatch.mockResolvedValue([{ id: "w1", symbol: "SMOL" }]);
    const json = await (await GET(req("GET"))).json();
    expect(json.universe).toEqual({ id: "u1", refreshedAt: "2026-11-20T00:00:00.000Z", symbols: ["AAA", "BBB"] });
    expect(json.watch).toHaveLength(1);
  });
});

describe("POST /api/harvest/universe", () => {
  it("stores a valid build", async () => {
    mockSave.mockResolvedValue("u9");
    const res = await POST(req("POST", { directoryCount: 100, prefilterCount: 10, members: [member] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "u9", memberCount: 1 });
  });

  it("returns 400 for a malformed build", async () => {
    const res = await POST(req("POST", { directoryCount: 100, members: [{ symbol: "AAA" }] }));
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns 500 when the store refuses an undersized build", async () => {
    mockSave.mockRejectedValue(new Error("Universe build has 1 members (< 50); not stored"));
    const res = await POST(req("POST", { directoryCount: 100, prefilterCount: 10, members: [member] }));
    expect(res.status).toBe(500);
  });
});
