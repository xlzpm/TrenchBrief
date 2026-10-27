import assert from "node:assert/strict";
import test from "node:test";

import { asHttpUrl, asUsd, asXSocial, buildTokenSnapshot, firstUsd } from "./normalize";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("normalizes usd amounts and http urls", () => {
  assert.equal(asUsd("1.25"), 1.25);
  assert.equal(asUsd(0), 0);
  assert.equal(asUsd(-1), null);
  assert.equal(asUsd("nope"), null);
  assert.equal(asHttpUrl("solana.com/docs"), "https://solana.com/docs");
  assert.equal(asHttpUrl("javascript:alert(1)"), null);
  assert.equal(asHttpUrl("https://user:pass@example.com"), null);
});

test("picks the first usable dollar amount", () => {
  assert.equal(firstUsd(null, "2500"), 2500);
  assert.equal(firstUsd(0, 10), 0);
  assert.equal(firstUsd("nope", -1, undefined), null);
});

test("normalizes X profiles and rejects reserved paths", () => {
  assert.deepEqual(asXSocial("https://twitter.com/solana"), {
    xHandle: "solana",
    xUrl: "https://x.com/solana",
  });
  assert.deepEqual(asXSocial("https://x.com/Solana/"), {
    xHandle: "Solana",
    xUrl: "https://x.com/Solana",
  });
  assert.equal(asXSocial("@circle").xHandle, "circle");
  assert.equal(asXSocial("circle").xHandle, "circle");
  assert.equal(
    asXSocial("https://twitter.com/intent/user?screen_name=circle").xHandle,
    "circle",
  );
  assert.equal(asXSocial("https://x.com/solana/status/1").xHandle, "solana");
  assert.equal(
    asXSocial("https://x.com/neildevvv/status/2114676153503907923").xHandle,
    "neildevvv",
  );
  assert.equal(asXSocial("https://x.com/i/status/1").xHandle, null);
  assert.equal(asXSocial("https://x.com/i/communities/1959652621158875454").xHandle, null);
  assert.equal(asXSocial("https://twitter.com/home").xHandle, null);
  assert.equal(asXSocial("https://example.com/solana").xHandle, null);
  assert.equal(asXSocial({ url: "https://x.com/circle" }).xHandle, "circle");
});

test("builds a snapshot with empty market fields left null", () => {
  const snapshot = buildTokenSnapshot({
    ca: CA,
    name: "  USD   Coin ",
    website: "circle.com",
    x: "https://twitter.com/circle",
    capturedAt: "2026-10-26T05:00:00.000Z",
  });
  assert.equal(snapshot.name, "USD Coin");
  assert.equal(snapshot.symbol, "UNKNOWN");
  assert.equal(snapshot.priceUsd, null);
  assert.equal(snapshot.marketCapUsd, null);
  assert.equal(snapshot.volumeUsd["12h"], null);
  assert.equal(snapshot.website, "https://circle.com/");
  assert.equal(snapshot.socials.xHandle, "circle");
  assert.throws(() =>
    buildTokenSnapshot({
      ca: "not-an-address",
      capturedAt: "2026-10-26T05:00:00.000Z",
    }),
  );
});
