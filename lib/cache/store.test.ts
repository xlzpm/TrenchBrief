import assert from "node:assert/strict";
import test from "node:test";

import { fixtureMarket } from "../providers/fixture";
import { createLogger } from "../observability/log";
import {
  MARKET_CACHE_TTL_SECONDS,
  marketCacheKey,
  readThroughMarketCache,
} from "./market-cache";
import { createMemoryStore, createResilientStore, type KvStore } from "./store";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER = "So11111111111111111111111111111111111111112";
const silent = createLogger(() => {});

test("memory entries expire and counters reset with the window", async () => {
  let now = 1_000_000;
  const store = createMemoryStore(() => now);
  await store.set("market", "snap", 10);
  assert.equal(await store.get("market"), "snap");
  now += 10_000;
  assert.equal(await store.get("market"), null);

  assert.deepEqual(await store.increment("rl", 10), { count: 1, ttlSeconds: 10 });
  assert.deepEqual(await store.increment("rl", 10), { count: 2, ttlSeconds: 10 });
  now += 10_000;
  assert.equal((await store.increment("rl", 10)).count, 1);
});

test("a failed primary store stays on the memory fallback", async () => {
  const primary: KvStore = {
    async get() {
      throw new Error("redis down");
    },
    async set() {
      throw new Error("redis down");
    },
    async increment() {
      throw new Error("redis down");
    },
  };
  let failures = 0;
  const resilient = createResilientStore(primary, createMemoryStore(), () => {
    failures += 1;
  });
  assert.equal(resilient.mode(), "redis");
  await resilient.store.set("market", "snap", 30);
  assert.equal(failures, 1);
  assert.equal(resilient.mode(), "memory");
  assert.equal(await resilient.store.get("market"), "snap");
  assert.equal((await resilient.store.increment("rl", 30)).count, 1);
  assert.equal(failures, 1);
});

test("market snapshots are reused until they expire", async () => {
  const store = createMemoryStore();
  let reads = 0;
  const load = async (ca: string) => {
    reads += 1;
    return fixtureMarket(ca);
  };

  const first = await readThroughMarketCache(store, CA, load, silent);
  const second = await readThroughMarketCache(store, CA, load, silent);
  assert.equal(first.cache, "miss");
  assert.equal(second.cache, "hit");
  assert.equal(reads, 1);
  assert.equal(second.result.snapshot.name, "Fixture Coin");
  assert.equal(MARKET_CACHE_TTL_SECONDS, 45);

  const other = await readThroughMarketCache(store, OTHER, load, silent);
  assert.equal(other.cache, "miss");
  assert.equal(reads, 2);
  assert.equal(other.result.snapshot.ca, OTHER);
});

test("a broken or mismatched cache entry is loaded again", async () => {
  const store = createMemoryStore();
  await store.set(marketCacheKey(CA), "{", 30);
  let reads = 0;
  const load = async (ca: string) => {
    reads += 1;
    return fixtureMarket(ca);
  };
  const read = await readThroughMarketCache(store, CA, load, silent);
  assert.equal(read.cache, "miss");
  assert.equal(reads, 1);

  await store.set(marketCacheKey(CA), JSON.stringify(fixtureMarket(OTHER)), 30);
  const replaced = await readThroughMarketCache(store, CA, load, silent);
  assert.equal(replaced.cache, "miss");
  assert.equal(replaced.result.snapshot.ca, CA);
  assert.equal(reads, 2);
});

test("provider failures are not cached", async () => {
  const store = createMemoryStore();
  let reads = 0;
  const load = async () => {
    reads += 1;
    throw new Error("provider down");
  };
  await assert.rejects(() => readThroughMarketCache(store, CA, load, silent));
  await assert.rejects(() => readThroughMarketCache(store, CA, load, silent));
  assert.equal(reads, 2);
  assert.equal(await store.get(marketCacheKey(CA)), null);
});
