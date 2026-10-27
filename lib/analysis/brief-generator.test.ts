import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BRIEF_SCHEMA_VERSION, parseBrief } from "../dto/brief";
import type { EvidenceLink } from "../dto/common";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";
import { parseTokenSnapshot, type TokenSnapshot } from "../dto/token-snapshot";
import { PERIOD_MS, analyzeChanges, type MarketPoint } from "./delta-engine";
import { generateBriefSummary } from "./brief-generator";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_CA = "So11111111111111111111111111111111111111112";
const T = Date.parse("2026-10-26T12:00:00.000Z");
const END = "2026-10-26T12:00:00.000Z";
const START_6H = "2026-10-26T06:00:00.000Z";
const START_1H = "2026-10-26T11:00:00.000Z";

const birdeye: EvidenceLink = {
  id: `birdeye:${CA}`,
  source: "birdeye",
  url: `https://birdeye.so/token/${CA}?chain=solana`,
  label: "Birdeye",
};

const dexscreener: EvidenceLink = {
  id: `dexscreener:${CA}`,
  source: "dexscreener",
  url: `https://dexscreener.com/solana/${CA}`,
  label: "DexScreener",
};

function at(ms: number): string {
  return new Date(ms).toISOString();
}

function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function snapshot(
  overrides: Omit<Partial<TokenSnapshot>, "volumeUsd" | "socials"> & {
    volumeUsd?: Partial<TokenSnapshot["volumeUsd"]>;
    socials?: Partial<TokenSnapshot["socials"]>;
  } = {},
): TokenSnapshot {
  return parseTokenSnapshot({
    ca: CA,
    name: "USD Coin",
    symbol: "USDC",
    imageUrl: null,
    priceUsd: 1,
    liquidityUsd: 10_000,
    website: null,
    capturedAt: at(T),
    ...overrides,
    volumeUsd: {
      "1h": null,
      "6h": null,
      "12h": null,
      "24h": null,
      ...overrides.volumeUsd,
    },
    socials: { xHandle: null, xUrl: null, ...overrides.socials },
  });
}

function point(
  ms: number,
  values: {
    priceUsd?: number | null;
    liquidityUsd?: number | null;
    volumeUsd?: Partial<MarketPoint["volumeUsd"]>;
  } = {},
): MarketPoint {
  return {
    capturedAt: at(ms),
    priceUsd: values.priceUsd ?? null,
    liquidityUsd: values.liquidityUsd ?? null,
    volumeUsd: {
      "1h": null,
      "6h": null,
      "12h": null,
      "24h": null,
      ...values.volumeUsd,
    },
  };
}

function xEvent(postId: string, occurredAt: string, text = `Update ${postId}`): TimelineEvent {
  return parseTimelineEvent({
    id: `x:${postId}`,
    ca: CA,
    kind: "x_post",
    occurredAt,
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
  });
}

function websiteEvent(id: string, occurredAt: string): TimelineEvent {
  return parseTimelineEvent({
    id,
    ca: CA,
    kind: "website",
    occurredAt,
    title: "Website content changed",
    evidence: [
      {
        id: `website:${id}`,
        source: "website",
        url: "https://example.com",
        label: "Website",
      },
    ],
    url: "https://example.com",
    contentHash: hash(id),
    diffSummary: "Title changed.",
  });
}

function observed(start: string): string {
  return `Observed at ${END}, between ${start} and ${END}.`;
}

test("a quiet window skips a price line that has no market-cap comparison", () => {
  const current = snapshot({
    priceUsd: 1,
    liquidityUsd: 10_000,
    volumeUsd: { "6h": 100 },
  });
  const report = analyzeChanges({ ca: CA, period: "6h", current });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye],
  });

  assert.deepEqual(points, []);
  assert.deepEqual(
    generateBriefSummary({ report, snapshot: current, evidence: [birdeye] }),
    points,
  );
});

test("an under-threshold move stays a level reading with both times", () => {
  const current = snapshot({ priceUsd: 105, marketCapUsd: 1_050_000, liquidityUsd: 10_000 });
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current,
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100, liquidityUsd: 10_000 })],
    evidence: [birdeye],
  });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye],
  });

  assert.equal(report.timeline.length, 0);
  assert.deepEqual(
    points.map((item) => item.eventId),
    [null, null],
  );
  assert.equal(
    points[0]?.text,
    `Market cap was $1,050,000 at ${END}, compared with $1,000,000 at ${START_6H} (up 5%).`,
  );
  assert.equal(
    points[1]?.text,
    `Liquidity was $10,000 at ${END}, unchanged from $10,000 at ${START_6H}.`,
  );
  assert.equal(points.length, 2);
});

test("missing market fields stay explicit instead of becoming a change", () => {
  const current = snapshot({ priceUsd: null, liquidityUsd: null });
  const report = analyzeChanges({ ca: CA, period: "6h", current });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye, dexscreener],
  });

  assert.deepEqual(points, []);
});

test("a qualifying move keeps the event time and figures", () => {
  const current = snapshot({
    priceUsd: 0.25,
    liquidityUsd: 10_000,
    capturedAt: at(T),
  });
  const report = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current,
    history: [point(T - PERIOD_MS["1h"], { priceUsd: 0 })],
    evidence: [birdeye, dexscreener],
  });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye],
  });
  const price = points[0];
  const event = report.timeline.find((item) => item.event.kind === "price")?.event;

  assert.equal(points.length, 1);
  assert.equal(price?.eventId, `price:${CA}:1h`);
  assert.equal(price?.occurredAt, event?.occurredAt);
  assert.deepEqual(price?.evidence, event && "evidence" in event ? event.evidence : []);
  assert.equal(
    price?.text,
    `Price moved from $0 to $0.25 over 1h. ${observed(START_1H)}`,
  );
  assert.notEqual(price?.evidence[0], event && "evidence" in event ? event.evidence[0] : price);
});

test("liquidity and volume sentences use the report direction and window", () => {
  const current = snapshot({
    priceUsd: 80,
    marketCapUsd: 80_000,
    liquidityUsd: 5_000,
    volumeUsd: { "6h": 5_000 },
  });
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current,
    history: [
      point(T - PERIOD_MS["6h"], {
        priceUsd: 100,
        liquidityUsd: 10_000,
        volumeUsd: { "6h": 1_000 },
      }),
    ],
    evidence: [birdeye],
  });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye],
  });
  const text = new Map(points.map((item) => [item.eventId, item.text]));

  assert.equal(points.length, 3);
  assert.equal(
    text.get(`price:${CA}:6h`),
    `Market cap moved down 20% over 6h, from $100,000 to $80,000. ${observed(START_6H)}`,
  );
  assert.equal(
    text.get(`liquidity:${CA}:6h`),
    `Liquidity moved down 50% over 6h, from $10,000 to $5,000. ${observed(START_6H)}`,
  );
  assert.equal(text.has(`volume:${CA}:6h`), false);
  assert.equal(
    report.timeline.some((item) => item.event.kind === "volume"),
    true,
  );
});

test("posts replace a price line when market cap cannot be compared", () => {
  const current = snapshot({ priceUsd: 0.0000588, marketCapUsd: 58_000 });
  const report = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current,
    posts: [
      xEvent("1", at(T - 2_000), "anti ai? https://t.co/Dp1w2faaX4"),
      xEvent("2", at(T - 1_000), "second note"),
      xEvent("3", at(T), "newest note"),
    ],
  });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye],
  });

  assert.deepEqual(
    points.map((item) => item.eventId),
    ["x:3", "x:2", "x:1"],
  );
  assert.equal(
    points.some((item) => item.text.includes("baseline")),
    false,
  );
  assert.equal(
    points[2]?.text,
    `@circle posted at ${at(T - 2_000)}: "anti ai? https://t.co/Dp1w2faaX4".`,
  );

  const one = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current,
    posts: [xEvent("1", at(T), "only note")],
  });
  const alone = generateBriefSummary({
    report: one,
    snapshot: current,
    evidence: [birdeye],
  });
  assert.deepEqual(
    alone.map((item) => item.eventId),
    ["x:1"],
  );
});

test("website and X points quote the change at the event time", () => {
  const current = snapshot();
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current,
    posts: [xEvent("q", at(T), 'Say "hi"')],
    websiteChanges: [
      websiteEvent("site-a", at(T - 1_000)),
      websiteEvent("site-b", at(T)),
    ],
  });
  const points = generateBriefSummary({
    report,
    snapshot: current,
    evidence: [birdeye],
  });

  assert.deepEqual(
    points.map((item) => item.eventId),
    ["site-b", "x:q"],
  );
  assert.equal(
    points[0]?.text,
    `2 website updates. Latest at ${END}: https://example.com Title changed.`,
  );
  assert.equal(
    points[1]?.text,
    `@circle posted at ${END}: "Say \\"hi\\"".`,
  );
  assert.equal(points[1]?.occurredAt, END);
  assert.equal(points[1]?.evidence[0]?.url, "https://x.com/circle/status/q");
});

test("five ranked changes are kept and fewer than five are not padded", () => {
  const current = snapshot({
    priceUsd: 120,
    liquidityUsd: 13_000,
    volumeUsd: { "6h": 5_000 },
  });
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current,
    history: [
      point(T - PERIOD_MS["6h"], {
        priceUsd: 100,
        liquidityUsd: 10_000,
        volumeUsd: { "6h": 1_000 },
      }),
    ],
    evidence: [birdeye],
    posts: [xEvent("100", at(T))],
    websiteChanges: [websiteEvent("site-1", at(T))],
  });
  const points = generateBriefSummary({ report, snapshot: current });

  assert.equal(points.length, 4);
  assert.deepEqual(
    points.map((item) => item.eventId),
    report.summaryCandidates.map((item) => item.event.id),
  );
  assert.equal(
    points.some((item) => item.eventId === `volume:${CA}:6h`),
    false,
  );
  for (const item of points) {
    const event = report.timeline.find((ranked) => ranked.event.id === item.eventId)?.event;
    assert.ok(event);
    assert.equal(item.occurredAt, event.occurredAt);
    assert.deepEqual(item.evidence, event.evidence);
    assert.equal(item.text.includes(item.occurredAt), true);
    assert.equal(/\bSources?:/.test(item.text), false);
  }

  const published = parseBrief({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    shareId: "11111111-1111-4111-8111-111111111111",
    ca: CA,
    period: "6h",
    generatedAt: END,
    snapshot: current,
    summary: points,
    events: report.timeline.map((item) => item.event),
  });
  assert.equal(published.summary.length, 4);

  const websites = ["a", "b", "c", "d"].map((id) => websiteEvent(`site-${id}`, at(T)));
  const four = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot(),
    websiteChanges: websites,
  });
  const short = generateBriefSummary({
    report: four,
    snapshot: snapshot(),
    evidence: [birdeye],
  });
  assert.equal(four.summaryCandidates.length, 1);
  assert.equal(short.length, 1);
  assert.equal(short[0]?.eventId, "site-a");
  assert.equal(short.filter((item) => item.eventId == null).length, 0);
});

test("the generator fails closed when a point cannot be grounded", () => {
  const current = snapshot({ priceUsd: 120 });
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current,
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence: [birdeye],
  });
  const comparable = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 1, liquidityUsd: 10_000 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 1, liquidityUsd: 10_000 })],
  });

  assert.throws(
    () => generateBriefSummary({ report: comparable, snapshot: snapshot({ priceUsd: 1, liquidityUsd: 10_000 }) }),
    /market evidence link/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report: comparable,
        snapshot: snapshot({ priceUsd: 1, liquidityUsd: 10_000 }),
        evidence: [
          {
            id: "x:1",
            source: "x",
            url: "https://x.com/circle/status/1",
            label: "Post",
          },
        ],
      }),
    /market data sources/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report,
        snapshot: snapshot({ ca: OTHER_CA, priceUsd: 120 }),
        evidence: [birdeye],
      }),
    /different token/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report,
        snapshot: snapshot({ priceUsd: 120, capturedAt: at(T - 60_000) }),
        evidence: [birdeye],
      }),
    /does not match the snapshot/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report,
        snapshot: snapshot({ priceUsd: 120, capturedAt: at(T - PERIOD_MS["6h"]) }),
        evidence: [birdeye],
      }),
    /outside the report window/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report: { ...report, summaryCandidates: [] },
        snapshot: current,
        evidence: [birdeye],
      }),
    /need its own summary point/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report: {
          ...report,
          price: { ...report.price, previousUsd: 1 },
        },
        snapshot: current,
        evidence: [birdeye],
      }),
    /figures do not match/,
  );
  assert.throws(
    () =>
      generateBriefSummary({
        report: {
          ...report,
          price: { ...report.price, currentUsd: 9 },
        },
        snapshot: current,
        evidence: [birdeye],
      }),
    /does not match the snapshot/,
  );

  const crowded = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 120 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence: [birdeye],
    websiteChanges: ["a", "b", "c", "d", "e"].map((id) => websiteEvent(`site-${id}`, at(T))),
  });
  assert.throws(
    () =>
      generateBriefSummary({
        report: { ...crowded, summaryCandidates: crowded.timeline },
        snapshot: snapshot({ priceUsd: 120 }),
      }),
    /at most 5/,
  );

  const forged = report.summaryCandidates[0];
  assert.ok(forged);
  assert.throws(
    () =>
      generateBriefSummary({
        report: {
          ...report,
          summaryCandidates: [
            {
              ...forged,
              rank: 9,
              event: { ...forged.event, id: "forged" },
            },
          ],
        },
        snapshot: current,
        evidence: [birdeye],
      }),
    /not in the timeline/,
  );
});
