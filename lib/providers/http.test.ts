import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "./errors";
import { fetchWithRetry, getJson } from "./http";

test("retries a server error and then returns the next success", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const response = await fetchWithRetry(
    "https://example.com/market",
    {},
    {
      provider: "birdeye",
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("busy", { status: 500 });
        return new Response("ok", { status: 200 });
      },
    },
  );

  assert.equal(await response.text(), "ok");
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  assert.ok((sleeps[0] ?? 0) > 0);
});

test("caps Retry-After and does not retry a missing resource", async () => {
  const sleeps: number[] = [];
  let rateCalls = 0;
  const response = await fetchWithRetry(
    "https://example.com/limited",
    {},
    {
      provider: "dexscreener",
      maxDelayMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        rateCalls += 1;
        if (rateCalls === 1) {
          return new Response("slow", {
            status: 429,
            headers: { "retry-after": "30" },
          });
        }
        return new Response("ok", { status: 200 });
      },
    },
  );
  assert.equal(await response.text(), "ok");
  assert.deepEqual(sleeps, [250]);

  let missingCalls = 0;
  await assert.rejects(
    () =>
      fetchWithRetry(
        "https://example.com/missing",
        {},
        {
          provider: "birdeye",
          sleep: async () => {
            throw new Error("should not sleep");
          },
          fetchImpl: async () => {
            missingCalls += 1;
            return new Response("missing", { status: 404 });
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "not_found");
      assert.equal(error.retryable, false);
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.equal(missingCalls, 1);
});

test("retries a dropped connection and rejects invalid JSON without retrying", async () => {
  let calls = 0;
  const payload = await getJson(
    "https://example.com/data",
    {},
    {
      provider: "jupiter",
      sleep: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return Response.json({ ok: true });
      },
    },
  );
  assert.deepEqual(payload, { ok: true });
  assert.equal(calls, 2);

  let invalidCalls = 0;
  await assert.rejects(
    () =>
      getJson(
        "https://example.com/bad",
        {},
        {
          provider: "jupiter",
          sleep: async () => {
            throw new Error("should not sleep");
          },
          fetchImpl: async () => {
            invalidCalls += 1;
            return new Response("<html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
  assert.equal(invalidCalls, 1);
});
