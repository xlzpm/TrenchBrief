import { z } from "zod";

import { evidenceLinkSchema } from "@/lib/dto/common";
import { tokenSnapshotSchema } from "@/lib/dto/token-snapshot";
import type { MarketSnapshotResult } from "@/lib/providers/types";
import { log as defaultLog, type Logger } from "@/lib/observability/log";

import type { KvStore } from "./store";

/** Short enough that a price move still shows up on the next lookup. */
export const MARKET_CACHE_TTL_SECONDS = 45;

const cachedMarketSchema = z.object({
  snapshot: tokenSnapshotSchema,
  evidence: z.array(evidenceLinkSchema).min(1),
});

export type CachedMarket = {
  result: MarketSnapshotResult;
  cache: "hit" | "miss";
};

/**
 * Caches a successful market snapshot by contract address.
 * Failures are not stored, so the next lookup can try the providers again.
 */
export async function readThroughMarketCache(
  store: KvStore,
  ca: string,
  load: (ca: string) => Promise<MarketSnapshotResult>,
  logger: Logger = defaultLog,
): Promise<CachedMarket> {
  const key = marketCacheKey(ca);
  const cached = await readCached(store, key, ca, logger);
  if (cached) return { result: cached, cache: "hit" };

  const result = await load(ca);
  try {
    await store.set(key, JSON.stringify(result), MARKET_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn("market.cache_write_failed", {
      ca,
      message: error instanceof Error ? error.message : "Cache write failed.",
    });
  }
  return { result, cache: "miss" };
}

export function marketCacheKey(ca: string): string {
  return `market:v1:${ca}`;
}

async function readCached(
  store: KvStore,
  key: string,
  ca: string,
  logger: Logger,
): Promise<MarketSnapshotResult | null> {
  let raw: string | null;
  try {
    raw = await store.get(key);
  } catch (error) {
    logger.warn("market.cache_read_failed", {
      ca,
      message: error instanceof Error ? error.message : "Cache read failed.",
    });
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = cachedMarketSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.snapshot.ca !== ca) {
      logger.warn("market.cache_stale", { ca });
      return null;
    }
    return parsed.data;
  } catch {
    logger.warn("market.cache_stale", { ca });
    return null;
  }
}
