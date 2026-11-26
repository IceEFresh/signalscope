import { describe, it, expect, vi } from "vitest";
import { BODY_MAX_BYTES, captureWarnings, healthcheck, hostOf, redact, summaryLines, trimBody, type PingFetch } from "@/lib/harvester/healthcheck";

const URL_ = "https://hc-ping.com/1f2e3d4c-aaaa-bbbb-cccc-0123456789ab";

function setup(fetchImpl?: PingFetch) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetch = vi.fn<PingFetch>(
    fetchImpl ??
      (async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        return { ok: true, status: 200 };
      }),
  );
  const log = vi.fn();
  const warn = vi.fn();
  return { calls, fetch, log, warn };
}

/** The harvester's wrapper shape: start, run, success or /fail with the summary, rethrow. */
async function runWith<T>(p: ReturnType<typeof healthcheck>, run: () => Promise<T>): Promise<T> {
  await p.start();
  try {
    const v = await run();
    await p.success(summaryLines("harvest ok", []));
    return v;
  } catch (err) {
    await p.fail(summaryLines(`harvest failed: ${err instanceof Error ? err.message : err}`, []));
    throw err;
  }
}

describe("healthcheck", () => {
  it("unset URL: no calls, one info line", async () => {
    const t = setup();
    for (const url of [undefined, "", "  "]) {
      const p = healthcheck(url, t);
      expect(p.enabled).toBe(false);
      await p.start();
      await p.success(["x"]);
      await p.fail(["y"]);
    }
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith("[healthcheck] HEALTHCHECK_URL not set: no dead-man's switch pings this run");
  });

  it("start + success: GET /start, then POST to the base URL with the summary", async () => {
    const t = setup();
    await runWith(healthcheck(`${URL_}/`, t), async () => 1);
    expect(t.calls.map((c) => [c.url, c.method])).toEqual([
      [`${URL_}/start`, "GET"],
      [URL_, "POST"],
    ]);
    expect(t.calls[1].body).toBe("harvest ok\n0 warning(s) this run");
  });

  it("a throw sends /fail with the error and rethrows the original error", async () => {
    const t = setup();
    const boom = new Error("Yahoo chart 500");
    await expect(
      runWith(healthcheck(URL_, t), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(t.calls.map((c) => c.url)).toEqual([`${URL_}/start`, `${URL_}/fail`]);
    expect(t.calls[1].body).toContain("harvest failed: Yahoo chart 500");
  });

  it("a ping timeout or HTTP error only warns; the run still succeeds", async () => {
    const t = setup(async (_url, init) => {
      await new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
      return { ok: true, status: 200 };
    });
    const p = healthcheck(URL_, { ...t, timeoutMs: 5 });
    await expect(runWith(p, async () => "harvested")).resolves.toBe("harvested");
    expect(t.warn).toHaveBeenCalledTimes(2);
    expect(t.warn.mock.calls[0][0]).toBe("[healthcheck] hc-ping.com ping/start failed: TimeoutError");

    const h = setup(async () => ({ ok: false, status: 503 }));
    await healthcheck(URL_, h).fail(["x"]);
    expect(h.warn).toHaveBeenCalledWith("[healthcheck] hc-ping.com ping/fail returned HTTP 503");
  });

  it("the body is trimmed to 2 KB (whole characters, marked)", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `[source] warning number ${i} — émoji ✓`);
    const body = trimBody(lines);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(body.endsWith("…(truncated)")).toBe(true);
    expect(body).not.toContain("�");
    const t = setup();
    await healthcheck(URL_, t).success(lines);
    expect(Buffer.byteLength(t.calls[0].body!)).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(trimBody(["short"])).toBe("short");
  });

  it("the URL is never printed in full: logs show the host; the body redacts it and strips query strings", async () => {
    const t = setup(async () => {
      throw new Error("ECONNRESET");
    });
    const p = healthcheck(URL_, t);
    await p.start();
    await p.fail([`posting to ${URL_}/fail failed`, "GET https://api.example.com/v1/x?apikey=SECRET123&b=2 returned 500"]);
    const printed = [...t.log.mock.calls, ...t.warn.mock.calls].flat().join("\n");
    expect(printed).toContain("hc-ping.com");
    expect(printed).not.toContain("1f2e3d4c");
    expect(t.log).toHaveBeenCalledWith("[healthcheck] pinging hc-ping.com");
    const body = trimBody([`posting to ${URL_}/fail failed`, "GET https://api.example.com/v1/x?apikey=SECRET123&b=2 returned 500"], BODY_MAX_BYTES, URL_);
    expect(body).not.toContain("1f2e3d4c");
    expect(body).not.toContain("SECRET123");
    expect(body).toContain("https://hc-ping.com/…/fail failed");
    expect(body).toContain("https://api.example.com/v1/x?… returned 500");
    expect(hostOf("not a url")).toBe("(invalid url)");
    expect(redact("no urls here")).toBe("no urls here");
  });
});

describe("captureWarnings", () => {
  it("collects the first line of each warning and still prints it; restore undoes it", () => {
    const printed: unknown[][] = [];
    const target = { warn: (...a: unknown[]) => void printed.push(a) };
    const cap = captureWarnings(target);
    target.warn("[finra] short volume missing\nmore detail");
    target.warn(new Error("boom"));
    expect(cap.lines()).toEqual(["[finra] short volume missing", "boom"]);
    expect(printed).toHaveLength(2);
    cap.restore();
    target.warn("after");
    expect(cap.lines()).toHaveLength(2);
    expect(summaryLines("harvest ok", cap.lines())).toEqual(["harvest ok", "2 warning(s) this run:", "[finra] short volume missing", "boom"]);
  });
});
