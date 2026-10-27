import assert from "node:assert/strict";
import test from "node:test";

import { createUpstashStore } from "./upstash";

const TOKEN = "super-secret-token";

test("Upstash commands use SET EX and never echo the token", async () => {
  const bodies: unknown[] = [];
  const store = createUpstashStore({
    url: "https://example.upstash.io/",
    token: TOKEN,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.upstash.io");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      const command = JSON.parse(String(init?.body)) as unknown[];
      bodies.push(command);
      if (command[0] === "GET") return Response.json({ result: null });
      if (command[0] === "SET") return Response.json({ result: "OK" });
      if (command[0] === "INCR") return Response.json({ result: 2 });
      if (command[0] === "TTL") return Response.json({ result: -1 });
      if (command[0] === "EXPIRE") return Response.json({ result: 1 });
      return Response.json({ result: null });
    },
  });

  assert.equal(await store.get("market:v1:ca"), null);
  await store.set("market:v1:ca", "{}", 45);
  assert.deepEqual(await store.increment("rl:v1:brief", 60), {
    count: 2,
    ttlSeconds: 60,
  });
  assert.deepEqual(bodies[1], ["SET", "market:v1:ca", "{}", "EX", 45]);
  assert.deepEqual(bodies[4], ["EXPIRE", "rl:v1:brief", 60]);
});

test("Upstash errors omit the token", async () => {
  const denied = createUpstashStore({
    url: "https://example.upstash.io",
    token: TOKEN,
    fetchImpl: async () => new Response("no", { status: 401 }),
  });
  const rejected = createUpstashStore({
    url: "https://example.upstash.io",
    token: TOKEN,
    fetchImpl: async () => Response.json({ error: `WRONGPASS ${TOKEN}` }),
  });

  await assert.rejects(
    () => denied.get("k"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(TOKEN), false);
      assert.match(error.message, /status 401/);
      return true;
    },
  );
  await assert.rejects(
    () => rejected.get("k"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message, "Redis command failed.");
      return true;
    },
  );
});
