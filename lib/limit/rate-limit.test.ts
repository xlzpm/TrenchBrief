import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStore } from "../cache/store";
import { BRIEF_RATE_LIMIT, consumeRateLimit } from "./rate-limit";

test("a client is limited inside the window and resets when it ends", async () => {
  let now = 0;
  const store = createMemoryStore(() => now);
  const policy = { limit: 2, windowSeconds: 60 };
  const first = await consumeRateLimit(store, "brief", "alice", policy, () => now);
  const second = await consumeRateLimit(store, "brief", "alice", policy, () => now);
  const blocked = await consumeRateLimit(store, "brief", "alice", policy, () => now);

  assert.equal(BRIEF_RATE_LIMIT.limit, 30);
  assert.equal(BRIEF_RATE_LIMIT.windowSeconds, 60);
  assert.deepEqual(first, {
    allowed: true,
    limit: 2,
    remaining: 1,
    retryAfterSeconds: 0,
  });
  assert.equal(second.remaining, 0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 60);

  const other = await consumeRateLimit(store, "brief", "bob", policy, () => now);
  assert.equal(other.allowed, true);
  assert.equal(other.remaining, 1);

  now += 60_000;
  const next = await consumeRateLimit(store, "brief", "alice", policy, () => now);
  assert.equal(next.allowed, true);
  assert.equal(next.remaining, 1);
});
