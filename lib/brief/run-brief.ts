import { randomUUID } from "node:crypto";

import type { KvStore } from "@/lib/cache/store";
import {
  MARKET_CACHE_TTL_SECONDS,
  marketCacheKey,
  readThroughMarketCache,
} from "@/lib/cache/market-cache";
import {
  BRIEF_RATE_LIMIT,
  consumeRateLimit,
  type RateLimitDecision,
  type RateLimitPolicy,
} from "@/lib/limit/rate-limit";
import {
  errorFields,
  log as defaultLog,
  type Logger,
} from "@/lib/observability/log";
import { clientKeyDigest } from "@/lib/observability/request";
import {
  BriefGeneratorError,
  DeltaEngineError,
  BASELINE_SKEW_MS,
  analyzeChanges,
  generateBriefSummary,
  type DeltaReport,
} from "@/lib/analysis";
import {
  BRIEF_SCHEMA_VERSION,
  parseBrief,
  type Brief,
  type BriefPeriod,
  type EvidenceLink,
  type SummaryPoint,
  type TimelineEvent,
  type TokenSnapshot,
} from "@/lib/dto";
import { formatPct, formatUsd } from "@/lib/format/amounts";
import {
  MarketUnavailableError,
  ProviderError,
  type MarketSnapshotResult,
} from "@/lib/providers";

import {
  readLinkedActivity,
  type LinkedActivity,
  type WebsiteBaselineNote,
} from "./activity";

export const BRIEF_MESSAGES = {
  notFound:
    "No market data was found for this contract address. Check the address and try again.",
  unavailable: "Market data is temporarily unavailable. Try again in a moment.",
  rateLimited:
    "Too many briefs were requested from this network. Wait a minute and try again.",
  invalid:
    "Enter a Solana contract address and a window of 1h, 6h, 12h, or 24h.",
} as const;

const SUMMARY_POINT_MIN = 3;
const SUMMARY_POINT_MAX = 5;

export type BriefRuntime = {
  requestId: string;
  clientKey: string;
  store: KvStore;
  readMarket: (ca: string) => Promise<MarketSnapshotResult>;
  createShareId?: () => string;
  rateLimit?: RateLimitPolicy;
  now?: () => number;
  log?: Logger;
  /**
   * Replaces the live website and X reads. Tests and the e2e fixture
   * server pass an empty reader so they do not call those sites.
   */
  readActivity?: (
    snapshot: TokenSnapshot,
    period: BriefPeriod,
    windowEnd: Date,
  ) => Promise<LinkedActivity>;
};

export type BriefLoadFailure = {
  ok: false;
  code: "not_found" | "unavailable" | "rate_limited";
  message: string;
  rateLimit: RateLimitDecision;
};

export type BriefLoadResult =
  | {
      ok: true;
      brief: Brief;
      cache: "hit" | "miss";
      rateLimit: RateLimitDecision;
    }
  | BriefLoadFailure;

export type BriefRunOptions = {
  /**
   * Read the market, site, and X account again instead of the short caches.
   * Publishing a public link uses this so the saved version is the moment
   * of the click, not the lookup that opened the page.
   */
  fresh?: boolean;
};

/**
 * Loads one live brief: rate limit, cached market snapshot, then summary.
 * A price or liquidity reading with no earlier baseline is left out of the
 * summary. The first stored copy of a website is a summary note, not a change.
 * Later website edits stay on the summary and the timeline. Linked-account
 * posts are summary points only. The timeline keeps posts from other accounts
 * that name this mint or ticker, plus paid DexScreener orders.
 */
export async function runBrief(
  ca: string,
  period: BriefPeriod,
  runtime: BriefRuntime,
  options: BriefRunOptions = {},
): Promise<BriefLoadResult> {
  const logger = runtime.log ?? defaultLog;
  const started = Date.now();
  const context = {
    requestId: runtime.requestId,
    client: clientKeyDigest(runtime.clientKey),
    ca,
    period,
  };
  const policy = runtime.rateLimit ?? BRIEF_RATE_LIMIT;
  let rateLimit: RateLimitDecision;
  try {
    rateLimit = await consumeRateLimit(
      runtime.store,
      "brief",
      runtime.clientKey,
      policy,
      runtime.now,
    );
  } catch (error) {
    logger.error("brief.rate_limit_failed", { ...context, ...errorFields(error) });
    rateLimit = {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      retryAfterSeconds: 0,
    };
  }

  if (!rateLimit.allowed) {
    logger.warn("brief.rate_limited", {
      ...context,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      durationMs: Date.now() - started,
    });
    return {
      ok: false,
      code: "rate_limited",
      message: BRIEF_MESSAGES.rateLimited,
      rateLimit,
    };
  }

  try {
    const market = options.fresh
      ? await readFreshMarket(runtime, ca, logger)
      : await readThroughMarketCache(
          runtime.store,
          ca,
          runtime.readMarket,
          logger,
        );
    const windowEnd = reportWindowEnd(
      market.result.snapshot.capturedAt,
      period,
      runtime.now?.() ?? Date.now(),
    );
    const activity = runtime.readActivity
      ? await runtime.readActivity(market.result.snapshot, period, windowEnd)
      : await readLinkedActivity({
          snapshot: market.result.snapshot,
          period,
          windowEnd,
          store: runtime.store,
          logger,
          fresh: options.fresh,
        });
    const brief = assemble(
      market.result.snapshot,
      market.result.evidence,
      activity.posts,
      activity.websiteChanges,
      activity.listings,
      activity.websiteBaseline ?? null,
      period,
      windowEnd,
      runtime.createShareId ?? randomUUID,
    );
    logger.info("brief.ready", {
      ...context,
      cache: market.cache,
      summaryPoints: brief.summary.length,
      events: brief.events.length,
      durationMs: Date.now() - started,
    });
    return { ok: true, brief, cache: market.cache, rateLimit };
  } catch (error) {
    if (error instanceof MarketUnavailableError) {
      const failure = marketFailure(error, rateLimit);
      logger.warn("brief.unavailable", {
        ...context,
        code: failure.code,
        durationMs: Date.now() - started,
      });
      return failure;
    }
    if (
      error instanceof ProviderError ||
      error instanceof BriefGeneratorError ||
      error instanceof DeltaEngineError
    ) {
      logger.warn("brief.unavailable", {
        ...context,
        code: "unavailable",
        ...errorFields(error),
        durationMs: Date.now() - started,
      });
      return {
        ok: false,
        code: "unavailable",
        message: BRIEF_MESSAGES.unavailable,
        rateLimit,
      };
    }
    logger.error("brief.failed", {
      ...context,
      ...errorFields(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

async function readFreshMarket(
  runtime: BriefRuntime,
  ca: string,
  logger: Logger,
): Promise<{ result: MarketSnapshotResult; cache: "miss" }> {
  const result = await runtime.readMarket(ca);
  try {
    await runtime.store.set(
      marketCacheKey(ca),
      JSON.stringify(result),
      MARKET_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("market.cache_write_failed", {
      ca,
      message: error instanceof Error ? error.message : "Cache write failed.",
    });
  }
  return { result, cache: "miss" };
}

function assemble(
  snapshot: TokenSnapshot,
  evidence: EvidenceLink[],
  posts: TimelineEvent[],
  websiteChanges: TimelineEvent[],
  listings: TimelineEvent[],
  websiteBaseline: WebsiteBaselineNote | null,
  period: BriefPeriod,
  windowEnd: Date,
  createShareId: () => string,
): Brief {
  try {
    return publish(
      snapshot,
      evidence,
      posts,
      websiteChanges,
      listings,
      websiteBaseline,
      period,
      windowEnd,
      createShareId,
    );
  } catch (error) {
    if (posts.length === 0 && websiteChanges.length === 0 && listings.length === 0) {
      throw error;
    }
    if (
      error instanceof BriefGeneratorError ||
      error instanceof DeltaEngineError
    ) {
      return publish(
        snapshot,
        evidence,
        [],
        [],
        [],
        websiteBaseline,
        period,
        windowEnd,
        createShareId,
      );
    }
    throw error;
  }
}

function publish(
  snapshot: TokenSnapshot,
  evidence: EvidenceLink[],
  posts: TimelineEvent[],
  websiteChanges: TimelineEvent[],
  listings: TimelineEvent[],
  websiteBaseline: WebsiteBaselineNote | null,
  period: BriefPeriod,
  windowEnd: Date,
  createShareId: () => string,
): Brief {
  const report = analyzeChanges({
    ca: snapshot.ca,
    period,
    now: windowEnd,
    current: snapshot,
    evidence,
    posts,
    websiteChanges,
    listings,
  });
  const confirmed = confirmedReport(report, snapshot);
  const summary = generateBriefSummary({
    report: confirmed,
    snapshot,
    evidence,
  });
  const linkedSummary = focusLinkedPosts(summary, confirmed.timeline, snapshot, period);
  const withWebsite = addWebsiteBaseline(linkedSummary, confirmed.timeline, snapshot, websiteBaseline);
  const completeSummary = ensureSummaryPointCount(
    withWebsite,
    confirmed.timeline,
    period,
    snapshot,
  );
  return parseBrief({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    shareId: createShareId(),
    ca: snapshot.ca,
    period,
    generatedAt: snapshot.capturedAt,
    snapshot,
    summary: completeSummary,
    events: confirmed.timeline.map((item) => item.event),
  });
}

function focusLinkedPosts(
  summary: SummaryPoint[],
  timeline: readonly { event: TimelineEvent }[],
  snapshot: TokenSnapshot,
  period: BriefPeriod,
): SummaryPoint[] {
  const events = new Map(timeline.map((item) => [item.event.id, item.event]));
  const kept = summary.filter((point) => {
    if (!point.eventId) return true;
    const event = events.get(point.eventId);
    if (!event || event.kind !== "x_post") return true;
    return isLinkedPost(event, snapshot);
  });
  const handle = linkedHandle(snapshot);
  if (!handle) return kept.slice(0, SUMMARY_POINT_MAX);

  const next = kept.slice();
  const seenEventIds = new Set(
    next.map((point) => point.eventId).filter((id): id is string => id != null),
  );
  const linked = timeline
    .map((item) => item.event)
    .filter(
      (event): event is Extract<TimelineEvent, { kind: "x_post" }> =>
        event.kind === "x_post" && event.account.toLowerCase() === handle,
    )
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));

  for (const event of linked) {
    if (seenEventIds.has(event.id)) continue;
    while (next.length >= SUMMARY_POINT_MAX && dropLowerPriority(next, events)) {
      // Room for this linked-account post.
    }
    if (next.length >= SUMMARY_POINT_MAX) break;
    const point = pointFromEvent(event, period, new Set(next.map((item) => item.id)));
    if (!point) continue;
    next.push(point);
    seenEventIds.add(event.id);
  }
  return next.slice(0, SUMMARY_POINT_MAX);
}

function addWebsiteBaseline(
  summary: SummaryPoint[],
  timeline: readonly { event: TimelineEvent }[],
  snapshot: TokenSnapshot,
  note: WebsiteBaselineNote | null,
): SummaryPoint[] {
  if (!note) return summary;
  const events = new Map(timeline.map((item) => [item.event.id, item.event]));
  const alreadyCited = summary.some((point) => {
    if (!point.eventId) return false;
    return events.get(point.eventId)?.kind === "website";
  });
  if (alreadyCited) return summary;

  const point = websiteBaselinePoint(snapshot, note);
  const next = summary.slice();
  while (next.length >= SUMMARY_POINT_MAX && dropLowerPriority(next, events)) {
    // Room for the first-copy note.
  }
  if (next.length >= SUMMARY_POINT_MAX) return next;
  next.push(point);
  return next;
}

function websiteBaselinePoint(
  snapshot: TokenSnapshot,
  note: WebsiteBaselineNote,
): SummaryPoint {
  const occurredAt = snapshot.capturedAt;
  return {
    id: "summary:website:baseline",
    text: `No earlier copy of ${note.url} was stored at ${occurredAt}. This read is the baseline.`,
    occurredAt,
    eventId: null,
    evidence: [
      {
        id: `website:baseline:${snapshot.ca}`,
        source: "website",
        url: note.url,
        label: "Website",
      },
    ],
  };
}

function dropLowerPriority(
  points: SummaryPoint[],
  events: ReadonlyMap<string, TimelineEvent>,
): boolean {
  const index = points.findIndex((point) => {
    if (point.eventId == null) return true;
    const kind = events.get(point.eventId)?.kind;
    return kind === "volume" || kind === "listing";
  });
  if (index < 0) return false;
  points.splice(index, 1);
  return true;
}

function linkedHandle(snapshot: TokenSnapshot): string {
  return snapshot.socials.xHandle?.trim().toLowerCase() ?? "";
}

function isLinkedPost(event: TimelineEvent, snapshot: TokenSnapshot): boolean {
  const handle = linkedHandle(snapshot);
  return event.kind === "x_post" && handle !== "" && event.account.toLowerCase() === handle;
}

function ensureSummaryPointCount(
  summary: SummaryPoint[],
  timeline: readonly { event: TimelineEvent }[],
  period: BriefPeriod,
  snapshot: TokenSnapshot,
): SummaryPoint[] {
  if (summary.length >= SUMMARY_POINT_MIN) {
    return summary.slice(0, SUMMARY_POINT_MAX);
  }

  const next = summary.slice(0, SUMMARY_POINT_MAX);
  const seenPointIds = new Set(next.map((point) => point.id));
  const seenEventIds = new Set(next.map((point) => point.eventId).filter((id): id is string => id != null));

  for (const item of timeline) {
    if (next.length >= SUMMARY_POINT_MIN || next.length >= SUMMARY_POINT_MAX) break;
    const event = item.event;
    if (seenEventIds.has(event.id)) continue;
    if (event.kind === "x_post" && !isLinkedPost(event, snapshot)) continue;
    const point = pointFromEvent(event, period, seenPointIds);
    if (!point) continue;
    next.push(point);
    seenEventIds.add(event.id);
    seenPointIds.add(point.id);
  }

  return next;
}

function pointFromEvent(
  event: TimelineEvent,
  period: BriefPeriod,
  seenPointIds: Set<string>,
): SummaryPoint | null {
  const id = `summary:mvp:event:${event.id}`;
  if (seenPointIds.has(id)) return null;
  return {
    id,
    text: eventLine(event, period),
    occurredAt: event.occurredAt,
    eventId: event.id,
    evidence: copyEvidence(event.evidence),
  };
}

function eventLine(event: TimelineEvent, period: BriefPeriod): string {
  if (event.kind === "price") {
    return moveLine(
      "Price",
      event.previousUsd,
      event.currentUsd,
      event.changePct,
      period,
      event.occurredAt,
    );
  }
  if (event.kind === "liquidity") {
    return moveLine(
      "Liquidity",
      event.previousUsd,
      event.currentUsd,
      event.changePct,
      period,
      event.occurredAt,
    );
  }
  if (event.kind === "volume") {
    return moveLine(
      `${event.window} volume`,
      event.previousUsd,
      event.currentUsd,
      event.changePct,
      event.window,
      event.occurredAt,
    );
  }
  if (event.kind === "website") {
    return `Website update at ${event.occurredAt}: ${event.diffSummary}`;
  }
  if (event.kind === "listing") {
    return `Paid DexScreener ${event.placement} listing detected at ${event.occurredAt}.`;
  }
  return `@${event.account} posted at ${event.occurredAt}: "${event.textExcerpt}".`;
}

function moveLine(
  label: string,
  previousUsd: number | null,
  currentUsd: number | null,
  changePct: number | null,
  period: BriefPeriod,
  occurredAt: string,
): string {
  if (previousUsd == null) {
    return `${label} was ${formatUsd(currentUsd)} at ${occurredAt}.`;
  }
  if (changePct == null) {
    return `${label} moved from ${formatUsd(previousUsd)} to ${formatUsd(currentUsd)} over ${period}. Observed at ${occurredAt}.`;
  }
  if (changePct === 0) {
    return `${label} was unchanged over ${period} at ${formatUsd(currentUsd)}. Observed at ${occurredAt}.`;
  }
  const direction = changePct > 0 ? "up" : "down";
  return `${label} moved ${direction} ${formatPct(changePct)} over ${period}, from ${formatUsd(previousUsd)} to ${formatUsd(currentUsd)}. Observed at ${occurredAt}.`;
}

function copyEvidence(links: readonly EvidenceLink[]): EvidenceLink[] {
  return links.map((link) => ({
    id: link.id,
    source: link.source,
    url: link.url,
    label: link.label,
  }));
}

function confirmedReport(report: DeltaReport, snapshot: TokenSnapshot): DeltaReport {
  const timeline = report.timeline
    .filter((item) => isConfirmedEvent(item.event, snapshot))
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const rankById = new Map(timeline.map((item) => [item.event.id, item.rank]));
  const summaryCandidates = report.summaryCandidates
    .filter((item) => rankById.has(item.event.id))
    .map((item) => ({ ...item, rank: rankById.get(item.event.id) ?? item.rank }))
    .sort((left, right) => left.rank - right.rank);
  return { ...report, timeline, summaryCandidates };
}

function isConfirmedEvent(event: TimelineEvent, snapshot: TokenSnapshot): boolean {
  if (event.evidence.length === 0) return false;
  if (event.kind === "x_post") {
    return (
      isHost(event.postUrl, ["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]) &&
      hasEvidence(event.evidence, "x", (url) =>
        isHost(url, ["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]),
      )
    );
  }
  if (event.kind === "website") {
    const tokenHost = host(snapshot.website);
    const eventHost = host(event.url);
    return (
      tokenHost != null &&
      eventHost === tokenHost &&
      hasEvidence(event.evidence, "website", (url) => host(url) === tokenHost)
    );
  }
  if (event.kind === "listing") {
    return hasEvidence(event.evidence, "dexscreener", (url) =>
      isHost(url, ["dexscreener.com", "www.dexscreener.com"]),
    );
  }
  if (event.kind === "price" || event.kind === "liquidity" || event.kind === "volume") {
    return event.evidence.some((link) => {
      if (link.source === "birdeye") return isHost(link.url, ["birdeye.so", "www.birdeye.so"]);
      if (link.source === "dexscreener") {
        return isHost(link.url, ["dexscreener.com", "www.dexscreener.com"]);
      }
      if (link.source === "jupiter") return isHost(link.url, ["jup.ag", "www.jup.ag"]);
      return false;
    });
  }
  return false;
}

function hasEvidence(
  evidence: readonly EvidenceLink[],
  source: EvidenceLink["source"],
  match: (url: string) => boolean,
): boolean {
  return evidence.some((link) => link.source === source && match(link.url));
}

function isHost(url: string, allowed: readonly string[]): boolean {
  const value = host(url);
  return value != null && allowed.includes(value);
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function reportWindowEnd(capturedAt: string, period: BriefPeriod, nowMs: number): Date {
  const captured = Date.parse(capturedAt);
  if (Number.isNaN(captured)) return new Date(nowMs);
  const latest = captured + BASELINE_SKEW_MS[period];
  return new Date(Math.min(Math.max(nowMs, captured), latest));
}

function marketFailure(
  error: MarketUnavailableError,
  rateLimit: RateLimitDecision,
): BriefLoadFailure {
  const missed =
    error.causes.length > 0 &&
    error.causes.every((cause) => cause.code === "not_found");
  if (missed) {
    return {
      ok: false,
      code: "not_found",
      message: BRIEF_MESSAGES.notFound,
      rateLimit,
    };
  }
  return {
    ok: false,
    code: "unavailable",
    message: BRIEF_MESSAGES.unavailable,
    rateLimit,
  };
}
