import {
  ProviderError,
  providerLabel,
  type ProviderName,
} from "./errors";

export type ProviderClientOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
};

export type FetchRetryOptions = ProviderClientOptions & {
  provider: ProviderName;
  acceptStatus?: (status: number) => boolean;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export const PUBLIC_PAGE_USER_AGENT =
  "Mozilla/5.0 (compatible; TrenchBrief/0.1; +https://x.com)";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  options: FetchRetryOptions,
): number {
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  if (retryAfterMs != null) return Math.min(Math.max(retryAfterMs, 0), maxDelayMs);
  const baseDelayMs = options.baseDelayMs ?? 200;
  const random = options.random ?? Math.random;
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential * (0.8 + random() * 0.4), maxDelayMs);
}

function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(header);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function isTransientFetchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      error.name === "TypeError")
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is unused after a failed or redirected response.
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions,
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const acceptStatus =
    options.acceptStatus ?? ((status: number) => status >= 200 && status < 300);
  const timeoutMs = options.timeoutMs ?? 8_000;
  const label = providerLabel(options.provider);
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    let retryAfterMs: number | null = null;

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal,
        cache: "no-store",
      });
      if (acceptStatus(response.status)) return response;
      await cancelBody(response);
      const retryable = isRetryableStatus(response.status);
      retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
        (options.now ?? (() => new Date()))().getTime(),
      );
      lastError = new ProviderError(
        `${label} request failed with status ${response.status}.`,
        {
          provider: options.provider,
          status: response.status,
          retryable,
          code: response.status === 404 ? "not_found" : "http",
        },
      );
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (error instanceof ProviderError) {
        lastError = error;
      } else {
        lastError = new ProviderError(`${label} request failed.`, {
          provider: options.provider,
          status: null,
          retryable: isTransientFetchError(error),
          code: "network",
          cause: error,
        });
      }
    }

    if (!lastError.retryable || attempt === attempts) throw lastError;
    await sleep(retryDelayMs(attempt, retryAfterMs, options));
  }

  throw (
    lastError ??
    new ProviderError(`${label} request failed.`, {
      provider: options.provider,
      status: null,
      retryable: false,
      code: "network",
    })
  );
}

export async function getJson(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const response = await fetchWithRetry(
    url,
    {
      ...init,
      method: "GET",
      headers,
    },
    options,
  );
  const text = await response.text();
  const label = providerLabel(options.provider);
  if (!text.trim()) {
    throw new ProviderError(`${label} returned an empty response.`, {
      provider: options.provider,
      status: response.status,
      retryable: false,
      code: "invalid_response",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderError(`${label} returned invalid JSON.`, {
      provider: options.provider,
      status: response.status,
      retryable: false,
      code: "invalid_response",
      cause: error,
    });
  }
}
