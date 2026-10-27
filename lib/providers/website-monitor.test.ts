import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "./errors";
import {
  assertPublicHttpUrl,
  checkWebsite,
  extractWebsiteSignals,
} from "./website-monitor";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAGE = "https://example.com/token";
const NOW = "2026-10-26T05:00:00.000Z";

function page(title: string, description: string, body: string): string {
  return `<html><head><script>window.SECRET = "ignore";</script><title>${title}</title><meta name="description" content="${description}"></head><body><p>${body}</p></body></html>`;
}

function monitor(fetchImpl: typeof fetch) {
  return {
    fetchImpl,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    resolveHost: async () => ["93.184.216.34"],
  };
}

test("hashes visible content and ignores script changes", () => {
  const first = extractWebsiteSignals(page("Hello &amp; Co", "A token site", "Launch is live"));
  const withOtherScript = extractWebsiteSignals(
    page("Hello &amp; Co", "A token site", "Launch is live").replace(
      "ignore",
      "changed",
    ),
  );
  assert.equal(first.title, "Hello & Co");
  assert.equal(first.description, "A token site");
  assert.equal(first.excerpt.includes("SECRET"), false);
  assert.equal(first.contentHash, withOtherScript.contentHash);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
});

test("records a baseline without an event, then a text change", async () => {
  const html = page("Alpha", "About", "Hello");
  const first = await checkWebsite(
    { ca: CA, url: PAGE },
    monitor(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })),
  );
  assert.equal(first.changed, false);
  assert.equal(first.event, null);
  assert.equal(first.title, "Alpha");

  const second = await checkWebsite(
    {
      ca: CA,
      url: PAGE,
      previous: first,
    },
    monitor(async () =>
      new Response(page("Alpha", "About", "Hello there"), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ),
  );
  assert.equal(second.changed, true);
  assert.equal(second.diffSummary, 'Page text changed to "Hello there".');
  assert.equal(second.event?.kind, "website");
  assert.equal(second.event?.contentHash, second.contentHash);
  assert.equal(second.event?.url, PAGE);
});

test("describes title and description changes separately from body text", async () => {
  const original = extractWebsiteSignals(page("Alpha", "About", "Hello"));
  const titled = await checkWebsite(
    { ca: CA, url: PAGE, previous: original },
    monitor(async () =>
      new Response(page("Beta", "About", "Hello"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );
  assert.equal(titled.diffSummary, 'Title changed to "Beta".');

  const described = await checkWebsite(
    { ca: CA, url: PAGE, previous: original },
    monitor(async () =>
      new Response(page("Alpha", "Updated", "Hello"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );
  assert.equal(described.diffSummary, 'Description changed to "Updated".');

  const both = await checkWebsite(
    { ca: CA, url: PAGE, previous: original },
    monitor(async () =>
      new Response(page("Beta", "Updated", "Hello there"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );
  assert.equal(
    both.diffSummary,
    'Title, description, and page text changed to "Beta" — "Updated" — "Hello there".',
  );
});

test("blocks private hosts and follows only public redirects", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("nope", { status: 200 });
  };
  await assert.rejects(
    () => checkWebsite({ ca: CA, url: "http://127.0.0.1/latest" }, monitor(fetchImpl)),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "blocked_url");
      return true;
    },
  );
  await assert.rejects(
    () =>
      checkWebsite(
        { ca: CA, url: "https://example.com/secret" },
        {
          ...monitor(fetchImpl),
          resolveHost: async () => ["10.1.2.3"],
        },
      ),
  );
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]/"));
  assert.equal(calls, 0);

  const redirected = await checkWebsite(
    { ca: CA, url: "https://example.com/start" },
    monitor(async (input) => {
      calls += 1;
      if (String(input).endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/final" },
        });
      }
      return new Response(page("Final", "Done", "Arrived"), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
  );
  assert.equal(redirected.url, "https://example.com/final");
  assert.equal(redirected.title, "Final");

  await assert.rejects(
    () =>
      checkWebsite(
        { ca: CA, url: "https://example.com/start" },
        monitor(async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest" },
          }),
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "blocked_url");
      return true;
    },
  );
});

test("retries an unavailable site and rejects a non-text document", async () => {
  let calls = 0;
  const checked = await checkWebsite(
    { ca: CA, url: PAGE },
    monitor(async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 503 });
      return new Response(page("Alpha", "About", "Hello"), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
  );
  assert.equal(calls, 2);
  assert.equal(checked.title, "Alpha");

  await assert.rejects(
    () =>
      checkWebsite(
        { ca: CA, url: PAGE },
        monitor(async () =>
          new Response("png", {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});
