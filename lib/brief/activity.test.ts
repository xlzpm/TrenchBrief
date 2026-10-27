import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStore } from "../cache/store";
import { parseTimelineEvent } from "../dto/event";
import { parseTokenSnapshot } from "../dto/token-snapshot";
import { createLogger } from "../observability/log";
import { checkWebsite } from "../providers/website-monitor";
import { readLinkedActivity } from "./activity";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const AT = "2026-10-26T05:00:00.000Z";

function snapshot(website: string | null) {
  return parseTokenSnapshot({
    ca: CA,
    name: "Fixture Coin",
    symbol: "FIX",
    imageUrl: null,
    priceUsd: 1,
    liquidityUsd: 10,
    volumeUsd: { "1h": null, "6h": null, "12h": null, "24h": null },
    website,
    socials: { xHandle: null, xUrl: null },
    capturedAt: AT,
  });
}

function page(body: string): string {
  return `<html><head><title>Alpha</title></head><body><p>${body}</p></body></html>`;
}

test("a website baseline is silent, and the next text change is kept", async () => {
  const store = createMemoryStore();
  const logger = createLogger(() => {});
  const windowEnd = new Date(AT);
  let body = "Hello";
  const options = {
    fetchImpl: async () =>
      new Response(page(body), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    resolveHost: async () => ["93.184.216.34"],
    sleep: async () => undefined,
    now: () => windowEnd,
  };
  const first = await readLinkedActivity({
    snapshot: snapshot("https://example.com/token"),
    period: "24h",
    windowEnd,
    store,
    logger,
    now: () => windowEnd,
    recheckMs: 0,
    checkWebsite: (input, monitor) => checkWebsite(input, { ...options, ...monitor }),
    readMentions: async () => [],
    readListings: async () => [],
  });
  assert.deepEqual(first.websiteChanges, []);
  assert.equal(first.websiteBaseline?.url, "https://example.com/token");
  assert.equal(first.websiteBaseline?.observedAt, AT);

  body = "Hello there";
  const second = await readLinkedActivity({
    snapshot: snapshot("https://example.com/token"),
    period: "24h",
    windowEnd,
    store,
    logger,
    now: () => new Date(Date.parse(AT) + 61_000),
    recheckMs: 0,
    checkWebsite: (input, monitor) => checkWebsite(input, { ...options, ...monitor }),
    readMentions: async () => [],
    readListings: async () => [],
  });
  assert.equal(second.websiteBaseline, null);
  assert.equal(second.websiteChanges.length, 1);
  assert.equal(second.websiteChanges[0]?.kind, "website");
  if (second.websiteChanges[0]?.kind !== "website") return;
  assert.equal(second.websiteChanges[0].diffSummary, 'Page text changed to "Hello there".');
});

test("an X community link is not monitored as a website", async () => {
  let calls = 0;
  const result = await readLinkedActivity({
    snapshot: snapshot("https://x.com/i/communities/1959652621158875454"),
    period: "24h",
    windowEnd: new Date(AT),
    store: createMemoryStore(),
    logger: createLogger(() => {}),
    checkWebsite: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
    readMentions: async () => [],
    readListings: async () => [],
  });
  assert.equal(calls, 0);
  assert.equal(result.websiteBaseline, null);
  assert.deepEqual(result.websiteChanges, []);
  assert.deepEqual(result.listings, []);
});

test("a mention with an audience replaces the project's copy of the same post", async () => {
  const own = parseTimelineEvent({
    id: "x:9",
    ca: CA,
    kind: "x_post",
    occurredAt: AT,
    title: "New post from @circle",
    evidence: [
      {
        id: "x:9",
        source: "x",
        url: "https://x.com/circle/status/9",
        label: "Post by @circle",
      },
    ],
    account: "circle",
    postId: "9",
    postUrl: "https://x.com/circle/status/9",
    textExcerpt: `hello ${CA}`,
    followers: null,
    about: "account",
  });
  const mention = parseTimelineEvent({
    ...own,
    account: "ansem",
    title: "Call from @ansem",
    textExcerpt: `look at ${CA}`,
    followers: 120_000,
    about: "contract",
    evidence: [
      {
        id: "x:9",
        source: "x",
        url: "https://x.com/ansem/status/9",
        label: "Post by @ansem",
      },
    ],
    postUrl: "https://x.com/ansem/status/9",
  });
  const listing = parseTimelineEvent({
    id: "dex:profile:1:0",
    ca: CA,
    kind: "listing",
    occurredAt: AT,
    title: "Paid DexScreener profile",
    evidence: [
      {
        id: "dex:profile:1:0",
        source: "dexscreener",
        url: `https://dexscreener.com/solana/${CA}`,
        label: "DexScreener token page",
      },
    ],
    url: `https://dexscreener.com/solana/${CA}`,
    placement: "profile",
  });
  const result = await readLinkedActivity({
    snapshot: parseTokenSnapshot({
      ...snapshot(null),
      socials: { xHandle: "circle", xUrl: "https://x.com/circle" },
    }),
    period: "24h",
    windowEnd: new Date(AT),
    store: createMemoryStore(),
    logger: createLogger(() => {}),
    readPosts: async () => [own],
    readMentions: async () => [mention],
    readListings: async () => [listing],
  });
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]?.kind, "x_post");
  if (result.posts[0]?.kind !== "x_post") return;
  assert.equal(result.posts[0].account, "ansem");
  assert.equal(result.posts[0].followers, 120_000);
  assert.equal(result.listings[0]?.kind, "listing");
});

test("every new linked-account post is kept, and token mentions are labeled", async () => {
  function own(postId: string, text: string) {
    return parseTimelineEvent({
      id: `x:${postId}`,
      ca: CA,
      kind: "x_post",
      occurredAt: AT,
      title: "New post from @circle",
      evidence: [
        {
          id: `x:${postId}`,
          source: "x",
          url: `https://x.com/circle/status/${postId}`,
          label: "Post by @circle",
        },
      ],
      account: "circle",
      postId,
      postUrl: `https://x.com/circle/status/${postId}`,
      textExcerpt: text,
      followers: null,
      about: "account",
    });
  }

  const result = await readLinkedActivity({
    snapshot: parseTokenSnapshot({
      ...snapshot(null),
      socials: { xHandle: "circle", xUrl: "https://x.com/circle" },
    }),
    period: "1h",
    windowEnd: new Date(AT),
    store: createMemoryStore(),
    logger: createLogger(() => {}),
    readPosts: async () => [
      own("1", "ANTHROPIC revenue mix widened"),
      own("2", `live ${CA}`),
      own("3", "send $FIX"),
      own("4", "Fixture Coin is migrating"),
      own("5", "buy $SOL"),
    ],
    readMentions: async () => [],
    readListings: async () => [],
  });

  const posts = result.posts.flatMap((event) => (event.kind === "x_post" ? [event] : []));
  assert.deepEqual(
    posts.map((event) => event.postId).sort(),
    ["1", "2", "3", "4", "5"],
  );
  assert.equal(posts.find((event) => event.postId === "1")?.about, "account");
  assert.equal(posts.find((event) => event.postId === "1")?.title, "@circle posted");
  assert.equal(posts.find((event) => event.postId === "2")?.about, "contract");
  assert.equal(posts.find((event) => event.postId === "2")?.title, "@circle posted this contract");
  assert.equal(posts.find((event) => event.postId === "3")?.about, "ticker");
  assert.equal(posts.find((event) => event.postId === "4")?.about, "account");
  assert.equal(posts.find((event) => event.postId === "4")?.title, "@circle posted about FIX");
  assert.equal(posts.find((event) => event.postId === "5")?.title, "@circle posted");
  assert.equal(posts.find((event) => event.postId === "3")?.evidence[0]?.url, "https://x.com/circle/status/3");
});
