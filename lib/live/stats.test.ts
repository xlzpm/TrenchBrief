import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLiveQuote,
  applyLiveStats,
  liveFrameFromBirdeye,
  parseLiveQuote,
  parseLiveServerFrame,
  subscribeTokenStats,
  type LiveReading,
} from "./stats";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = new Date("2026-10-26T12:00:00.000Z");

function reading(overrides: Partial<LiveReading> = {}): LiveReading {
  return {
    ca: CA,
    priceUsd: 1,
    marketCapUsd: 1_000,
    liquidityUsd: 50,
    volumeUsd: { "1h": 10, "6h": 20, "12h": 30, "24h": 40 },
    ...overrides,
  };
}

test("token stats become a price, market cap, liquidity, and volume frame", () => {
  const frame = liveFrameFromBirdeye(
    {
      type: "TOKEN_STATS_DATA",
      data: {
        address: CA,
        price: 0.000106,
        marketcap: 103_442,
        fdv: 200_000,
        liquidity: 30_004,
        volume_1h_usd: 13_250,
        volume_6h_usd: 203_559,
        volume_24h_usd: 2_130_464,
        last_trade_unix_time: Math.floor(NOW.getTime() / 1000),
      },
    },
    NOW,
  );
  assert.equal(frame?.priceUsd, 0.000106);
  assert.equal(frame?.marketCapUsd, 103_442);
  assert.equal(frame?.liquidityUsd, 30_004);
  assert.deepEqual(frame?.volumeUsd, { "1h": 13_250, "6h": 203_559, "24h": 2_130_464 });
  assert.equal(frame?.capturedAt, NOW.toISOString());
});

test("market cap falls back to fdv and a nested liquidity pool", () => {
  const frame = liveFrameFromBirdeye(
    {
      type: "TOKEN_STATS_DATA",
      data: {
        address: CA,
        price: 0,
        marketcap: null,
        fdv: 80,
        liquidity: { usd: 15 },
      },
    },
    NOW,
  );
  assert.equal(frame?.priceUsd, 0);
  assert.equal(frame?.marketCapUsd, 80);
  assert.equal(frame?.liquidityUsd, 15);
  assert.equal(frame?.capturedAt, NOW.toISOString());
});

test("a stats frame does not invent a 12h volume", () => {
  const next = applyLiveStats(reading(), {
    type: "stats",
    ca: CA,
    capturedAt: NOW.toISOString(),
    priceUsd: 2,
    volumeUsd: { "24h": 90 },
  });
  assert.equal(next.priceUsd, 2);
  assert.equal(next.marketCapUsd, 1_000);
  assert.equal(next.volumeUsd["12h"], 30);
  assert.equal(next.volumeUsd["24h"], 90);
  assert.equal(next.volumeUsd["1h"], 10);
});

test("subscribe payload asks for the metrics the cards show", () => {
  const message = subscribeTokenStats([CA]);
  assert.equal(message.type, "SUBSCRIBE_TOKEN_STATS");
  assert.equal(message.data.address, CA);
  assert.equal(message.data.select.price, true);
  assert.equal(message.data.select.marketcap, true);
  assert.equal(message.data.select.liquidity, true);
  assert.deepEqual(message.data.select.trade_data.intervals, ["1h", "6h", "24h"]);
  assert.equal(JSON.stringify(message).includes("holder"), false);
});

test("a market quote replaces price, liquidity, and every volume window", () => {
  const quote = parseLiveQuote({
    ok: true,
    ca: CA,
    capturedAt: NOW.toISOString(),
    priceUsd: 3,
    marketCapUsd: 9,
    liquidityUsd: 70,
    volumeUsd: { "1h": 1, "6h": 2, "12h": 3, "24h": 4 },
  });
  assert.ok(quote);
  const next = applyLiveQuote(reading(), quote);
  assert.equal(next.priceUsd, 3);
  assert.equal(next.liquidityUsd, 70);
  assert.deepEqual(next.volumeUsd, { "1h": 1, "6h": 2, "12h": 3, "24h": 4 });
  assert.equal(
    applyLiveQuote(reading(), { ...quote, ca: "So11111111111111111111111111111111111111112" }).priceUsd,
    1,
  );
  assert.equal(parseLiveQuote({ ok: true, ca: CA, capturedAt: NOW.toISOString(), volumeUsd: { "1h": -1 } }), null);
});

test("browser frames reject a bad address and keep a zero price", () => {
  assert.equal(parseLiveServerFrame({ type: "status", live: true })?.type, "status");
  assert.equal(parseLiveServerFrame({ type: "stats", ca: "nope", capturedAt: NOW.toISOString() }), null);
  const frame = parseLiveServerFrame({
    type: "stats",
    ca: CA,
    capturedAt: NOW.toISOString(),
    priceUsd: 0,
    volumeUsd: { "1h": 4 },
  });
  assert.equal(frame?.type, "stats");
  if (frame?.type === "stats") assert.equal(frame.priceUsd, 0);
});
