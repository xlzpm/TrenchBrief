import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../../app/api/health/route";
import { createMemoryStore } from "./store";
import { describeKvStore, resetKvStoreForTests } from "./runtime";

test("health reports the active cache and rate-limit store", async () => {
  resetKvStoreForTests({ store: createMemoryStore(), mode: () => "memory" });
  try {
    assert.deepEqual(describeKvStore(), { cache: "memory", rateLimit: "memory" });
    const response = GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      cache: "memory",
      rateLimit: "memory",
    });
  } finally {
    resetKvStoreForTests();
  }
});
