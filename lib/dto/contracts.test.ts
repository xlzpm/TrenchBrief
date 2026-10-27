import assert from "node:assert/strict";
import test from "node:test";

import { readServerSecret, serverEnvSchema, serverSecretNames } from "../env";
import { BRIEF_PERIODS, MARKET_EVIDENCE_SOURCES } from "./common";
import { parseBrief, parseBriefRequest } from "./brief";
import { parseTimelineEvent } from "./event";
import { parseTokenSnapshot, volumeUsdByPeriodSchema } from "./token-snapshot";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_CA = "So11111111111111111111111111111111111111112";
const CAPTURED_AT = "2026-10-26T05:00:00.000Z";
const CONTENT_HASH = "a".repeat(64);

const priceEvidence = {
  id: "ev-price",
  source: "birdeye" as const,
  url: `https://birdeye.so/token/${CA}`,
  label: "Birdeye",
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    ca: CA,
    name: "USD Coin",
    symbol: "USDC",
    imageUrl: "https://example.com/usdc.png",
    priceUsd: 1,
    liquidityUsd: 1_000_000,
    volumeUsd: {
      "1h": 10,
      "6h": 20,
      "12h": 30,
      "24h": 40,
    },
    website: "https://www.circle.com",
    socials: {
      xHandle: "circle",
      xUrl: "https://x.com/circle",
    },
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

function priceEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-price",
    ca: CA,
    kind: "price" as const,
    occurredAt: CAPTURED_AT,
    title: "Price moved",
    evidence: [priceEvidence],
    previousUsd: 0.99,
    currentUsd: 1,
    changePct: 1.01,
    ...overrides,
  };
}

function summaryPoint(id: string, text: string, eventId: string | null) {
  return {
    id,
    text: `${text} Observed at ${CAPTURED_AT}. Source: ${priceEvidence.label}.`,
    occurredAt: CAPTURED_AT,
    eventId,
    evidence: [priceEvidence],
  };
}

function brief(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    shareId: "11111111-1111-4111-8111-111111111111",
    ca: CA,
    period: "24h" as const,
    generatedAt: CAPTURED_AT,
    snapshot: snapshot(),
    summary: [
      summaryPoint("s1", "Price held near one dollar.", "evt-price"),
      summaryPoint("s2", "Liquidity stayed above one million dollars.", null),
      summaryPoint("s3", "No separate volume event was recorded.", null),
    ],
    events: [priceEvent()],
    ...overrides,
  };
}

test("volume windows use the same periods as a brief", () => {
  assert.deepEqual(
    Object.keys(volumeUsdByPeriodSchema.shape).sort(),
    [...BRIEF_PERIODS].sort(),
  );
});

test("token snapshot accepts a market snapshot and rejects a bad address", () => {
  assert.equal(parseTokenSnapshot(snapshot()).symbol, "USDC");
  assert.equal(parseTokenSnapshot(snapshot()).marketCapUsd, null);
  assert.equal(
    parseTokenSnapshot(snapshot({ marketCapUsd: 2500 })).marketCapUsd,
    2500,
  );
  assert.throws(() => parseTokenSnapshot(snapshot({ ca: "not-an-address" })));
  assert.throws(() =>
    parseTokenSnapshot(snapshot({ capturedAt: "2026-10-26 05:00:00" })),
  );
});

test("timeline events keep kind-specific fields", () => {
  assert.equal(parseTimelineEvent(priceEvent()).kind, "price");
  assert.equal(
    parseTimelineEvent({
      id: "evt-site",
      ca: CA,
      kind: "website",
      occurredAt: "2026-10-26T05:00:00+00:00",
      title: "Website content changed",
      evidence: [
        {
          id: "ev-site",
          source: "website",
          url: "https://www.circle.com",
          label: "Website",
        },
      ],
      url: "https://www.circle.com",
      contentHash: CONTENT_HASH,
      diffSummary: "Title changed.",
    }).kind,
    "website",
  );
  assert.throws(() =>
    parseTimelineEvent({
      id: "evt-site",
      ca: CA,
      kind: "website",
      occurredAt: CAPTURED_AT,
      title: "Website content changed",
      evidence: [priceEvidence],
      url: "https://www.circle.com",
      contentHash: "ABC",
      diffSummary: "Title changed.",
    }),
  );
});

test("brief request and published brief enforce the product contract", () => {
  assert.deepEqual(parseBriefRequest({ ca: CA, period: "6h" }), {
    ca: CA,
    period: "6h",
  });

  const parsed = parseBrief(brief());
  assert.equal(parsed.summary.length, 3);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.summary[0]?.occurredAt, CAPTURED_AT);
  assert.equal(parsed.summary[0]?.eventId, "evt-price");
  assert.equal(parsed.summary[1]?.eventId, null);
  assert.deepEqual(MARKET_EVIDENCE_SOURCES, ["birdeye", "dexscreener", "jupiter"]);

  assert.equal(
    parseBrief(
      brief({
        summary: [
          summaryPoint("s1", "Only one point.", "evt-price"),
          summaryPoint("s2", "Only two points.", null),
        ],
      }),
    ).summary.length,
    2,
  );
  assert.equal(parseBrief(brief({ summary: [] })).summary.length, 0);
  assert.throws(() =>
    parseBrief(
      brief({
        summary: [
          summaryPoint("s1", "One.", "evt-price"),
          summaryPoint("s2", "Two.", null),
          summaryPoint("s3", "Three.", null),
          summaryPoint("s4", "Four.", null),
          summaryPoint("s5", "Five.", null),
          summaryPoint("s6", "Six.", null),
        ],
      }),
    ),
  );
  assert.throws(() =>
    parseBrief(brief({ events: [priceEvent({ ca: OTHER_CA })] })),
  );
});

test("each summary point keeps its time and its sources", () => {
  const unboundTime = summaryPoint("s1", "Price held.", "evt-price");
  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            { ...unboundTime, text: "Price held. Source: Birdeye." },
            summaryPoint("s2", "Liquidity stayed.", null),
            summaryPoint("s3", "Volume stayed.", null),
          ],
        }),
      ),
    /observation time/,
  );

  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            {
              ...summaryPoint("s1", "Price held.", "evt-price"),
              occurredAt: "2026-10-26T04:00:00.000Z",
              text: "Price held. Observed at 2026-10-26T04:00:00.000Z. Source: Birdeye.",
            },
            summaryPoint("s2", "Liquidity stayed.", null),
            summaryPoint("s3", "Volume stayed.", null),
          ],
        }),
      ),
    /match the cited event/,
  );

  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            {
              ...summaryPoint("s1", "Price held.", "evt-price"),
              text: "Price held. Observed at 2026-10-26T05:00:00.000Z. Source: Other book.",
              evidence: [
                {
                  id: "ev-other",
                  source: "birdeye" as const,
                  url: "https://birdeye.so/token/other",
                  label: "Other book",
                },
              ],
            },
            summaryPoint("s2", "Liquidity stayed.", null),
            summaryPoint("s3", "Volume stayed.", null),
          ],
        }),
      ),
    /cited event/,
  );

  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            summaryPoint("s1", "Price held.", "missing-event"),
            summaryPoint("s2", "Liquidity stayed.", null),
            summaryPoint("s3", "Volume stayed.", null),
          ],
        }),
      ),
    /cite an event/,
  );

  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            summaryPoint("s1", "Price held.", "evt-price"),
            summaryPoint("s2", "Price again.", "evt-price"),
            summaryPoint("s3", "Liquidity stayed.", null),
          ],
        }),
      ),
    /cited once/,
  );

  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            summaryPoint("s1", "Price held.", "evt-price"),
            {
              ...summaryPoint("s2", "Liquidity stayed.", null),
              occurredAt: "2026-10-26T04:00:00.000Z",
              text: "Liquidity stayed. Observed at 2026-10-26T04:00:00.000Z. Source: Birdeye.",
            },
            summaryPoint("s3", "Volume stayed.", null),
          ],
        }),
      ),
    /snapshot time/,
  );

  assert.throws(
    () =>
      parseBrief(
        brief({
          summary: [
            summaryPoint("s1", "Price held.", "evt-price"),
            summaryPoint("s2", "Liquidity stayed.", null),
            {
              ...summaryPoint("s3", "A post.", null),
              text: `A post. Observed at ${CAPTURED_AT}. Source: Post.`,
              evidence: [
                {
                  id: "ev-x",
                  source: "x" as const,
                  url: "https://x.com/circle/status/1",
                  label: "Post",
                },
              ],
            },
          ],
        }),
      ),
    /market data sources/,
  );
});

test("server env schema checks urls and allows missing secrets", () => {
  assert.deepEqual(
    [...serverSecretNames].sort(),
    Object.keys(serverEnvSchema.shape).sort(),
  );
  const empty = serverEnvSchema.parse({});
  assert.equal(empty.DATABASE_URL, undefined);
  assert.equal(empty.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(empty.UPSTASH_REDIS_REST_TOKEN, undefined);
  assert.equal(empty.BIRDEYE_API_KEY, undefined);
  assert.equal(empty.X_BEARER_TOKEN, undefined);
  assert.equal(
    serverEnvSchema.parse({
      DATABASE_URL: "postgres://user:pass@localhost:5432/trench",
      BIRDEYE_API_KEY: "key",
    }).BIRDEYE_API_KEY,
    "key",
  );
  assert.throws(() => serverEnvSchema.parse({ DATABASE_URL: "not a url" }));
  assert.throws(() => serverEnvSchema.parse({ X_BEARER_TOKEN: "" }));
});

test("readServerSecret fails closed when a provider key is unset", () => {
  if (process.env.BIRDEYE_API_KEY) {
    assert.equal(typeof readServerSecret("BIRDEYE_API_KEY"), "string");
    return;
  }
  assert.throws(
    () => readServerSecret("BIRDEYE_API_KEY"),
    /BIRDEYE_API_KEY/,
  );
});
