import { env } from "@/lib/env";
import { errorFields, log } from "@/lib/observability/log";

import {
  createMemoryStore,
  createResilientStore,
  type KvStore,
  type StoreMode,
} from "./store";
import { createUpstashStore } from "./upstash";

type StoreBinding = {
  store: KvStore;
  mode: () => StoreMode;
};

const globalStore = globalThis as typeof globalThis & {
  trenchKv?: StoreBinding;
};

/**
 * Redis when both Upstash variables are set, otherwise memory.
 * A Redis failure sticks to memory for the life of the process.
 */
export function getKvStore(): KvStore {
  return binding().store;
}

export function describeKvStore(): { cache: StoreMode; rateLimit: StoreMode } {
  const mode = binding().mode();
  return { cache: mode, rateLimit: mode };
}

export function resetKvStoreForTests(next?: StoreBinding): void {
  globalStore.trenchKv = next;
}

function binding(): StoreBinding {
  if (!globalStore.trenchKv) {
    globalStore.trenchKv = createConfiguredStore();
  }
  return globalStore.trenchKv;
}

function createConfiguredStore(): StoreBinding {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { store: createMemoryStore(), mode: () => "memory" };
  }
  return createResilientStore(
    createUpstashStore({ url, token }),
    createMemoryStore(),
    (error) => {
      log.warn("redis.fallback", errorFields(error));
    },
  );
}
