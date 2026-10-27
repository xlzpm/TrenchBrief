import assert from "node:assert/strict";
import test from "node:test";

import { createMarketStream, type LiveClient } from "./stream";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER = "So11111111111111111111111111111111111111112";

type Handlers = {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: () => void;
};

function harness() {
  const sent: string[] = [];
  const opens: Handlers[] = [];
  let closed = 0;
  const stream = createMarketStream({
    connect: (handlers) => {
      opens.push(handlers);
      return {
        send: (payload) => sent.push(payload),
        close: () => {
          closed += 1;
          handlers.onClose();
        },
      };
    },
    now: () => new Date("2026-10-26T12:00:00.000Z"),
    schedule: () => undefined,
  });
  return { stream, sent, opens, closes: () => closed };
}

function client(): LiveClient & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    send: (payload) => messages.push(JSON.parse(payload)),
  };
}

test("one upstream subscription serves every browser on that token", () => {
  const { stream, sent, opens } = harness();
  const first = client();
  const second = client();
  const stopFirst = stream.subscribe(CA, first);
  assert.equal(opens.length, 1);
  assert.deepEqual(first.messages[0], { type: "status", live: false });
  opens[0]?.onOpen();
  assert.equal(JSON.parse(sent[0] ?? "{}").type, "SUBSCRIBE_TOKEN_STATS");
  assert.equal(JSON.parse(sent[0] ?? "{}").data.address, CA);
  assert.deepEqual(first.messages.at(-1), { type: "status", live: true });

  stream.subscribe(CA, second);
  assert.equal(opens.length, 1);
  assert.deepEqual(second.messages[0], { type: "status", live: true });

  opens[0]?.onMessage(
    JSON.stringify({
      type: "TOKEN_STATS_DATA",
      data: {
        address: CA,
        price: 1.5,
        marketcap: 20,
        liquidity: 30,
        volume_1h_usd: 4,
        volume_6h_usd: 5,
        volume_24h_usd: 6,
      },
    }),
  );
  assert.equal(first.messages.at(-1) && (first.messages.at(-1) as { priceUsd?: number }).priceUsd, 1.5);
  assert.equal(second.messages.at(-1) && (second.messages.at(-1) as { marketCapUsd?: number }).marketCapUsd, 20);

  opens[0]?.onMessage(JSON.stringify({ type: "TOKEN_STATS_DATA", data: { address: OTHER, price: 9 } }));
  assert.equal(first.messages.at(-1) && (first.messages.at(-1) as { priceUsd?: number }).priceUsd, 1.5);

  stopFirst();
  const afterLeave = JSON.parse(sent.at(-1) ?? "{}") as { type?: string; data?: { address?: string } };
  assert.equal(afterLeave.type, "SUBSCRIBE_TOKEN_STATS");
  assert.equal(afterLeave.data?.address, CA);
});

test("the upstream closes when the last browser leaves", () => {
  const { stream, opens, closes } = harness();
  const stop = stream.subscribe(CA, client());
  opens[0]?.onOpen();
  stop();
  assert.equal(closes(), 1);
  assert.equal(opens.length, 1);
});
