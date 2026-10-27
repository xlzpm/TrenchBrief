import type { KvStore } from "@/lib/cache/store";

/** One brief lookup per two seconds, sustained, for a single client. */
export const BRIEF_RATE_LIMIT = {
  limit: 30,
  windowSeconds: 60,
} as const;

/** Live price checks. A tab polls about four times a minute. */
export const QUOTE_RATE_LIMIT = {
  limit: 60,
  windowSeconds: 60,
} as const;

export type RateLimitPolicy = {
  limit: number;
  windowSeconds: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export function consumeRateLimit(
  store: KvStore,
  bucket: string,
  clientKey: string,
  policy: RateLimitPolicy = BRIEF_RATE_LIMIT,
  now: () => number = Date.now,
): Promise<RateLimitDecision> {
  const current = now();
  const windowMs = policy.windowSeconds * 1000;
  const windowStart = Math.floor(current / windowMs) * windowMs;
  const key = `rl:v1:${bucket}:${clientKey}:${windowStart}`;
  const ttlSeconds = Math.max(1, Math.ceil((windowStart + windowMs - current) / 1000));
  return store.increment(key, ttlSeconds).then(({ count, ttlSeconds: ttl }) => {
    const allowed = count <= policy.limit;
    return {
      allowed,
      limit: policy.limit,
      remaining: allowed ? policy.limit - count : 0,
      retryAfterSeconds: allowed ? 0 : ttl,
    };
  });
}

export function rateLimitHeaders(decision: RateLimitDecision): Headers {
  const headers = new Headers();
  headers.set("x-ratelimit-limit", String(decision.limit));
  headers.set("x-ratelimit-remaining", String(decision.remaining));
  if (!decision.allowed) {
    headers.set("retry-after", String(Math.max(1, decision.retryAfterSeconds)));
  }
  return headers;
}
