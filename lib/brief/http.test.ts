import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStore, type KvStore } from "../cache/store";
import { parseTimelineEvent } from "../dto/event";
import { createLogger } from "../observability/log";
import { ProviderError, MarketUnavailableError } from "../providers/errors";
import { fixtureMarket } from "../providers/fixture";
import { handleBriefGet, handleBriefPost, handleEventsGet, handleQuoteGet } from "./http";
import type { BriefRuntime } from "./run-brief";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-26T12:00:00.000Z";

function runtime(overrides: Partial<BriefRuntime> = {}): BriefRuntime & {
  reads: () => number;
} {
  let reads = 0;
  const base: BriefRuntime = {
    requestId: "req-brief-1",
    clientKey: "203.0.113.8",
    store: createMemoryStore(),
    readMarket: async (ca) => {
      reads += 1;
      return fixtureMarket(ca);
    },
    createShareId: () => SHARE,
    readActivity: async () => ({ posts: [], websiteChanges: [], listings: [] }),
    log: createLogger(() => {}),
  };
  return {
    ...base,
    ...overrides,
    reads: () => reads,
  };
}

function briefUrl(query = `ca=${CA}&period=24h`): string {
  return `http://localhost/api/brief?${query}`;
}

test("GET /api/brief returns a stable brief for a mocked market snapshot", async () => {
  const active = runtime();
  const market = fixtureMarket(CA);
  let published = 0;
  const response = await handleBriefGet(new Request(briefUrl()), {
    runtime: active,
    publish: async (brief) => {
      published += 1;
      return { brief, saved: true };
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "req-brief-1");
  assert.equal(response.headers.get("x-market-cache"), "miss");
  assert.equal(response.headers.get("x-ratelimit-limit"), "30");
  assert.equal(response.headers.get("x-ratelimit-remaining"), "29");
  assert.equal(published, 0);
  assert.equal(active.reads(), 1);
  assert.equal(body.ok, true);
  assert.equal(body.cache, "miss");
  assert.deepEqual(body.brief.snapshot, market.snapshot);
  assert.equal(body.brief.schemaVersion, 1);
  assert.equal(body.brief.shareId, SHARE);
  assert.equal(body.brief.ca, CA);
  assert.equal(body.brief.period, "24h");
  assert.equal(body.brief.generatedAt, AT);
  assert.deepEqual(body.brief.events, []);
  assert.deepEqual(body.brief.summary, []);

  const again = await handleBriefGet(new Request(briefUrl()), {
    runtime: active,
    publish: async (brief) => ({ brief, saved: true }),
  });
  const cached = await again.json();
  assert.equal(again.headers.get("x-market-cache"), "hit");
  assert.equal(cached.cache, "hit");
  assert.equal(active.reads(), 1);
  assert.equal(cached.brief.shareId, SHARE);
});

test("GET /api/token/:ca/events returns the same timeline", async () => {
  const active = runtime();
  const response = await handleEventsGet(
    new Request(`http://localhost/api/token/${CA}/events?period=6h`),
    CA,
    { runtime: active },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    ca: CA,
    period: "6h",
    generatedAt: AT,
    cache: "miss",
    events: [],
  });
});

test("GET /api/token/:ca/quote returns price, liquidity, and volume from the market cache", async () => {
  const active = runtime();
  const market = fixtureMarket(CA);
  const response = await handleQuoteGet(
    new Request(`http://localhost/api/token/${CA}/quote`),
    CA,
    { runtime: active },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-market-cache"), "miss");
  assert.equal(response.headers.get("x-ratelimit-limit"), "60");
  assert.deepEqual(await response.json(), {
    ok: true,
    ca: CA,
    priceUsd: market.snapshot.priceUsd,
    marketCapUsd: market.snapshot.marketCapUsd,
    liquidityUsd: market.snapshot.liquidityUsd,
    volumeUsd: market.snapshot.volumeUsd,
    capturedAt: market.snapshot.capturedAt,
    cache: "miss",
  });

  const again = await handleQuoteGet(
    new Request(`http://localhost/api/token/${CA}/quote`),
    CA,
    { runtime: active },
  );
  assert.equal(again.headers.get("x-market-cache"), "hit");
  assert.equal(active.reads(), 1);

  const invalid = await handleQuoteGet(
    new Request("http://localhost/api/token/nope/quote"),
    "nope",
    { runtime: active },
  );
  assert.equal(invalid.status, 400);
  assert.equal(active.reads(), 1);
});

test("invalid brief queries do not call the market", async () => {
  const active = runtime();
  const response = await handleBriefGet(new Request(briefUrl("ca=nope&period=2h")), {
    runtime: active,
    publish: async (brief) => ({ brief, saved: true }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "invalid");
  assert.equal(active.reads(), 0);

  const events = await handleEventsGet(
    new Request("http://localhost/api/token/nope/events"),
    "nope",
    { runtime: active },
  );
  assert.equal(events.status, 400);
});

test("a missing token is 404 and a provider failure is 503", async () => {
  const missing = runtime({
    readMarket: async () => {
      throw new MarketUnavailableError(CA, [
        new ProviderError("Token was not found.", {
          provider: "dexscreener",
          status: 404,
          retryable: false,
          code: "not_found",
        }),
      ]);
    },
  });
  const notFound = await handleBriefGet(new Request(briefUrl()), { runtime: missing });
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).code, "not_found");

  const down = runtime({
    readMarket: async () => {
      throw new ProviderError("Birdeye request failed with status 503.", {
        provider: "birdeye",
        status: 503,
        retryable: true,
        code: "http",
      });
    },
  });
  const unavailable = await handleBriefGet(new Request(briefUrl()), { runtime: down });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "unavailable");
});

test("the brief route returns 429 after the client budget is spent", async () => {
  const now = 0;
  const active = runtime({
    store: createMemoryStore(() => now),
    now: () => now,
    rateLimit: { limit: 1, windowSeconds: 60 },
  });
  const first = await handleBriefGet(new Request(briefUrl()), { runtime: active });
  const second = await handleBriefGet(new Request(briefUrl()), { runtime: active });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "60");
  assert.equal(active.reads(), 1);
  const body = await second.json();
  assert.equal(body.code, "rate_limited");
  assert.equal(body.retryAfterSeconds, 60);
});

test("website changes and linked X posts are part of the brief", async () => {
  const post = parseTimelineEvent({
    id: "x:55",
    ca: CA,
    kind: "x_post",
    occurredAt: AT,
    title: "New post from @circle",
    evidence: [
      {
        id: "x:55",
        source: "x",
        url: "https://x.com/circle/status/55",
        label: "Post by @circle",
      },
    ],
    account: "circle",
    postId: "55",
    postUrl: "https://x.com/circle/status/55",
    textExcerpt: "Launch is live",
  });
  const website = parseTimelineEvent({
    id: "website:abc",
    ca: CA,
    kind: "website",
    occurredAt: AT,
    title: "Website content changed",
    evidence: [
      {
        id: "website:abc",
        source: "website",
        url: "https://example.com/fix",
        label: "Website",
      },
    ],
    url: "https://example.com/fix",
    contentHash: "a".repeat(64),
    diffSummary: "Page text changed.",
  });
  const unconfirmedPost = parseTimelineEvent({
    id: "x:56",
    ca: CA,
    kind: "x_post",
    occurredAt: AT,
    title: "New post from @circle",
    evidence: [
      {
        id: "x:56",
        source: "x",
        url: "https://example.com/not-x",
        label: "Post by @circle",
      },
    ],
    account: "circle",
    postId: "56",
    postUrl: "https://example.com/not-x",
    textExcerpt: "Launch is live",
  });
  const unconfirmedWebsite = parseTimelineEvent({
    id: "website:def",
    ca: CA,
    kind: "website",
    occurredAt: AT,
    title: "Website content changed",
    evidence: [
      {
        id: "website:def",
        source: "website",
        url: "https://other-site.example/fix",
        label: "Website",
      },
    ],
    url: "https://other-site.example/fix",
    contentHash: "b".repeat(64),
    diffSummary: "Page text changed.",
  });
  const response = await handleBriefGet(new Request(briefUrl()), {
    runtime: runtime({
      now: () => Date.parse(AT),
      readMarket: async (ca) => {
        const market = fixtureMarket(ca);
        return {
          ...market,
          snapshot: {
            ...market.snapshot,
            socials: { xHandle: "circle" as const, xUrl: "https://x.com/circle" },
          },
        };
      },
      readActivity: async () => ({
        posts: [post, unconfirmedPost],
        websiteChanges: [website, unconfirmedWebsite],
        listings: [],
      }),
    }),
    publish: async (brief) => ({ brief, saved: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    body.brief.events.map((event: { kind: string }) => event.kind),
    ["website", "x_post"],
  );
  assert.equal(body.brief.events.some((event: { id: string }) => event.id === "x:56"), false);
  assert.equal(body.brief.events.some((event: { id: string }) => event.id === "website:def"), false);
  assert.match(body.brief.summary[0].text, /Website https:\/\/example.com\/fix changed/);
  assert.match(body.brief.summary[1].text, /@circle posted/);
});

test("the first website copy is a summary note, not a timeline change", async () => {
  const response = await handleBriefGet(new Request(briefUrl()), {
    runtime: runtime({
      readActivity: async () => ({
        posts: [],
        websiteChanges: [],
        listings: [],
        websiteBaseline: {
          url: "https://example.com/fix",
          observedAt: AT,
        },
      }),
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(
    body.brief.events.some((event: { kind: string }) => event.kind === "website"),
    false,
  );
  assert.equal(
    body.brief.summary.some((point: { text: string; eventId: string | null }) =>
      point.eventId == null &&
      point.text.includes("No earlier copy of https://example.com/fix was stored"),
    ),
    true,
  );
});

test("a broken limiter does not block the brief", async () => {
  const memory = createMemoryStore();
  const store: KvStore = {
    get: (key) => memory.get(key),
    set: (key, value, ttlSeconds) => memory.set(key, value, ttlSeconds),
    increment: async () => {
      throw new Error("counter down");
    },
  };
  const response = await handleBriefGet(new Request(briefUrl()), {
    runtime: runtime({ store }),
    publish: async (brief) => ({ brief, saved: true }),
  });
  assert.equal(response.status, 200);
});

test("POST /api/brief saves a fresh version and does not reuse the lookup cache", async () => {
  const active = runtime();
  const lookedUp = await handleBriefGet(new Request(briefUrl()), { runtime: active });
  assert.equal(lookedUp.status, 200);
  assert.equal(active.reads(), 1);

  let published = 0;
  const response = await handleBriefPost(
    new Request("http://localhost/api/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ca: CA, period: "24h" }),
    }),
    {
      runtime: active,
      publish: async (brief) => {
        published += 1;
        return { brief, saved: true };
      },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(published, 1);
  assert.equal(active.reads(), 2);
  assert.equal(response.headers.get("x-market-cache"), "miss");
  assert.equal(body.saved, true);
  assert.equal(body.sharePath, `/brief/${SHARE}`);
  assert.equal(body.brief.shareId, SHARE);

  const invalid = await handleBriefPost(
    new Request("http://localhost/api/brief", {
      method: "POST",
      body: "{",
    }),
    { runtime: active },
  );
  assert.equal(invalid.status, 400);
  assert.equal(active.reads(), 2);

  const unsaved = await handleBriefPost(
    new Request("http://localhost/api/brief", {
      method: "POST",
      body: JSON.stringify({ ca: CA, period: "6h" }),
    }),
    {
      runtime: active,
      publish: async (brief) => ({ brief, saved: false }),
    },
  );
  assert.equal(unsaved.status, 503);
  assert.equal((await unsaved.json()).ok, false);
});
