import assert from "node:assert/strict";
import test from "node:test";

import { MarketUnavailableError, ProviderError } from "./errors";
import { fetchBirdeyeSnapshot } from "./birdeye";
import { fetchDexScreenerSnapshot } from "./dexscreener";
import { fetchJupiterSnapshot } from "./jupiter";
import { mergeTokenSnapshots, readTokenSnapshot } from "./market";
import { buildTokenSnapshot } from "./normalize";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_CA = "So11111111111111111111111111111111111111112";
const NOW = "2026-10-26T05:00:00.000Z";
const API_KEY = "super-secret-key";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function client(fetchImpl: typeof fetch) {
  return {
    apiKey: API_KEY,
    birdeyeApiKey: API_KEY,
    fetchImpl,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    random: () => 0,
  };
}

function birdeyeBody(
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: true,
    data: {
      address: CA,
      name: "USD Coin",
      symbol: "USDC",
      logoURI: "https://example.com/usdc.png",
      price: 1,
      mc: 1_000_000,
      fdv: 2_000_000,
      liquidity: 1_000,
      v1hUSD: 10,
      v6hUSD: 60,
      v360mUSD: 20,
      v720mUSD: 30,
      v24hUSD: 40,
      extensions: {
        website: "https://www.circle.com/usdc",
        twitter: "https://twitter.com/circle",
      },
      ...data,
    },
  };
}

function dexPair(overrides: Record<string, unknown> = {}) {
  return {
    url: `https://dexscreener.com/solana/pair-${overrides.priceUsd ?? "1"}`,
    baseToken: { address: CA, name: "Dex Name", symbol: "USDC" },
    priceUsd: "1.5",
    liquidity: { usd: 100 },
    volume: { h1: 11, h6: 22, h24: 44 },
    info: {
      imageUrl: "https://example.com/dex.png",
      websites: [{ url: "https://dex.example/token" }],
      socials: [{ type: "twitter", url: "https://x.com/dexcircle" }],
    },
    ...overrides,
  };
}

test("Birdeye maps frames, prefers hour aliases, and redacts the api key", async () => {
  let frames = "";
  const read = await fetchBirdeyeSnapshot(
    CA,
    client(async (input, init) => {
      const url = new URL(String(input));
      frames = url.searchParams.get("frames") ?? "";
      assert.equal(new Headers(init?.headers).get("x-chain"), "solana");
      assert.equal(new Headers(init?.headers).get("x-api-key"), API_KEY);
      return json(birdeyeBody());
    }),
  );
  assert.equal(frames, "1h,360m,720m,24h");
  assert.equal(read.snapshot.priceUsd, 1);
  assert.equal(read.snapshot.marketCapUsd, 1_000_000);
  assert.equal(read.snapshot.volumeUsd["6h"], 60);
  assert.equal(read.snapshot.volumeUsd["12h"], 30);

  const minuteFrames = await fetchBirdeyeSnapshot(
    CA,
    client(async () =>
      json(
        birdeyeBody({
          v6hUSD: null,
          v12hUSD: null,
          v360mUSD: 21,
          v720mUSD: 31,
          mc: null,
          fdv: 77,
        }),
      ),
    ),
  );
  assert.equal(minuteFrames.snapshot.volumeUsd["6h"], 21);
  assert.equal(minuteFrames.snapshot.volumeUsd["12h"], 31);
  assert.equal(minuteFrames.snapshot.marketCapUsd, 77);
  assert.equal(read.snapshot.socials.xHandle, "circle");
  assert.equal(read.evidence.source, "birdeye");
  assert.equal(read.snapshot.capturedAt, NOW);

  await assert.rejects(
    () =>
      fetchBirdeyeSnapshot(
        CA,
        client(async () =>
          json({
            success: false,
            message: `rejected ${API_KEY}`,
          }),
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(API_KEY), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test("DexScreener uses the deepest base pool and Jupiter sums trade volume", async () => {
  const dex = await fetchDexScreenerSnapshot(
    CA,
    client(async () =>
      json([
        dexPair({
          priceUsd: "9",
          liquidity: { usd: 10 },
          baseToken: { address: CA, name: "Thin", symbol: "THIN" },
        }),
        dexPair({
          priceUsd: "2",
          marketCap: 2000,
          fdv: 9000,
          liquidity: { usd: 500 },
          volume: { h1: 5, h6: 6, h24: 7 },
          baseToken: { address: CA, name: "Deep", symbol: "DEEP" },
        }),
        dexPair({
          baseToken: { address: OTHER_CA, name: "Other", symbol: "OTH" },
          liquidity: { usd: 9_000 },
          priceUsd: "99",
        }),
      ]),
    ),
  );
  assert.equal(dex.snapshot.priceUsd, 2);
  assert.equal(dex.snapshot.marketCapUsd, 2000);
  assert.equal(dex.snapshot.symbol, "DEEP");
  assert.equal(dex.snapshot.volumeUsd["24h"], 7);
  assert.equal(dex.snapshot.volumeUsd["12h"], null);
  assert.equal(dex.snapshot.socials.xHandle, "dexcircle");
  assert.equal(dex.evidence.url, "https://dexscreener.com/solana/pair-2");

  const jupiter = await fetchJupiterSnapshot(
    CA,
    client(async (input) => {
      assert.match(String(input), /query=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
      return json([
        { id: OTHER_CA, name: "Other", symbol: "OTH", usdPrice: 50 },
        {
          id: CA,
          name: "USD Coin",
          symbol: "USDC",
          icon: "https://example.com/jup.png",
          website: "circle.com",
          twitter: "@circle",
          usdPrice: 1,
          mcap: 42,
          fdv: 99,
          liquidity: 900,
          stats1h: { buyVolume: 3, sellVolume: 4 },
          stats6h: { buyVolume: 1, sellVolume: 1 },
          stats24h: { sellVolume: 8 },
        },
      ]);
    }),
  );
  assert.equal(jupiter.snapshot.marketCapUsd, 42);
  assert.equal(jupiter.snapshot.volumeUsd["1h"], 7);
  assert.equal(jupiter.snapshot.volumeUsd["6h"], 2);
  assert.equal(jupiter.snapshot.volumeUsd["12h"], null);
  assert.equal(jupiter.snapshot.volumeUsd["24h"], 8);
  assert.equal(jupiter.snapshot.website, "https://circle.com/");
  assert.equal(jupiter.evidence.source, "jupiter");
});

test("keeps a complete Birdeye snapshot and fills gaps from the next provider", async () => {
  const calls: string[] = [];
  const complete = await readTokenSnapshot(
    CA,
    client(async (input) => {
      calls.push(String(input));
      return json(birdeyeBody());
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(complete.evidence.length, 1);
  assert.equal(complete.snapshot.volumeUsd["12h"], 30);

  const urls: string[] = [];
  const filled = await readTokenSnapshot(
    CA,
    client(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("birdeye")) {
        return json(
          birdeyeBody({
            price: null,
            mc: null,
            fdv: null,
            logoURI: null,
            extensions: { website: null, twitter: null },
          }),
        );
      }
      return json([
        dexPair({ priceUsd: "4", marketCap: 4400, liquidity: { usd: 800 } }),
      ]);
    }),
  );
  assert.equal(urls.some((url) => url.includes("jup.ag")), false);
  assert.equal(filled.snapshot.name, "USD Coin");
  assert.equal(filled.snapshot.priceUsd, 4);
  assert.equal(filled.snapshot.marketCapUsd, 4400);
  assert.equal(filled.snapshot.website, "https://dex.example/token");
  assert.equal(filled.snapshot.capturedAt, NOW);
  assert.deepEqual(
    filled.evidence.map((link) => link.source),
    ["birdeye", "dexscreener"],
  );
});

test("skips Birdeye without a key and uses Jupiter when DexScreener misses the token", async () => {
  const hosts: string[] = [];
  const read = await readTokenSnapshot(CA, {
    birdeyeApiKey: null,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    fetchImpl: async (input) => {
      const url = String(input);
      hosts.push(new URL(url).host);
      if (url.includes("dexscreener")) return json([]);
      return json([
        {
          id: CA,
          name: "USD Coin",
          symbol: "USDC",
          usdPrice: 1,
          liquidity: 10,
          website: "https://www.circle.com/",
          icon: "https://example.com/usdc.png",
          stats1h: { buyVolume: 1, sellVolume: 1 },
          stats6h: { buyVolume: 2, sellVolume: 2 },
          stats24h: { buyVolume: 3, sellVolume: 3 },
        },
      ]);
    },
  });
  assert.deepEqual(hosts, ["api.dexscreener.com", "api.jup.ag"]);
  assert.equal(read.snapshot.symbol, "USDC");
  assert.equal(read.evidence[0]?.source, "jupiter");
});

test("fails when every market provider fails", async () => {
  await assert.rejects(
    () =>
      readTokenSnapshot(
        CA,
        client(async () => new Response("no", { status: 404 })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof MarketUnavailableError);
      assert.equal(error.causes.length, 3);
      assert.equal(error.message.includes(API_KEY), false);
      return true;
    },
  );
});

test("merge keeps a zero price and replaces placeholder identity", () => {
  const primary = buildTokenSnapshot({
    ca: CA,
    priceUsd: 0,
    marketCapUsd: 0,
    liquidityUsd: null,
    capturedAt: NOW,
  });
  const fallback = buildTokenSnapshot({
    ca: CA,
    name: "USD Coin",
    symbol: "USDC",
    priceUsd: 5,
    marketCapUsd: 80,
    liquidityUsd: 15,
    website: "https://www.circle.com/",
    capturedAt: "2026-10-26T06:00:00.000Z",
  });
  const merged = mergeTokenSnapshots(primary, fallback);
  assert.equal(merged.priceUsd, 0);
  assert.equal(merged.marketCapUsd, 0);
  assert.equal(merged.liquidityUsd, 15);
  assert.equal(merged.name, "USD Coin");
  assert.equal(merged.symbol, "USDC");
  assert.equal(merged.capturedAt, NOW);
  assert.throws(() =>
    mergeTokenSnapshots(
      primary,
      buildTokenSnapshot({ ca: OTHER_CA, capturedAt: NOW }),
    ),
  );
});
