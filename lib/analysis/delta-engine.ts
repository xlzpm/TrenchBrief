import { z } from "zod";

import { sourceStrength } from "../brief/token-attention";
import {
  briefPeriodSchema,
  evidenceLinkSchema,
  isoDateTimeSchema,
  nullableUsdSchema,
  solanaAddressSchema,
  type BriefPeriod,
  type EvidenceLink,
} from "../dto/common";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";
import {
  parseTokenSnapshot,
  volumeUsdByPeriodSchema,
  type TokenSnapshot,
} from "../dto/token-snapshot";
import { formatMultiple, formatPct, formatUsd } from "../format/amounts";
import { marketCapReading } from "./market-cap";

/**
 * Compares the latest snapshot with the reading nearest the start of a
 * 1h, 6h, 12h, or 24h window. Price and liquidity need that baseline.
 * Window volume already lives on the current snapshot; baseline volume is
 * the previous window. Moves that clear the period thresholds are ranked
 * for the timeline and for a diverse summary shortlist.
 */

const HOUR_MS = 60 * 60 * 1000;

export const PERIOD_MS = {
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "24h": 24 * HOUR_MS,
} as const satisfies Record<BriefPeriod, number>;

/** How far a history point may sit from the window start and still count. */
export const BASELINE_SKEW_MS = {
  "1h": 15 * 60 * 1000,
  "6h": 45 * 60 * 1000,
  "12h": 90 * 60 * 1000,
  "24h": 2 * HOUR_MS,
} as const satisfies Record<BriefPeriod, number>;

/** Absolute percent move required before a price change is worth reporting. */
export const PRICE_CHANGE_THRESHOLD_PCT = {
  "1h": 5,
  "6h": 10,
  "12h": 15,
  "24h": 20,
} as const satisfies Record<BriefPeriod, number>;

export const LIQUIDITY_CHANGE_THRESHOLD_PCT = {
  "1h": 10,
  "6h": 15,
  "12h": 20,
  "24h": 25,
} as const satisfies Record<BriefPeriod, number>;

/** Pools at least this large can qualify on the period percent alone. */
export const LIQUIDITY_MATERIAL_USD = 1_000;

/** A rug-shaped liquidity move qualifies even when the pool is small. */
export const LIQUIDITY_EXTREME_PCT = 50;

export const VOLUME_CHANGE_THRESHOLD_PCT = {
  "1h": 50,
  "6h": 40,
  "12h": 35,
  "24h": 30,
} as const satisfies Record<BriefPeriod, number>;

/** Ignore window-over-window volume moves below this traded amount. */
export const VOLUME_NOTABLE_USD = 1_000;

/** A window this large is active even when turnover versus liquidity is low. */
export const VOLUME_ABSOLUTE_USD = 50_000;

/** Current window volume divided by current liquidity. */
export const VOLUME_TURNOVER_THRESHOLD = {
  "1h": 0.5,
  "6h": 1,
  "12h": 1.5,
  "24h": 2,
} as const satisfies Record<BriefPeriod, number>;

export const SUMMARY_CANDIDATE_LIMIT = 5;

const KIND_BASE = {
  price: 40,
  liquidity: 46,
  volume: 32,
  website: 58,
  x_post: 28,
  listing: 52,
} as const satisfies Record<TimelineEvent["kind"], number>;

const KIND_RANK = {
  website: 0,
  liquidity: 1,
  price: 2,
  volume: 3,
  x_post: 4,
  listing: 5,
} as const satisfies Record<TimelineEvent["kind"], number>;

const MAGNITUDE_CAP = 40;
const LIQUIDITY_BONUS_CAP = 48;
const FROM_ZERO_BONUS = 24;
const LIQUIDITY_DROP_BONUS = 8;
const TURNOVER_LEVEL_BONUS = 6;
const ABSOLUTE_VOLUME_BONUS = 10;

const marketPointSchema = z.object({
  capturedAt: isoDateTimeSchema,
  priceUsd: nullableUsdSchema,
  liquidityUsd: nullableUsdSchema,
  volumeUsd: volumeUsdByPeriodSchema,
});

export class DeltaEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type MarketPoint = z.infer<typeof marketPointSchema>;

export type DeltaEngineInput = {
  ca: string;
  period: BriefPeriod;
  /** Window end. Defaults to the current snapshot time. */
  now?: Date | string;
  current: TokenSnapshot;
  /** Readings older than `current`. The nearest one to the window start is the baseline. */
  history?: readonly MarketPoint[];
  /** Provenance attached to price, liquidity, and volume events. */
  evidence?: readonly EvidenceLink[];
  posts?: readonly TimelineEvent[];
  websiteChanges?: readonly TimelineEvent[];
  /** Paid DexScreener orders for this mint. */
  listings?: readonly TimelineEvent[];
};

export type MetricDelta = {
  /** Null when this metric has no baseline reading. */
  previousUsd: number | null;
  currentUsd: number | null;
  /** Null when the previous reading is missing or zero. */
  changePct: number | null;
  significant: boolean;
};

export type VolumeDelta = MetricDelta & {
  /** Current window volume divided by current liquidity. */
  turnover: number | null;
  levelSignificant: boolean;
  changeSignificant: boolean;
};

export type RankedEvent = {
  event: TimelineEvent;
  score: number;
  /** 1-based position in `timeline`, highest score first. */
  rank: number;
};

export type DeltaReport = {
  ca: string;
  period: BriefPeriod;
  windowStart: string;
  windowEnd: string;
  baselineCapturedAt: string | null;
  price: MetricDelta;
  liquidity: MetricDelta;
  volume: VolumeDelta;
  /** Significant events, highest score first. */
  timeline: RankedEvent[];
  /**
   * Up to five timeline events for the summary.
   * Distinct kinds are kept first, then the list fills by score.
   * `rank` still refers to the full timeline. Fewer than three is valid.
   */
  summaryCandidates: RankedEvent[];
};

type ScoredEvent = {
  event: TimelineEvent;
  score: number;
};

type ActivityKind = "x_post" | "website" | "listing";

export function analyzeChanges(input: DeltaEngineInput): DeltaReport {
  const ca = solanaAddressSchema.parse(input.ca);
  const period = briefPeriodSchema.parse(input.period);
  const current = parseTokenSnapshot(input.current);
  if (current.ca !== ca) {
    throw new DeltaEngineError("Current snapshot is for a different token.");
  }

  const evidence = readEvidence(input.evidence);
  const history = (input.history ?? []).map((point) => readMarketPoint(point, ca));
  const currentMs = Date.parse(current.capturedAt);
  for (const point of history) {
    if (Date.parse(point.capturedAt) >= currentMs) {
      throw new DeltaEngineError(
        "Market history must be older than the current snapshot.",
      );
    }
  }

  const windowEnd = readWindowEnd(input.now, current.capturedAt);
  const windowStart = windowEnd - PERIOD_MS[period];
  const skew = BASELINE_SKEW_MS[period];
  if (currentMs > windowEnd || currentMs < windowEnd - skew) {
    throw new DeltaEngineError("Current snapshot is outside the requested window.");
  }

  const baseline = selectBaseline(history, windowStart, skew, period);
  const previousPrice = baseline?.priceUsd ?? null;
  const pricePct = pairChangePct(previousPrice, current.priceUsd);
  const price = metric(
    previousPrice,
    current.priceUsd,
    pricePct,
    priceIsSignificant(previousPrice, current.priceUsd, pricePct, period),
  );

  const previousLiquidity = baseline?.liquidityUsd ?? null;
  const liquidityPct = pairChangePct(previousLiquidity, current.liquidityUsd);
  const liquidity = metric(
    previousLiquidity,
    current.liquidityUsd,
    liquidityPct,
    liquidityIsSignificant(
      previousLiquidity,
      current.liquidityUsd,
      liquidityPct,
      period,
    ),
  );

  const previousVolume = baseline?.volumeUsd[period] ?? null;
  const currentVolume = current.volumeUsd[period];
  const volumePct = pairChangePct(previousVolume, currentVolume);
  const turns = turnover(currentVolume, current.liquidityUsd);
  const levelSignificant = volumeLevelIsSignificant(currentVolume, turns, period);
  const changeSignificant = volumeChangeIsSignificant(
    previousVolume,
    currentVolume,
    volumePct,
    period,
  );
  const volume: VolumeDelta = {
    ...metric(
      previousVolume,
      currentVolume,
      volumePct,
      levelSignificant || changeSignificant,
    ),
    turnover: turns,
    levelSignificant,
    changeSignificant,
  };

  const posts = latestBy(
    readActivity(input.posts, "x_post", ca).filter((event) =>
      inWindow(event.occurredAt, windowStart, windowEnd),
    ),
    (event) => event.postId,
    (event) => Date.parse(event.occurredAt),
  );
  const listings = latestBy(
    readActivity(input.listings, "listing", ca).filter((event) =>
      inWindow(event.occurredAt, windowStart, windowEnd),
    ),
    (event) => event.id,
    (event) => Date.parse(event.occurredAt),
  );
  const websiteChanges = latestBy(
    readActivity(input.websiteChanges, "website", ca).filter((event) =>
      inWindow(event.occurredAt, windowStart, windowEnd),
    ),
    (event) => event.contentHash,
    (event) => Date.parse(event.occurredAt),
  );

  const scored: ScoredEvent[] = [];
  if (price.significant && previousPrice != null && current.priceUsd != null) {
    scored.push(
      scoreMarket({
        kind: "price",
        ca,
        period,
        occurredAt: current.capturedAt,
        occurredMs: currentMs,
        windowStart,
        windowEnd,
        title: moveTitle(
          marketCapReading(current.marketCapUsd, previousPrice, current.priceUsd)
            ? "Market cap"
            : "Price",
          previousPrice,
          current.priceUsd,
          pricePct,
          period,
        ),
        evidence,
        previousUsd: previousPrice,
        currentUsd: current.priceUsd,
        changePct: pricePct,
        bonus: moveBonus(pricePct, PRICE_CHANGE_THRESHOLD_PCT[period], "price"),
      }),
    );
  }
  if (
    liquidity.significant &&
    previousLiquidity != null &&
    current.liquidityUsd != null
  ) {
    scored.push(
      scoreMarket({
        kind: "liquidity",
        ca,
        period,
        occurredAt: current.capturedAt,
        occurredMs: currentMs,
        windowStart,
        windowEnd,
        title: moveTitle(
          "Liquidity",
          previousLiquidity,
          current.liquidityUsd,
          liquidityPct,
          period,
        ),
        evidence,
        previousUsd: previousLiquidity,
        currentUsd: current.liquidityUsd,
        changePct: liquidityPct,
        bonus: moveBonus(
          liquidityPct,
          LIQUIDITY_CHANGE_THRESHOLD_PCT[period],
          "liquidity",
        ),
      }),
    );
  }
  if (volume.significant && currentVolume != null) {
    scored.push(
      scoreMarket({
        kind: "volume",
        ca,
        period,
        occurredAt: current.capturedAt,
        occurredMs: currentMs,
        windowStart,
        windowEnd,
        title: volumeTitle(period, volume),
        evidence,
        previousUsd: previousVolume,
        currentUsd: currentVolume,
        changePct: volumePct,
        bonus: volumeBonus(period, volume),
      }),
    );
  }
  for (const event of websiteChanges) {
    scored.push({
      event,
      score:
        KIND_BASE.website +
        recencyBonus(Date.parse(event.occurredAt), windowStart, windowEnd),
    });
  }
  for (const event of posts) {
    scored.push({ event, score: postScore(event, windowStart, windowEnd) });
  }
  for (const event of listings) {
    scored.push({
      event,
      score:
        KIND_BASE.listing +
        recencyBonus(Date.parse(event.occurredAt), windowStart, windowEnd),
    });
  }

  assertUniqueEventIds(scored.map((item) => item.event));
  const timeline = scored
    .sort(byImportance)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    ca,
    period,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    baselineCapturedAt: baseline?.capturedAt ?? null,
    price,
    liquidity,
    volume,
    timeline,
    summaryCandidates: selectSummary(timeline),
  };
}

function readWindowEnd(now: Date | string | undefined, capturedAt: string): number {
  if (now == null) return Date.parse(capturedAt);
  if (now instanceof Date) {
    const ms = now.getTime();
    if (Number.isNaN(ms)) {
      throw new DeltaEngineError("Window end is not a valid time.");
    }
    return ms;
  }
  const parsed = isoDateTimeSchema.safeParse(now);
  if (!parsed.success) {
    throw new DeltaEngineError(
      "Window end must be an ISO-8601 timestamp with a timezone.",
    );
  }
  return Date.parse(parsed.data);
}

function readEvidence(links: readonly EvidenceLink[] | undefined): EvidenceLink[] {
  const seen = new Set<string>();
  const result: EvidenceLink[] = [];
  for (const link of links ?? []) {
    const parsed = evidenceLinkSchema.parse(link);
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    result.push(parsed);
  }
  return result;
}

function readMarketPoint(value: unknown, ca: string): MarketPoint {
  if (isRecord(value) && "ca" in value && value.ca !== ca) {
    throw new DeltaEngineError("Market history contains a different token.");
  }
  return marketPointSchema.parse(value);
}

function selectBaseline(
  history: readonly MarketPoint[],
  windowStart: number,
  skew: number,
  period: BriefPeriod,
): MarketPoint | null {
  let before: MarketPoint | null = null;
  let beforeDistance = Number.POSITIVE_INFINITY;
  let after: MarketPoint | null = null;
  let afterDistance = Number.POSITIVE_INFINITY;

  for (const point of history) {
    const at = Date.parse(point.capturedAt);
    const distance = Math.abs(at - windowStart);
    if (distance > skew) continue;
    if (at <= windowStart) {
      if (isBetterBaseline(point, before, distance, beforeDistance, period)) {
        before = point;
        beforeDistance = distance;
      }
    } else if (isBetterBaseline(point, after, distance, afterDistance, period)) {
      after = point;
      afterDistance = distance;
    }
  }

  return before ?? after;
}

function isBetterBaseline(
  next: MarketPoint,
  current: MarketPoint | null,
  nextDistance: number,
  currentDistance: number,
  period: BriefPeriod,
): boolean {
  if (!current || nextDistance < currentDistance) return true;
  if (nextDistance > currentDistance) return false;
  return completeness(next, period) >= completeness(current, period);
}

function completeness(point: MarketPoint, period: BriefPeriod): number {
  return (
    (point.priceUsd != null ? 1 : 0) +
    (point.liquidityUsd != null ? 1 : 0) +
    (point.volumeUsd[period] != null ? 1 : 0)
  );
}

function pairChangePct(previous: number | null, current: number | null): number | null {
  if (previous == null || current == null || previous <= 0) return null;
  return Math.round((((current - previous) / previous) * 100) * 10_000) / 10_000;
}

function metric(
  previousUsd: number | null,
  currentUsd: number | null,
  changePct: number | null,
  significant: boolean,
): MetricDelta {
  return { previousUsd, currentUsd, changePct, significant };
}

function priceIsSignificant(
  previous: number | null,
  current: number | null,
  changePct: number | null,
  period: BriefPeriod,
): boolean {
  if (previous == null || current == null || previous === current) return false;
  if (changePct == null) return current > 0;
  return Math.abs(changePct) >= PRICE_CHANGE_THRESHOLD_PCT[period];
}

function liquidityIsSignificant(
  previous: number | null,
  current: number | null,
  changePct: number | null,
  period: BriefPeriod,
): boolean {
  if (previous == null || current == null || previous === current) return false;
  if (changePct == null) return current >= LIQUIDITY_MATERIAL_USD;
  const abs = Math.abs(changePct);
  if (abs >= LIQUIDITY_EXTREME_PCT) return true;
  return (
    abs >= LIQUIDITY_CHANGE_THRESHOLD_PCT[period] &&
    Math.max(previous, current) >= LIQUIDITY_MATERIAL_USD
  );
}

function turnover(volume: number | null, liquidity: number | null): number | null {
  if (volume == null || liquidity == null || liquidity <= 0) return null;
  return Math.round((volume / liquidity) * 10_000) / 10_000;
}

function volumeLevelIsSignificant(
  current: number | null,
  turns: number | null,
  period: BriefPeriod,
): boolean {
  if (current == null) return false;
  if (current >= VOLUME_ABSOLUTE_USD) return true;
  return (
    current >= VOLUME_NOTABLE_USD &&
    turns != null &&
    turns >= VOLUME_TURNOVER_THRESHOLD[period]
  );
}

function volumeChangeIsSignificant(
  previous: number | null,
  current: number | null,
  changePct: number | null,
  period: BriefPeriod,
): boolean {
  if (previous == null || current == null || previous === current) return false;
  if (changePct == null) return current >= VOLUME_NOTABLE_USD;
  return (
    Math.abs(changePct) >= VOLUME_CHANGE_THRESHOLD_PCT[period] &&
    Math.max(previous, current) >= VOLUME_NOTABLE_USD
  );
}

function readActivity<K extends ActivityKind>(
  events: readonly TimelineEvent[] | undefined,
  kind: K,
  ca: string,
): Array<Extract<TimelineEvent, { kind: K }>> {
  const parsedEvents: Array<Extract<TimelineEvent, { kind: K }>> = [];
  for (const event of events ?? []) {
    const parsed = parseTimelineEvent(event);
    if (parsed.kind !== kind) {
      throw new DeltaEngineError(`Expected a ${kind} event.`);
    }
    if (parsed.ca !== ca) {
      throw new DeltaEngineError("Event address does not match the token.");
    }
    parsedEvents.push(parsed as Extract<TimelineEvent, { kind: K }>);
  }
  return parsedEvents;
}

function latestBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  timeOf: (item: T) => number,
): T[] {
  const chosen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = chosen.get(key);
    if (!existing || timeOf(item) >= timeOf(existing)) chosen.set(key, item);
  }
  return [...chosen.values()];
}

function inWindow(occurredAt: string, windowStart: number, windowEnd: number): boolean {
  const at = Date.parse(occurredAt);
  return at > windowStart && at <= windowEnd;
}

function scoreMarket(input: {
  kind: "price" | "liquidity" | "volume";
  ca: string;
  period: BriefPeriod;
  occurredAt: string;
  occurredMs: number;
  windowStart: number;
  windowEnd: number;
  title: string;
  evidence: EvidenceLink[];
  previousUsd: number | null;
  currentUsd: number;
  changePct: number | null;
  bonus: number;
}): ScoredEvent {
  if (input.evidence.length === 0) {
    throw new DeltaEngineError("Market changes need at least one evidence link.");
  }
  const event = parseTimelineEvent({
    id: `${input.kind}:${input.ca}:${input.period}`,
    ca: input.ca,
    kind: input.kind,
    occurredAt: input.occurredAt,
    title: input.title,
    evidence: input.evidence,
    previousUsd: input.previousUsd,
    currentUsd: input.currentUsd,
    changePct: input.changePct,
    ...(input.kind === "volume" ? { window: input.period } : {}),
  });
  return {
    event,
    score:
      KIND_BASE[input.kind] +
      input.bonus +
      recencyBonus(input.occurredMs, input.windowStart, input.windowEnd),
  };
}

function moveBonus(
  changePct: number | null,
  threshold: number,
  kind: "price" | "liquidity",
): number {
  const magnitude = changePct == null ? FROM_ZERO_BONUS : magnitudeBonus(changePct, threshold);
  const drop = kind === "liquidity" && changePct != null && changePct < 0 ? LIQUIDITY_DROP_BONUS : 0;
  const cap = kind === "liquidity" ? LIQUIDITY_BONUS_CAP : MAGNITUDE_CAP;
  return Math.min(cap, magnitude + drop);
}

function volumeBonus(period: BriefPeriod, volume: VolumeDelta): number {
  let bonus = 0;
  if (volume.changeSignificant) {
    bonus +=
      volume.changePct == null
        ? FROM_ZERO_BONUS
        : magnitudeBonus(volume.changePct, VOLUME_CHANGE_THRESHOLD_PCT[period]);
  }
  if (volume.levelSignificant) {
    if (volume.turnover != null) {
      const threshold = VOLUME_TURNOVER_THRESHOLD[period];
      const extra = volume.turnover / threshold - 1;
      if (extra > 0) bonus += Math.min(24, Math.round(extra * 10));
      if (volume.turnover >= threshold) bonus += TURNOVER_LEVEL_BONUS;
    }
    if (volume.currentUsd != null && volume.currentUsd >= VOLUME_ABSOLUTE_USD) {
      bonus += ABSOLUTE_VOLUME_BONUS;
    }
  }
  return Math.min(MAGNITUDE_CAP, bonus);
}

function magnitudeBonus(changePct: number, threshold: number): number {
  const extra = Math.abs(changePct) / threshold - 1;
  if (extra <= 0) return 0;
  return Math.min(MAGNITUDE_CAP, Math.round(extra * 15));
}

function postScore(
  event: Extract<TimelineEvent, { kind: "x_post" }>,
  windowStart: number,
  windowEnd: number,
): number {
  let score =
    KIND_BASE.x_post + recencyBonus(Date.parse(event.occurredAt), windowStart, windowEnd);
  if (event.about === "contract") score += 36;
  else if (event.about === "ticker") score += 18;
  if (event.followers != null && event.followers > 0) {
    score += Math.min(20, Math.round(Math.log10(event.followers) * 5));
  }
  score += sourceStrength(event) * 6;
  return score;
}

function recencyBonus(occurredAt: number, windowStart: number, windowEnd: number): number {
  const span = windowEnd - windowStart;
  if (span <= 0) return 0;
  const age = Math.min(span, Math.max(0, windowEnd - occurredAt));
  return Math.round((1 - age / span) * 10);
}

function moveTitle(
  label: "Price" | "Market cap" | "Liquidity",
  previous: number,
  current: number,
  changePct: number | null,
  period: BriefPeriod,
): string {
  if (changePct == null && previous === 0) {
    return `${label} rose to ${formatUsd(current)} over ${period}`;
  }
  const direction = changePct != null && changePct > 0 ? "up" : "down";
  return `${label} ${direction} ${formatPct(changePct ?? 0)} over ${period}`;
}

function volumeTitle(period: BriefPeriod, volume: VolumeDelta): string {
  if (volume.changeSignificant && volume.changePct != null) {
    const direction = volume.changePct > 0 ? "up" : "down";
    return `${period} volume ${direction} ${formatPct(volume.changePct)} versus the prior ${period}`;
  }
  if (volume.changeSignificant && volume.previousUsd === 0 && volume.currentUsd != null) {
    return `${period} volume rose to ${formatUsd(volume.currentUsd)} from no prior volume`;
  }
  if (volume.currentUsd != null && volume.turnover != null && volume.turnover > 0) {
    return `${period} volume ${formatUsd(volume.currentUsd)} (${formatMultiple(volume.turnover)} liquidity)`;
  }
  return `${period} volume ${formatUsd(volume.currentUsd ?? 0)}`;
}

function assertUniqueEventIds(events: readonly TimelineEvent[]): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) {
      throw new DeltaEngineError(`Duplicate event id ${event.id}.`);
    }
    seen.add(event.id);
  }
}

const SUMMARY_KINDS = new Set<TimelineEvent["kind"]>([
  "price",
  "liquidity",
  "website",
  "x_post",
  "listing",
]);

/** One point per summary topic. Extra posts and website edits stay on the timeline. */
function selectSummary(timeline: readonly RankedEvent[]): RankedEvent[] {
  const selected: RankedEvent[] = [];
  const seenKinds = new Set<TimelineEvent["kind"]>();
  for (const item of timeline) {
    if (!SUMMARY_KINDS.has(item.event.kind) || seenKinds.has(item.event.kind)) continue;
    selected.push(item);
    seenKinds.add(item.event.kind);
    if (selected.length === SUMMARY_CANDIDATE_LIMIT) break;
  }
  return selected.sort(byImportance);
}

function byImportance(
  a: { event: TimelineEvent; score: number },
  b: { event: TimelineEvent; score: number },
): number {
  if (a.score !== b.score) return b.score - a.score;
  const time = Date.parse(b.event.occurredAt) - Date.parse(a.event.occurredAt);
  if (time !== 0) return time;
  if (a.event.kind !== b.event.kind) return KIND_RANK[a.event.kind] - KIND_RANK[b.event.kind];
  if (a.event.id === b.event.id) return 0;
  return a.event.id < b.event.id ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
