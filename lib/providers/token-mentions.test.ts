import assert from "node:assert/strict";
import test from "node:test";

import { fetchTokenMentions } from "./token-mentions";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SINCE = new Date("2026-10-26T00:00:00.000Z");

test("recent search keeps a large account that posts the contract", async () => {
  const urls: string[] = [];
  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: "test-bearer",
      now: () => new Date("2026-10-26T05:00:00.000Z"),
      sleep: async () => undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(url);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-bearer");
        return Response.json({
          data: [
            {
              id: "55",
              text: `contract ${CA}`,
              created_at: "2026-10-26T04:00:00.000Z",
              author_id: "9",
              public_metrics: { like_count: 180 },
            },
            {
              id: "56",
              text: "unrelated",
              created_at: "2026-10-26T04:10:00.000Z",
              author_id: "9",
              public_metrics: { like_count: 10 },
            },
          ],
          includes: {
            users: [
              {
                id: "9",
                username: "ansem",
                public_metrics: { followers_count: 480_000 },
              },
            ],
          },
        });
      },
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "x_post");
  if (events[0]?.kind !== "x_post") return;
  assert.equal(events[0].account, "ansem");
  assert.equal(events[0].about, "contract");
  assert.equal(events[0].followers, 480_000);
  assert.equal(events[0].postUrl, "https://x.com/ansem/status/55");
  const searched = new URL(urls[0] ?? "");
  assert.match(searched.pathname, /tweets\/search\/recent$/);
  assert.equal(searched.searchParams.get("query"), `("${CA}" OR $FIX) -is:retweet`);
  assert.match(
    searched.searchParams.get("user.fields") ?? "",
    /verified_type,is_identity_verified,verified_followers_count/,
  );
  assert.equal(events[0].verification, null);
});

test("recent search keeps a business account below the like floor", async () => {
  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: "test-bearer",
      now: () => new Date("2026-10-26T05:00:00.000Z"),
      sleep: async () => undefined,
      fetchImpl: async () =>
        Response.json({
          data: [
            {
              id: "70",
              text: `contract ${CA}`,
              created_at: "2026-10-26T04:00:00.000Z",
              author_id: "3",
              public_metrics: { like_count: 4 },
            },
            {
              id: "71",
              text: `contract ${CA}`,
              created_at: "2026-10-26T04:05:00.000Z",
              author_id: "4",
              public_metrics: { like_count: 80 },
            },
          ],
          includes: {
            users: [
              {
                id: "3",
                username: "circle",
                verified_type: "business",
                public_metrics: { followers_count: 120 },
              },
              {
                id: "4",
                username: "fan",
                verified_type: "blue",
                public_metrics: { followers_count: 900_000 },
              },
            ],
          },
        }),
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "x_post" ? events[0].account : "", "circle");
  assert.equal(events[0]?.kind === "x_post" ? events[0].verification : "", "business");
  assert.equal(events[0]?.kind === "x_post" ? events[0].likes : 0, 4);
});

test("recent search keeps a checked account that clears the audience bar", async () => {
  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: "test-bearer",
      now: () => new Date("2026-10-26T05:00:00.000Z"),
      sleep: async () => undefined,
      fetchImpl: async () =>
        Response.json({
          data: [
            {
              id: "80",
              text: `contract ${CA}`,
              created_at: "2026-10-26T04:00:00.000Z",
              author_id: "8",
              public_metrics: { like_count: 6 },
            },
          ],
          includes: {
            users: [
              {
                id: "8",
                username: "ansem",
                verified_type: "blue",
                is_identity_verified: true,
                verified_followers_count: 1_400,
                public_metrics: { followers_count: 22_000 },
              },
            ],
          },
        }),
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "x_post" ? events[0].checked : false, true);
  assert.equal(events[0]?.kind === "x_post" ? events[0].identityVerified : false, true);
  assert.equal(events[0]?.kind === "x_post" ? events[0].verifiedFollowers : 0, 1_400);
  assert.equal(events[0]?.kind === "x_post" ? events[0].verification : "", null);
});

test("FxTwitter search keeps a large account that names the contract", async () => {
  const urls: string[] = [];
  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: null,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (!url.includes("api.fxtwitter.com")) return new Response("skip", { status: 404 });
        return Response.json({
          code: 200,
          results: [
            {
              type: "status",
              id: "90",
              text: `contract ${CA}`,
              created_timestamp: Date.parse("2026-10-26T04:00:00.000Z") / 1000,
              favorite_count: 220,
              author: { screen_name: "ansem", followers: 480_000 },
            },
          ],
        });
      },
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "x_post" ? events[0].account : "", "ansem");
  assert.equal(events[0]?.kind === "x_post" ? events[0].followers : 0, 480_000);
  assert.equal(events[0]?.kind === "x_post" ? events[0].postUrl : "", "https://x.com/ansem/status/90");
  assert.equal(urls.some((url) => url.includes("api.fxtwitter.com/2/search")), true);
  assert.equal(urls.some((url) => url.startsWith("https://x.com/")), false);
});

test("FxTwitter keeps a government account below the like floor", async () => {
  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: null,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        if (!url.includes("api.fxtwitter.com")) return new Response("skip", { status: 404 });
        return Response.json({
          code: 200,
          results: [
            {
              type: "status",
              id: "91",
              text: `contract ${CA}`,
              created_timestamp: Date.parse("2026-10-26T04:00:00.000Z") / 1000,
              favorite_count: 2,
              author: {
                screen_name: "sec",
                followers: 80,
                verification: { verified: true, type: "government" },
              },
            },
            {
              type: "status",
              id: "92",
              text: `contract ${CA}`,
              created_timestamp: Date.parse("2026-10-26T04:10:00.000Z") / 1000,
              favorite_count: 40,
              author: {
                screen_name: "kol",
                followers: 500_000,
                verification: { verified: true, type: "individual" },
              },
            },
          ],
        });
      },
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "x_post" ? events[0].account : "", "sec");
  assert.equal(events[0]?.kind === "x_post" ? events[0].verification : "", "government");
});

test("public search documents without likes are skipped", async () => {
  const createdAtMs = Date.parse("2026-10-26T04:00:00.000Z");
  const html = [
    `rest_id\\":\\"55\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"ansem\\"`,
    `followers_count\\":480000`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"contract ${CA}\\",\\"hashtag_entities\\"`,
    `rest_id\\":\\"56\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"small\\"`,
    `followers_count\\":40`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"contract ${CA}\\",\\"hashtag_entities\\"`,
    `rest_id\\":\\"58\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"whale\\"`,
    `followers_count\\":20000`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"$FIX is the one\\",\\"hashtag_entities\\"`,
  ].join(",");

  const urls: string[] = [];
  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: null,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.startsWith("https://x.com/")) return new Response("down", { status: 503 });
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
  );

  assert.equal(events.length, 0);
  assert.equal(urls.some((url) => url.includes(encodeURIComponent(`"${CA}"`))), true);
  assert.equal(urls.some((url) => url.includes(encodeURIComponent("$FIX"))), true);
});

test("a public business post is kept when the page does not show likes", async () => {
  const createdAtMs = Date.parse("2026-10-26T04:00:00.000Z");
  const html = [
    `rest_id\\":\\"77\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"circle\\"`,
    `verified_type\\":\\"Business\\"`,
    `followers_count\\":120`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"contract ${CA}\\",\\"hashtag_entities\\"`,
    `rest_id\\":\\"78\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"fan\\"`,
    `verified_type\\":\\"Blue\\"`,
    `followers_count\\":900000`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"contract ${CA}\\",\\"hashtag_entities\\"`,
  ].join(",");

  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: null,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("api.fxtwitter.com")) return new Response("down", { status: 404 });
        if (url.startsWith("https://x.com/")) return new Response("down", { status: 503 });
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "x_post" ? events[0].account : "", "circle");
  assert.equal(events[0]?.kind === "x_post" ? events[0].verification : "", "business");
  assert.equal(events[0]?.kind === "x_post" ? events[0].likes : 0, null);
});

test("a public checked post is kept from audience signals when likes are missing", async () => {
  const createdAtMs = Date.parse("2026-10-26T04:00:00.000Z");
  const html = [
    `rest_id\\":\\"81\\",\\"result\\":{\\"__isTweetResult\\":\\"Tweet\\"`,
    `screen_name\\":\\"ansem\\"`,
    `verified_type\\":\\"Blue\\"`,
    `verified_followers_count\\":1400`,
    `followers_count\\":22000`,
    `is_identity_verified\\":true`,
    `created_at_ms\\":${createdAtMs}`,
    `full_text\\":\\"contract ${CA}\\",\\"hashtag_entities\\"`,
  ].join(",");

  const events = await fetchTokenMentions(
    { ca: CA, symbol: "FIX", since: SINCE },
    {
      bearerToken: null,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("api.fxtwitter.com")) return new Response("down", { status: 404 });
        if (url.startsWith("https://x.com/")) return new Response("down", { status: 503 });
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "x_post" ? events[0].followers : 0, 22_000);
  assert.equal(events[0]?.kind === "x_post" ? events[0].verifiedFollowers : 0, 1_400);
  assert.equal(events[0]?.kind === "x_post" ? events[0].identityVerified : false, true);
  assert.equal(events[0]?.kind === "x_post" ? events[0].checked : false, true);
});
