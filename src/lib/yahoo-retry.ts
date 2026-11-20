/**
 * Yahoo fetch resilience, PLAN.md PR 1e: retry transient failures with
 * exponential backoff, and count calls / retries / failures per label for one
 * harvest run so the log shows which source is degrading.
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

export function resetYahooHealth(): void {
  health.clear();
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
export async function withYahooRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = DEFAULT_RETRIES, baseDelayMs = defaultBaseDelayMs(), label = "other" } = opts;
  bump(label, "calls");
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err)) {
        bump(label, "failed");
        throw err;
      }
      bump(label, "retried");
      if (baseDelayMs > 0) await sleep(backoffMs(attempt, baseDelayMs));
    }
  }
}
