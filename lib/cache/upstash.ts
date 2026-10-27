import type { KvStore } from "./store";

export type UpstashStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
};

/**
 * Upstash Redis REST. Commands are JSON arrays posted to the database URL.
 * The token stays in the Authorization header and is never written into errors.
 */
export function createUpstashStore(options: UpstashStoreOptions): KvStore {
  const endpoint = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function command(args: unknown[]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        cache: "no-store",
      });
    } catch (error) {
      throw new Error("Redis request failed.", { cause: error });
    }
    if (!response.ok) {
      throw new Error(`Redis request failed with status ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error("Redis returned invalid JSON.", { cause: error });
    }
    if (!isRecord(body)) throw new Error("Redis returned an unexpected payload.");
    if (typeof body.error === "string" && body.error) {
      throw new Error("Redis command failed.");
    }
    return body.result;
  }

  return {
    async get(key) {
      const result = await command(["GET", key]);
      return typeof result === "string" ? result : null;
    },
    async set(key, value, ttlSeconds) {
      const result = await command(["SET", key, value, "EX", Math.max(1, ttlSeconds)]);
      if (result !== "OK") throw new Error("Redis SET failed.");
    },
    async increment(key, ttlSeconds) {
      const count = await command(["INCR", key]);
      if (typeof count !== "number" || !Number.isFinite(count)) {
        throw new Error("Redis INCR failed.");
      }
      const ttl = await command(["TTL", key]);
      let ttlSecondsLeft: number;
      if (typeof ttl !== "number" || ttl < 1) {
        const applied = await command(["EXPIRE", key, Math.max(1, ttlSeconds)]);
        if (applied !== 1 && applied !== true) {
          throw new Error("Redis EXPIRE failed.");
        }
        ttlSecondsLeft = Math.max(1, ttlSeconds);
      } else {
        ttlSecondsLeft = ttl;
      }
      return { count, ttlSeconds: ttlSecondsLeft };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
