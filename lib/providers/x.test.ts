import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "./errors";
import { fetchLinkedXPosts, fetchXPosts, postsFromProfileDocument } from "./x";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = "2026-10-26T05:00:00.000Z";
const TOKEN = "test-bearer";

function xClient(fetchImpl: typeof fetch) {
  return {
    bearerToken: TOKEN,
    fetchImpl,
    now: () => new Date(NOW),
    sleep: async () => undefined,
  };
}

test("loads original posts inside the requested window", async () => {
  const urls: string[] = [];
  const events = await fetchXPosts(
    {
      ca: CA,
      handle: "circle",
      since: new Date("2026-10-26T00:00:00.000Z"),
    },
    xClient(async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      if (url.includes("/users/by/username/")) {
        return Response.json({
          data: { id: "99", username: "circle", name: "Circle" },
        });
      }
      return Response.json({
        data: [
          {
            id: "55",
            text: "Hello   trench\nworld",
            created_at: "2026-10-26T04:00:00.000Z",
          },
          {
            id: "40",
            text: "too old",
            created_at: "2026-10-25T23:00:00.000Z",
          },
          {
            id: "41",
            text: "   ",
            created_at: "2026-10-26T04:30:00.000Z",
          },
        ],
      });
    }),
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event);
  assert.equal(event.kind, "x_post");
  if (event.kind !== "x_post") return;
  assert.equal(event.postId, "55");
  assert.equal(event.account, "circle");
  assert.equal(event.textExcerpt, "Hello trench world");
  assert.equal(event.postUrl, "https://x.com/circle/status/55");
  assert.equal(event.occurredAt, "2026-10-26T04:00:00.000Z");
  assert.equal(event.evidence[0]?.source, "x");
  assert.match(urls[1] ?? "", /exclude=retweets/);
  assert.match(urls[1] ?? "", /start_time=2026-10-26T00%3A00%3A00Z/);
  assert.match(urls[1] ?? "", /max_results=10/);
});

test("returns an empty list when the account has no posts and does not retry auth failures", async () => {
  const empty = await fetchXPosts(
    {
      ca: CA,
      handle: "circle",
      since: new Date("2026-10-26T00:00:00.000Z"),
    },
    xClient(async (input) => {
      if (String(input).includes("/users/by/username/")) {
        return Response.json({ data: { id: "99", username: "circle" } });
      }
      return Response.json({ meta: { result_count: 0 } });
    }),
  );
  assert.deepEqual(empty, []);

  let calls = 0;
  await assert.rejects(
    () =>
      fetchXPosts(
        {
          ca: CA,
          handle: "circle",
          since: new Date("2026-10-26T00:00:00.000Z"),
        },
        xClient(async () => {
          calls += 1;
          return new Response("nope", { status: 401 });
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("reads posts from a public profile when the API token is missing", async () => {
  const createdAtMs = Date.parse("2026-10-26T04:00:00.000Z");
  const html = [
    `rest_id\\":\\"55\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"circle\\"`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"Hello trench\\",\\"hashtag_entities\\"`,
    `rest_id\\":\\"77\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"someone\\"`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"quoted\\",\\"hashtag_entities\\"`,
    `rest_id\\":\\"40\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"circle\\"`,
    `created_at_ms\\":${Date.parse("2026-10-25T23:00:00.000Z")}`,
    `full_text\\":\\"too old\\",\\"hashtag_entities\\"`,
  ].join(",");
  assert.equal(postsFromProfileDocument(html, "circle").length, 2);

  const urls: string[] = [];
  const events = await fetchLinkedXPosts(
    {
      ca: CA,
      handle: "circle",
      since: new Date("2026-10-26T00:00:00.000Z"),
    },
    {
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.startsWith("https://x.com/")) {
          return new Response("down", { status: 503 });
        }
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      now: () => new Date(NOW),
      sleep: async () => undefined,
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "x_post");
  if (events[0]?.kind !== "x_post") return;
  assert.equal(events[0].postId, "55");
  assert.equal(events[0].textExcerpt, "Hello trench");
  assert.equal(events[0].postUrl, "https://x.com/circle/status/55");
  assert.equal(urls.some((url) => url.includes("r.jina.ai")), true);
});
