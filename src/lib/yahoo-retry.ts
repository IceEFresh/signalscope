/**
 * Fetch resilience, PLAN.md PR 1e (Yahoo) and S2 (Capitol Trades, StockTwits):
 * retry transient failures with exponential backoff, honour a 429's Retry-After
 * (up to 60 s), and count calls / retries / failures per label for one harvest
 * run so the log shows which source is degrading. `withYahooRetry` is kept as an
 * alias of `withRetry` so the 1e call sites are unchanged.
 *
 * Retryable: HTTP 429 and 5xx, timeouts and network resets. Not retryable:
 * 4xx other than 429 (unknown symbol, bad request) and parse/validation errors,
 * which would fail the same way again.
 */

export interface RetryOptions {
  /** Retries after the first attempt (default 2, so up to 3 attempts). */
  retries?: number;
  /** First backoff; doubles each retry, plus up to 25% jitter. */
  baseDelayMs?: number;
  /** Counter key for the per-run health summary, e.g. "quote" or "options". */
  label?: string;
}

export const DEFAULT_RETRIES = 2;
/** Override with YAHOO_RETRY_BASE_MS (the test config sets 0 so mocked failures don't sleep). */
export const DEFAULT_BASE_DELAY_MS = 2_000;

/** Longest Retry-After wait honoured (S2). */
export const MAX_RETRY_AFTER_MS = 60_000;

/** An HTTP failure carrying its status and any Retry-After, for fetch-based sources. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Retry-After as milliseconds (delta-seconds or an HTTP date), capped at 60 s; null if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  const secs = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs, MAX_RETRY_AFTER_MS);
}

/** Throws an HttpError for a retryable response (429 / 5xx), with its Retry-After. */
export function throwIfRetryable(res: { status: number; headers: { get(name: string): string | null } }): void {
  if (isRetryableStatus(res.status)) throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
}

/** Status code from an HTTP error thrown by fetch wrappers or yahoo-finance2, if any. */
function statusOf(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.statusCode, e?.response?.status]) if (typeof v === "number") return v;
  const m = err instanceof Error ? err.message.match(/\b(4\d\d|5\d\d)\b/) : null;
  return m ? Number(m[1]) : null;
}

export function isRetryableStatus(status: number | null): boolean {
  return status === 429 || (status != null && status >= 500 && status <= 599);
}

export function isRetryableError(err: unknown): boolean {
  const status = statusOf(err);
  if (status != null) return isRetryableStatus(status);
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /too many requests|timeout|timed out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg);
}

export function backoffMs(attempt: number, baseDelayMs: number, random: () => number = Math.random): number {
  const delay = baseDelayMs * 2 ** attempt;
  return Math.round(delay + delay * 0.25 * random());
}

interface Health {
  calls: number;
  retried: number;
  failed: number;
}
const health = new Map<string, Health>();

function bump(label: string, key: keyof Health): void {
  const h = health.get(label) ?? { calls: 0, retried: 0, failed: 0 };
  h[key]++;
  health.set(label, h);
}

/** P3-0m: HTTP 429 responses per label (each attempt counts), for the [options-ext] line. */
const rateLimited = new Map<string, number>();

export function isRateLimited(err: unknown): boolean {
  const status = statusOf(err);
  if (status != null) return status === 429;
  return /too many requests/i.test(err instanceof Error ? err.message : String(err));
}

export function yahoo429s(label: string): number {
  return rateLimited.get(label) ?? 0;
}

export function resetYahooHealth(): void {
  health.clear();
  rateLimited.clear();
}

export function yahooHealth(): Record<string, Health> {
  return Object.fromEntries([...health.entries()].map(([k, v]) => [k, { ...v }]));
}

/** One line for the harvest log, e.g. "[yahoo] chart: 812 calls, 9 retried, 2 failed; quote: …". */
export function yahooHealthSummary(): string {
  const parts = [...health.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, h]) => `${k}: ${h.calls} calls, ${h.retried} retried, ${h.failed} failed`);
  return `[yahoo] ${parts.length ? parts.join("; ") : "no calls"}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultBaseDelayMs(): number {
  const raw = process.env.YAHOO_RETRY_BASE_MS;
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BASE_DELAY_MS;
}

/**
 * Run `fn`, retrying transient Yahoo failures. Rethrows the last error once
 * retries are exhausted, or immediately for a non-retryable error.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = DEFAULT_RETRIES, baseDelayMs = defaultBaseDelayMs(), label = "other" } = opts;
  bump(label, "calls");
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimited(err)) rateLimited.set(label, (rateLimited.get(label) ?? 0) + 1);
      if (attempt >= retries || !isRetryableError(err)) {
        bump(label, "failed");
        throw err;
      }
      bump(label, "retried");
      const retryAfter = err instanceof HttpError ? err.retryAfterMs : null;
      const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(baseDelayMs > 0 ? backoffMs(attempt, baseDelayMs) : 0, retryAfter ?? 0));
      if (wait > 0) await sleep(wait);
    }
  }
}

/** 1e name, kept so existing Yahoo call sites don't change. */
export const withYahooRetry = withRetry;
