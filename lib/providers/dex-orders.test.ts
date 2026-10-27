import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "./errors";
import { ordersFromBody } from "./dex-orders";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SINCE = Date.parse("2026-10-26T00:00:00.000Z");
const UNTIL = Date.parse("2026-10-26T12:00:00.000Z");
const PAID = Date.parse("2026-10-26T04:00:00.000Z");

test("live paid orders become listing events and cancelled ones do not", () => {
  const events = ordersFromBody(
    {
      orders: [
        {
          chainId: "solana",
          tokenAddress: CA,
          type: "tokenProfile",
          status: "approved",
          paymentTimestamp: PAID,
        },
        {
          chainId: "solana",
          tokenAddress: CA,
          type: "communityTakeover",
          status: "cancelled",
          paymentTimestamp: PAID,
        },
        {
          type: "tokenAd",
          status: "processing",
          paymentTimestamp: Math.floor(PAID / 1000),
        },
      ],
      boosts: [],
    },
    CA,
    SINCE,
    UNTIL,
  );

  assert.deepEqual(
    events.map((event) => (event.kind === "listing" ? event.placement : "")),
    ["profile", "ad"],
  );
  assert.equal(events[0]?.kind === "listing" ? events[0].url : "", `https://dexscreener.com/solana/${CA}`);
  assert.equal(events[0]?.occurredAt, new Date(PAID).toISOString());
  assert.equal(events[0]?.evidence[0]?.source, "dexscreener");
});

test("a paid boost is a listing with its payment time and source link", () => {
  const events = ordersFromBody(
    {
      orders: [],
      boosts: [
        {
          chainId: "solana",
          tokenAddress: CA,
          id: "boost-1",
          amount: 10,
          paymentTimestamp: PAID,
        },
      ],
    },
    CA,
    SINCE,
    UNTIL,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "listing" ? events[0].placement : "", "boost");
  assert.equal(events[0]?.kind === "listing" ? events[0].title : "", "Paid DexScreener boost of 10");
  assert.equal(events[0]?.occurredAt, new Date(PAID).toISOString());
  assert.equal(events[0]?.evidence[0]?.url, `https://dexscreener.com/solana/${CA}`);
});

test("orders outside the window and unknown payloads are rejected", () => {
  assert.deepEqual(
    ordersFromBody(
      [{ type: "trendingBarAd", status: "approved", paymentTimestamp: SINCE }],
      CA,
      SINCE,
      UNTIL,
    ),
    [],
  );
  assert.throws(
    () => ordersFromBody({ error: true }, CA, SINCE, UNTIL),
    (error: unknown) => error instanceof ProviderError,
  );
});
