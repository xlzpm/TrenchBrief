import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BRIEF_PERIODS, type BriefPeriod } from "../dto/common";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";
import { parseTokenSnapshot, type TokenSnapshot } from "../dto/token-snapshot";
import {
  BASELINE_SKEW_MS,
  LIQUIDITY_CHANGE_THRESHOLD_PCT,
  LIQUIDITY_MATERIAL_USD,
  PERIOD_MS,
  PRICE_CHANGE_THRESHOLD_PCT,
  VOLUME_ABSOLUTE_USD,
  VOLUME_CHANGE_THRESHOLD_PCT,
  VOLUME_NOTABLE_USD,
  VOLUME_TURNOVER_THRESHOLD,
  DeltaEngineError,
  analyzeChanges,
  type MarketPoint,
} from "./delta-engine";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_CA = "So11111111111111111111111111111111111111112";
const T = Date.parse("2026-10-26T12:00:00.000Z");

const evidence = [
  {
    id: `birdeye:${CA}`,
    source: "birdeye" as const,
    url: `https://birdeye.so/token/${CA}?chain=solana`,
    label: "Birdeye",
  },
  {
    id: `dexscreener:${CA}`,
    source: "dexscreener" as const,
    url: `https://dexscreener.com/solana/${CA}`,
    label: "DexScreener",
  },
];

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

function windowVolume(
  period: BriefPeriod,
  amount: number,
): Partial<TokenSnapshot["volumeUsd"]> {
  return {
    "1h": period === "1h" ? amount : null,
    "6h": period === "6h" ? amount : null,
    "12h": period === "12h" ? amount : null,
    "24h": period === "24h" ? amount : null,
  };
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

function websiteEvent(id: string, occurredAt: string, seed = id): TimelineEvent {
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
    contentHash: hash(seed),
    diffSummary: "Title changed.",
  });
}

test("period lengths and baseline skew stay inside each window", () => {
  assert.deepEqual(PERIOD_MS, {
    "1h": 3_600_000,
    "6h": 21_600_000,
    "12h": 43_200_000,
    "24h": 86_400_000,
  });
  assert.deepEqual(BASELINE_SKEW_MS, {
    "1h": 900_000,
    "6h": 2_700_000,
    "12h": 5_400_000,
    "24h": 7_200_000,
  });
  assert.deepEqual(PRICE_CHANGE_THRESHOLD_PCT, {
    "1h": 5,
    "6h": 10,
    "12h": 15,
    "24h": 20,
  });
  assert.deepEqual(LIQUIDITY_CHANGE_THRESHOLD_PCT, {
    "1h": 10,
    "6h": 15,
    "12h": 20,
    "24h": 25,
  });
  assert.deepEqual(VOLUME_CHANGE_THRESHOLD_PCT, {
    "1h": 50,
    "6h": 40,
    "12h": 35,
    "24h": 30,
  });
  assert.deepEqual(VOLUME_TURNOVER_THRESHOLD, {
    "1h": 0.5,
    "6h": 1,
    "12h": 1.5,
    "24h": 2,
  });
  for (const period of BRIEF_PERIODS) {
    assert.ok(BASELINE_SKEW_MS[period] < PERIOD_MS[period]);
  }
});

test("price significance follows the period threshold", () => {
  for (const period of BRIEF_PERIODS) {
    const threshold = PRICE_CHANGE_THRESHOLD_PCT[period];
    const hit = analyzeChanges({
      ca: CA,
      period,
      now: at(T),
      current: snapshot({ priceUsd: 100 + threshold }),
      history: [point(T - PERIOD_MS[period], { priceUsd: 100 })],
      evidence,
    });
    const miss = analyzeChanges({
      ca: CA,
      period,
      now: at(T),
      current: snapshot({ priceUsd: 99 + threshold }),
      history: [point(T - PERIOD_MS[period], { priceUsd: 100 })],
      evidence,
    });

    assert.equal(hit.price.significant, true, period);
    assert.equal(hit.price.changePct, threshold, period);
    assert.equal(hit.timeline.some((item) => item.event.kind === "price"), true);
    assert.equal(miss.price.significant, false, period);
    assert.equal(miss.price.changePct, threshold - 1, period);
    assert.equal(miss.timeline.some((item) => item.event.kind === "price"), false);
  }
});

test("liquidity significance requires a material pool or an extreme move", () => {
  for (const period of BRIEF_PERIODS) {
    const threshold = LIQUIDITY_CHANGE_THRESHOLD_PCT[period];
    const hit = analyzeChanges({
      ca: CA,
      period,
      now: at(T),
      current: snapshot({ liquidityUsd: 10_000 * (1 + threshold / 100) }),
      history: [point(T - PERIOD_MS[period], { liquidityUsd: 10_000 })],
      evidence,
    });
    const miss = analyzeChanges({
      ca: CA,
      period,
      now: at(T),
      current: snapshot({ liquidityUsd: 10_000 * (1 + (threshold - 1) / 100) }),
      history: [point(T - PERIOD_MS[period], { liquidityUsd: 10_000 })],
      evidence,
    });
    assert.equal(hit.liquidity.significant, true, period);
    assert.equal(miss.liquidity.significant, false, period);
  }

  const wiggle = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot({ liquidityUsd: 140 }),
    history: [point(T - PERIOD_MS["1h"], { liquidityUsd: 100 })],
    evidence,
  });
  const rug = analyzeChanges({
    ca: CA,
    period: "24h",
    now: at(T),
    current: snapshot({ liquidityUsd: 100 }),
    history: [point(T - PERIOD_MS["24h"], { liquidityUsd: 200 })],
    evidence,
  });
  const fromZero = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ liquidityUsd: LIQUIDITY_MATERIAL_USD }),
    history: [point(T - PERIOD_MS["6h"], { liquidityUsd: 0 })],
    evidence,
  });
  const dustPool = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ liquidityUsd: LIQUIDITY_MATERIAL_USD - 1 }),
    history: [point(T - PERIOD_MS["6h"], { liquidityUsd: 0 })],
    evidence,
  });

  assert.equal(wiggle.liquidity.changePct, 40);
  assert.equal(wiggle.liquidity.significant, false);
  assert.equal(rug.liquidity.changePct, -50);
  assert.equal(rug.liquidity.significant, true);
  assert.equal(rug.timeline[0]?.event.title, "Liquidity down 50% over 24h");
  assert.equal(fromZero.liquidity.significant, true);
  assert.equal(fromZero.liquidity.changePct, null);
  assert.equal(fromZero.timeline[0]?.event.title, "Liquidity rose to $1,000 over 6h");
  assert.equal(dustPool.liquidity.significant, false);
});

test("volume uses the selected window for level and prior-window change", () => {
  for (const period of BRIEF_PERIODS) {
    const threshold = VOLUME_CHANGE_THRESHOLD_PCT[period];
    const hit = analyzeChanges({
      ca: CA,
      period,
      now: at(T),
      current: snapshot({
        liquidityUsd: 10_000_000,
        volumeUsd: windowVolume(period, 10_000 * (1 + threshold / 100)),
      }),
      history: [
        point(T - PERIOD_MS[period], {
          volumeUsd: windowVolume(period, 10_000),
        }),
      ],
      evidence,
    });
    const miss = analyzeChanges({
      ca: CA,
      period,
      now: at(T),
      current: snapshot({
        liquidityUsd: 10_000_000,
        volumeUsd: windowVolume(period, 10_000 * (1 + (threshold - 1) / 100)),
      }),
      history: [
        point(T - PERIOD_MS[period], {
          volumeUsd: windowVolume(period, 10_000),
        }),
      ],
      evidence,
    });
    assert.equal(hit.volume.changeSignificant, true, period);
    assert.equal(miss.volume.changeSignificant, false, period);
    assert.equal(hit.volume.levelSignificant, false, period);
  }

  const hot = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot({
      liquidityUsd: 10_000,
      volumeUsd: { "1h": 5_000, "24h": 80_000 },
    }),
    evidence,
  });
  const quietHour = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot({
      liquidityUsd: 10_000,
      volumeUsd: { "1h": 4_999, "24h": 80_000 },
    }),
    evidence,
  });
  const absolute = analyzeChanges({
    ca: CA,
    period: "24h",
    now: at(T),
    current: snapshot({
      liquidityUsd: 500_000,
      volumeUsd: { "24h": VOLUME_ABSOLUTE_USD, "1h": 100 },
    }),
    evidence,
  });
  const belowAbsolute = analyzeChanges({
    ca: CA,
    period: "24h",
    now: at(T),
    current: snapshot({
      liquidityUsd: 500_000,
      volumeUsd: { "24h": VOLUME_ABSOLUTE_USD - 1 },
    }),
    evidence,
  });
  const awakened = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({
      liquidityUsd: 10_000_000,
      volumeUsd: { "6h": VOLUME_NOTABLE_USD },
    }),
    history: [point(T - PERIOD_MS["6h"], { volumeUsd: { "6h": 0 } })],
    evidence,
  });

  assert.equal(hot.volume.turnover, 0.5);
  assert.equal(hot.volume.levelSignificant, true);
  assert.equal(hot.timeline[0]?.event.kind, "volume");
  const hotEvent = hot.timeline[0]?.event;
  assert.equal(hotEvent?.kind === "volume" ? hotEvent.window : "", "1h");
  assert.equal(hotEvent?.title, "1h volume $5,000 (0.5× liquidity)");
  assert.equal(quietHour.volume.significant, false);
  assert.equal(absolute.timeline[0]?.event.title, "24h volume $50,000 (0.1× liquidity)");
  assert.equal(belowAbsolute.volume.significant, false);
  assert.equal(awakened.volume.changePct, null);
  assert.equal(
    awakened.timeline[0]?.event.title,
    "6h volume rose to $1,000 from no prior volume",
  );
});

test("each period compares against its own baseline", () => {
  const history = [
    point(T - PERIOD_MS["1h"], { priceUsd: 100 }),
    point(T - PERIOD_MS["6h"], { priceUsd: 50 }),
  ];
  const hour = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot({ priceUsd: 110 }),
    history,
    evidence,
  });
  const six = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 110 }),
    history,
    evidence,
  });

  assert.equal(hour.baselineCapturedAt, at(T - PERIOD_MS["1h"]));
  assert.equal(hour.price.previousUsd, 100);
  assert.equal(hour.price.changePct, 10);
  assert.equal(hour.windowStart, at(T - PERIOD_MS["1h"]));
  assert.equal(hour.windowEnd, at(T));
  assert.equal(six.baselineCapturedAt, at(T - PERIOD_MS["6h"]));
  assert.equal(six.price.previousUsd, 50);
  assert.equal(six.price.changePct, 120);
  assert.equal(six.timeline[0]?.event.title, "Price up 120% over 6h");
});

test("baseline selection stays near the window start", () => {
  const period: BriefPeriod = "6h";
  const start = T - PERIOD_MS[period];
  const current = snapshot({ priceUsd: 100 });

  const closest = analyzeChanges({
    ca: CA,
    period,
    now: at(T),
    current,
    history: [
      point(start - 40 * 60 * 1000, { priceUsd: 10 }),
      point(start - 5 * 60 * 1000, { priceUsd: 80 }),
    ],
    evidence,
  });
  const beforeOverAfter = analyzeChanges({
    ca: CA,
    period,
    now: at(T),
    current,
    history: [
      point(start + 10 * 60 * 1000, { priceUsd: 10 }),
      point(start - 10 * 60 * 1000, { priceUsd: 80 }),
    ],
    evidence,
  });
  const afterOnly = analyzeChanges({
    ca: CA,
    period,
    now: at(T),
    current,
    history: [point(start + 10 * 60 * 1000, { priceUsd: 70 })],
    evidence,
  });
  const onBoundary = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current,
    history: [point(T - PERIOD_MS["1h"] - BASELINE_SKEW_MS["1h"], { priceUsd: 80 })],
    evidence,
  });
  const outside = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current,
    history: [
      point(T - PERIOD_MS["1h"] - BASELINE_SKEW_MS["1h"] - 1, { priceUsd: 10 }),
    ],
    evidence,
  });
  const moreComplete = analyzeChanges({
    ca: CA,
    period,
    now: at(T),
    current: snapshot({ priceUsd: 80, liquidityUsd: 10_000 }),
    history: [
      point(start, { priceUsd: 80, liquidityUsd: 10_000 }),
      point(start, { priceUsd: 10 }),
    ],
    evidence,
  });
  const laterEqual = analyzeChanges({
    ca: CA,
    period,
    now: at(T),
    current,
    history: [
      point(start, { priceUsd: 80, liquidityUsd: 10_000 }),
      point(start, { priceUsd: 50, liquidityUsd: 10_000 }),
    ],
    evidence,
  });

  assert.equal(closest.price.previousUsd, 80);
  assert.equal(beforeOverAfter.price.previousUsd, 80);
  assert.equal(afterOnly.price.previousUsd, 70);
  assert.equal(onBoundary.price.previousUsd, 80);
  assert.equal(outside.baselineCapturedAt, null);
  assert.equal(outside.price.previousUsd, null);
  assert.equal(outside.price.currentUsd, 100);
  assert.equal(outside.price.significant, false);
  assert.equal(moreComplete.price.previousUsd, 80);
  assert.equal(moreComplete.price.significant, false);
  assert.equal(laterEqual.price.previousUsd, 50);
});

test("a quiet window keeps the raw readings and an empty timeline", () => {
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    current: snapshot({ priceUsd: 1, liquidityUsd: 10_000, volumeUsd: { "6h": 100 } }),
  });

  assert.equal(report.baselineCapturedAt, null);
  assert.equal(report.price.currentUsd, 1);
  assert.equal(report.price.significant, false);
  assert.equal(report.liquidity.significant, false);
  assert.equal(report.volume.significant, false);
  assert.deepEqual(report.timeline, []);
  assert.deepEqual(report.summaryCandidates, []);
});

test("percent rounding and from-zero price stay exact", () => {
  const rounded = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 4 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 3 })],
    evidence,
  });
  const listed = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot({ priceUsd: 0.25 }),
    history: [point(T - PERIOD_MS["1h"], { priceUsd: 0 })],
    evidence,
  });
  const flat = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 0 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 0 })],
    evidence,
  });

  assert.equal(rounded.price.changePct, 33.3333);
  assert.equal(listed.price.changePct, null);
  assert.equal(listed.price.significant, true);
  assert.equal(listed.timeline[0]?.event.title, "Price rose to $0.25 over 1h");
  assert.equal(flat.price.significant, false);
});

test("market events carry every evidence link and the snapshot time", () => {
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 80 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence: [evidence[0]!, evidence[0]!, evidence[1]!],
  });
  const event = report.timeline[0]?.event;

  assert.equal(event?.kind, "price");
  assert.equal(event?.id, `price:${CA}:6h`);
  assert.equal(event?.occurredAt, at(T));
  assert.equal(event?.title, "Price down 20% over 6h");
  const capped = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 80, marketCapUsd: 80_000 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence,
  });
  assert.equal(capped.timeline[0]?.event.title, "Market cap down 20% over 6h");
  assert.deepEqual(
    event?.evidence.map((link) => link.source),
    ["birdeye", "dexscreener"],
  );
  assert.equal(parseTimelineEvent(event).kind, "price");
});

test("ranking weights liquidity drops, large moves, and fresh posts", () => {
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({
      priceUsd: 120,
      liquidityUsd: 7_000,
      volumeUsd: { "6h": 1_800 },
    }),
    history: [
      point(T - PERIOD_MS["6h"], {
        priceUsd: 100,
        liquidityUsd: 10_000,
        volumeUsd: { "6h": 1_000 },
      }),
    ],
    evidence,
    posts: [xEvent("100", at(T))],
    websiteChanges: [websiteEvent("site-1", at(T))],
  });
  const rise = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 120 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence,
  });
  const drop = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 80 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence,
  });
  const crash = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 200 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence,
    websiteChanges: [websiteEvent("site-crash", at(T))],
  });

  assert.deepEqual(
    report.timeline.map((item) => item.event.kind),
    ["liquidity", "website", "price", "volume", "x_post"],
  );
  // Liquidity -30%: base 46 + magnitude 15 + drop 8 + recency 10.
  assert.equal(report.timeline[0]?.score, 79);
  assert.equal(report.timeline[1]?.score, 68);
  assert.equal(report.timeline[2]?.score, 65);
  assert.equal(report.timeline[3]?.score, 57);
  assert.equal(report.timeline[4]?.score, 38);
  assert.deepEqual(
    report.timeline.map((item) => item.rank),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    report.summaryCandidates.map((item) => item.event.kind),
    ["liquidity", "website", "price", "x_post"],
  );
  assert.equal(rise.timeline[0]?.score, drop.timeline[0]?.score);
  assert.equal(crash.timeline[0]?.event.kind, "price");
  assert.ok((crash.timeline[0]?.score ?? 0) > (crash.timeline[1]?.score ?? 0));
});

test("summary candidates keep a lower-ranked kind and cap at five", () => {
  const websites = ["a", "b", "c", "d", "e"].map((id) =>
    websiteEvent(`site-${id}`, at(T), id),
  );
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot({ priceUsd: 120 }),
    history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
    evidence,
    websiteChanges: websites,
  });

  assert.equal(report.timeline.length, 6);
  assert.equal(report.timeline[5]?.event.kind, "price");
  assert.equal(report.timeline[5]?.rank, 6);
  assert.deepEqual(
    report.summaryCandidates.map((item) => item.event.id),
    ["site-a", `price:${CA}:6h`],
  );
  assert.equal(report.summaryCandidates[1]?.rank, 6);
  assert.equal(
    report.summaryCandidates.every((item) =>
      report.timeline.some((ranked) => ranked.event.id === item.event.id),
    ),
    true,
  );
});

test("equal scores break ties by recency and then id", () => {
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot(),
    posts: [
      xEvent("b", at(T - 60_000)),
      xEvent("a", at(T - 60_000)),
      xEvent("c", at(T)),
    ],
  });

  assert.deepEqual(
    report.timeline.map((item) => item.event.id),
    ["x:c", "x:a", "x:b"],
  );
});

test("activity outside the window is dropped and duplicates collapse", () => {
  const start = T - PERIOD_MS["6h"];
  const report = analyzeChanges({
    ca: CA,
    period: "6h",
    now: at(T),
    current: snapshot(),
    posts: [
      xEvent("old", at(start), "stale"),
      xEvent("edge", at(start + 1_000), "first"),
      xEvent("edge", at(T), "latest"),
      xEvent("future", at(T + 60_000)),
    ],
    websiteChanges: [
      websiteEvent("site-old", at(start), "same-page"),
      websiteEvent("site-early", at(start + 1_000), "same-page"),
      websiteEvent("site-late", at(T - 60_000), "same-page"),
    ],
  });

  assert.deepEqual(
    report.timeline.map((item) => item.event.id),
    ["site-late", "x:edge"],
  );
  const post = report.timeline.find((item) => item.event.kind === "x_post")?.event;
  assert.equal(post?.kind === "x_post" ? post.textExcerpt : "", "latest");
});

test("the current snapshot has to sit near the window end", () => {
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "1h",
        now: at(T),
        current: snapshot({ capturedAt: at(T - BASELINE_SKEW_MS["1h"] - 1) }),
      }),
    DeltaEngineError,
  );
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "1h",
        now: at(T),
        current: snapshot({ capturedAt: at(T + 1) }),
      }),
    DeltaEngineError,
  );
  const accepted = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot({
      capturedAt: at(T - 10 * 60 * 1000),
      priceUsd: 110,
    }),
    history: [point(T - PERIOD_MS["1h"], { priceUsd: 100 })],
    evidence,
  });
  assert.equal(accepted.price.significant, true);
});

test("mismatched tokens, stale history, and missing evidence fail closed", () => {
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "1h",
        current: snapshot({ ca: OTHER_CA }),
      }),
    /different token/,
  );
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "6h",
        current: snapshot(),
        history: [point(T, { priceUsd: 1, liquidityUsd: 1 })],
      }),
    /older than the current snapshot/,
  );
  const foreignHistory = {
    ...point(T - PERIOD_MS["6h"], { priceUsd: 1 }),
    ca: OTHER_CA,
  };
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "6h",
        current: snapshot(),
        history: [foreignHistory],
      }),
    /different token/,
  );
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "6h",
        now: at(T),
        current: snapshot({ priceUsd: 120 }),
        history: [point(T - PERIOD_MS["6h"], { priceUsd: 100 })],
      }),
    /evidence link/,
  );
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "6h",
        current: snapshot(),
        posts: [websiteEvent("site-1", at(T))],
      }),
    /x_post/,
  );
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "6h",
        current: snapshot(),
        posts: [xEvent("1", at(T))].map((event) => ({ ...event, ca: OTHER_CA })),
      }),
    /does not match/,
  );

  const sharedId = xEvent("1", at(T - 1_000));
  const collided = xEvent("2", at(T));
  assert.throws(
    () =>
      analyzeChanges({
        ca: CA,
        period: "6h",
        now: at(T),
        current: snapshot(),
        posts: [{ ...sharedId }, { ...collided, id: sharedId.id }],
      }),
    /Duplicate event id/,
  );
});

test("a token snapshot is accepted as a history point", () => {
  const report = analyzeChanges({
    ca: CA,
    period: "12h",
    now: at(T),
    current: snapshot({ priceUsd: 2 }),
    history: [snapshot({ capturedAt: at(T - PERIOD_MS["12h"]), priceUsd: 1 })],
    evidence,
  });

  assert.equal(report.price.previousUsd, 1);
  assert.equal(report.price.changePct, 100);
  assert.equal(report.timeline[0]?.event.title, "Price up 100% over 12h");
});

test("a large account posting the contract outranks the project's own post", () => {
  const call = parseTimelineEvent({
    id: "x:call",
    ca: CA,
    kind: "x_post",
    occurredAt: at(T),
    title: "Call from @ansem",
    evidence: [
      {
        id: "x:call",
        source: "x",
        url: "https://x.com/ansem/status/call",
        label: "Post by @ansem",
      },
    ],
    account: "ansem",
    postId: "call",
    postUrl: "https://x.com/ansem/status/call",
    textExcerpt: `Sending ${CA}`,
    followers: 120_000,
    about: "contract",
  });
  const report = analyzeChanges({
    ca: CA,
    period: "1h",
    now: at(T),
    current: snapshot(),
    posts: [xEvent("own", at(T - 1_000)), call],
    listings: [
      parseTimelineEvent({
        id: "dex:profile:1:0",
        ca: CA,
        kind: "listing",
        occurredAt: at(T),
        title: "Paid DexScreener profile",
        evidence: [
          {
            id: "dex:profile:1:0",
            source: "dexscreener",
            url: `https://dexscreener.com/solana/${CA}`,
            label: "DexScreener token page",
          },
        ],
        url: `https://dexscreener.com/solana/${CA}`,
        placement: "profile",
      }),
    ],
  });
  assert.equal(report.timeline[0]?.event.id, "x:call");
  assert.equal(
    report.summaryCandidates.find((item) => item.event.kind === "x_post")?.event.id,
    "x:call",
  );
  assert.equal(
    report.timeline.some((item) => item.event.kind === "listing"),
    true,
  );
});
