/**
 * OPS-1: harvest dead-man's switch (docs/PHASE3-PREP.md §OPS-1). Pings a healthchecks.io-style
 * URL (`HEALTHCHECK_URL`): `{url}/start` when the run begins, `{url}` on success, `{url}/fail`
 * when the run throws or ends without a harvest. The external check alerts when no success
 * arrives by its deadline.
 *
 * - Unset URL: nothing is sent; one info line at startup.
 * - Each ping has a 10 s timeout; a failed ping only logs a warning and never fails the harvest.
 * - The body (≤ 2 KB) is the run's summary: the warnings it logged. The URL is a secret: only its
 *   host is ever printed, and query strings are stripped from any URL in the body.
 */
export const PING_TIMEOUT_MS = 10_000;
export const BODY_MAX_BYTES = 2048;

export type PingFetch = (url: string, init: { method: string; body?: string; signal: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;

export interface Pinger {
  readonly enabled: boolean;
  start(): Promise<void>;
  success(lines: readonly string[]): Promise<void>;
  fail(lines: readonly string[]): Promise<void>;
}

/** The URL's host only (the path holds the check's secret UUID). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

/** Strip query strings (tokens, keys) from every URL in a line, and the ping URL itself down to its host. */
export function redact(line: string, pingUrl?: string): string {
  let out = line;
  if (pingUrl) out = out.split(pingUrl.replace(/\/+$/, "")).join(`https://${hostOf(pingUrl)}/…`);
  return out.replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, "$1?…");
}

/** Lines joined and cut to ≤ `max` UTF-8 bytes (whole characters), with a marker when cut. */
export function trimBody(lines: readonly string[], max = BODY_MAX_BYTES, pingUrl?: string): string {
  const text = lines.map((l) => redact(l, pingUrl)).join("\n");
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  const marker = "\n…(truncated)";
  let cut = buf.subarray(0, max - Buffer.byteLength(marker)).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1); // a split multi-byte character
  return cut + marker;
}

const defaultFetch: PingFetch = (url, init) => fetch(url, init);

export function healthcheck(
  url: string | undefined,
  deps: { fetch?: PingFetch; log?: (msg: string) => void; warn?: (msg: string) => void; timeoutMs?: number } = {},
): Pinger {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const base = url?.trim().replace(/\/+$/, "");
  if (!base) {
    log("[healthcheck] HEALTHCHECK_URL not set: no dead-man's switch pings this run");
    return { enabled: false, start: async () => {}, success: async () => {}, fail: async () => {} };
  }
  const host = hostOf(base);
  log(`[healthcheck] pinging ${host}`);
  const f = deps.fetch ?? defaultFetch;
  const ping = async (suffix: string, lines?: readonly string[]) => {
    try {
      const res = await f(`${base}${suffix}`, {
        method: lines ? "POST" : "GET",
        ...(lines ? { body: trimBody(lines, BODY_MAX_BYTES, base), headers: { "Content-Type": "text/plain; charset=utf-8" } } : {}),
        signal: AbortSignal.timeout(deps.timeoutMs ?? PING_TIMEOUT_MS),
      });
      if (!res.ok) warn(`[healthcheck] ${host} ping${suffix || " (success)"} returned HTTP ${res.status}`);
    } catch (err) {
      warn(`[healthcheck] ${host} ping${suffix || " (success)"} failed: ${err instanceof Error ? err.name : "error"}`);
    }
  };
  return {
    enabled: true,
    start: () => ping("/start"),
    success: (lines) => ping("", lines),
    fail: (lines) => ping("/fail", lines),
  };
}

/** Collects the run's warning lines (the first line of each console.warn) for the ping body. */
export function captureWarnings(target: { warn: (...a: unknown[]) => void } = console): { lines: () => string[]; restore: () => void } {
  const seen: string[] = [];
  const orig = target.warn;
  target.warn = (...a: unknown[]) => {
    const first = a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ").split("\n")[0];
    if (first) seen.push(first);
    orig.apply(target, a);
  };
  return { lines: () => [...seen], restore: () => void (target.warn = orig) };
}

/** The body: a headline, then the warnings (newest last). */
export function summaryLines(headline: string, warnings: readonly string[]): string[] {
  return [headline, `${warnings.length} warning(s) this run${warnings.length ? ":" : ""}`, ...warnings];
}
