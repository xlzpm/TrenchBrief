export type KvStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  increment(
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }>;
};

type MemoryEntry = {
  value: string;
  expiresAt: number;
};

/**
 * Process-local store used when Redis is unset, and as the fallback when
 * Redis cannot be reached. Entries disappear with the process.
 */
export function createMemoryStore(now: () => number = Date.now): KvStore {
  const entries = new Map<string, MemoryEntry>();

  function read(key: string): MemoryEntry | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async get(key) {
      return read(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, {
        value,
        expiresAt: now() + Math.max(1, ttlSeconds) * 1000,
      });
    },
    async increment(key, ttlSeconds) {
      const current = read(key);
      const count = current ? Number.parseInt(current.value, 10) + 1 : 1;
      const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
      const expiresAt = current
        ? current.expiresAt
        : now() + Math.max(1, ttlSeconds) * 1000;
      entries.set(key, { value: String(safeCount), expiresAt });
      return {
        count: safeCount,
        ttlSeconds: Math.max(1, Math.ceil((expiresAt - now()) / 1000)),
      };
    },
  };
}

export type StoreMode = "memory" | "redis";

/**
 * After the primary store fails once, later calls stay on the fallback.
 * A dead Redis should not add a timeout to every brief.
 */
export function createResilientStore(
  primary: KvStore,
  fallback: KvStore,
  onFailure: (error: unknown) => void,
): { store: KvStore; mode: () => StoreMode } {
  let degraded = false;

  async function call<T>(op: (store: KvStore) => Promise<T>): Promise<T> {
    if (degraded) return op(fallback);
    try {
      return await op(primary);
    } catch (error) {
      degraded = true;
      onFailure(error);
      return op(fallback);
    }
  }

  return {
    mode: () => (degraded ? "memory" : "redis"),
    store: {
      get: (key) => call((store) => store.get(key)),
      set: (key, value, ttlSeconds) => call((store) => store.set(key, value, ttlSeconds)),
      increment: (key, ttlSeconds) => call((store) => store.increment(key, ttlSeconds)),
    },
  };
}
