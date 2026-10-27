import assert from "node:assert/strict";
import test from "node:test";

import { extractStatusUrls, linkParts, statusUrlsForPoint, xProfileUrl } from "./post-links";

const SENTENCE =
  '@Kalshi posted at 2026-10-26T12:44:53.000Z (https://x.com/Kalshi/status/2114699788637680038): "BREAKING: Samsung may offer bonuses".';

test("lifts a status URL out of a summary sentence", () => {
  const { prose, postUrls } = extractStatusUrls(SENTENCE);
  assert.equal(
    prose,
    '@Kalshi posted at 2026-10-26T12:44:53.000Z: "BREAKING: Samsung may offer bonuses".',
  );
  assert.deepEqual(postUrls, ["https://x.com/Kalshi/status/2114699788637680038"]);
});

test("canonicalizes twitter.com status links and drops duplicates", () => {
  const { postUrls } = statusUrlsForPoint(
    "See https://twitter.com/Kalshi/status/2114699788637680038 for the note.",
    {
      kind: "x_post",
      postUrl: "https://x.com/Kalshi/status/2114699788637680038",
    },
  );
  assert.deepEqual(postUrls, ["https://x.com/Kalshi/status/2114699788637680038"]);
});

test("leaves non-status text untouched", () => {
  const text = "Price moved at 2026-10-26T12:44:53.000Z.";
  assert.deepEqual(extractStatusUrls(text), { prose: text, postUrls: [] });
  assert.equal(xProfileUrl("Kalshi"), "https://x.com/Kalshi");
});

test("turns urls and handles inside a post into links", () => {
  assert.deepEqual(linkParts("anti ai? https://t.co/Dp1w2faaX4"), [
    { kind: "text", text: "anti ai? " },
    { kind: "url", href: "https://t.co/Dp1w2faaX4" },
  ]);
  assert.deepEqual(linkParts("See @DanielKuhn77510 and https://t.co/abc, then http://example.com/a(b)."), [
    { kind: "text", text: "See " },
    { kind: "mention", handle: "DanielKuhn77510" },
    { kind: "text", text: " and " },
    { kind: "url", href: "https://t.co/abc" },
    { kind: "text", text: ", then " },
    { kind: "url", href: "http://example.com/a(b)" },
    { kind: "text", text: "." },
  ]);
});

test("leaves emails and non-http schemes as text", () => {
  assert.deepEqual(linkParts("mail me@example.com or javascript:alert(1)"), [
    { kind: "text", text: "mail me@example.com or javascript:alert(1)" },
  ]);
});
