import { z } from "zod";

import {
  BRIEF_SCHEMA_VERSION,
  SUMMARY_POINT_LIMITS,
  parseBrief,
  summaryPointSchema,
  type SummaryPoint,
} from "../dto/brief";
import {
  briefPeriodSchema,
  evidenceLinkSchema,
  isoDateTimeSchema,
  marketEvidenceSources,
  nullableChangePctSchema,
  nullableUsdSchema,
  solanaAddressSchema,
  type EvidenceLink,
  type EvidenceSource,
} from "../dto/common";
import { timelineEventSchema, type TimelineEvent } from "../dto/event";
import { parseTokenSnapshot, type TokenSnapshot } from "../dto/token-snapshot";
import { formatPct, formatUsd } from "../format/amounts";
import {
  BASELINE_SKEW_MS,
  PERIOD_MS,
  type DeltaReport,
  type MetricDelta,
  type RankedEvent,
  type VolumeDelta,
} from "./delta-engine";
import { marketCapReading } from "./market-cap";

/**
 * Renders 3-5 English summary points from a delta report.
 * Each sentence repeats the observation time.
 * `eventId` and `evidence` point at the timeline event those words came from.
 * Points cover significant market-cap and liquidity changes, one website update,
 * posts that name this token, and one paid listing. A price line is stated as the
 * market-cap move. A reading with no earlier baseline is omitted. Comparable
 * liquidity and volume readings fill only what is still short of three points.
 */

const MARKET_KINDS = ["price", "liquidity", "volume"] as const;
const PUBLISH_SHARE_ID = "11111111-1111-4111-8111-111111111111";
/** Pad a thin summary toward three points. One real point is enough to publish. */
const SUMMARY_PAD_TARGET = 3;

const metricSchema = z.object({
  previousUsd: nullableUsdSchema,
  currentUsd: nullableUsdSchema,
  changePct: nullableChangePctSchema,
  significant: z.boolean(),
});

const volumeMetricSchema = metricSchema.extend({
  turnover: z.number().finite().nullable(),
  levelSignificant: z.boolean(),
  changeSignificant: z.boolean(),
});

const rankedEventSchema = z.object({
  event: timelineEventSchema,
  score: z.number().finite(),
  rank: z.number().int().positive(),
});

const reportSchema = z.object({
  ca: solanaAddressSchema,
  period: briefPeriodSchema,
  windowStart: isoDateTimeSchema,
  windowEnd: isoDateTimeSchema,
  baselineCapturedAt: isoDateTimeSchema.nullable(),
  price: metricSchema,
  liquidity: metricSchema,
  volume: volumeMetricSchema,
  timeline: z.array(rankedEventSchema),
  summaryCandidates: z.array(rankedEventSchema),
});

type MarketKind = (typeof MARKET_KINDS)[number];
type Report = z.infer<typeof reportSchema>;

export class BriefGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type BriefGeneratorInput = {
  report: DeltaReport;
  snapshot: TokenSnapshot;
  /**
   * Provenance for level readings.
   * Required when the report has fewer than three summary candidates.
   */
  evidence?: readonly EvidenceLink[];
};

export function generateBriefSummary(input: BriefGeneratorInput): SummaryPoint[] {
  const snapshot = parseTokenSnapshot(input.snapshot);
  const report = readReport(input.report, snapshot);
  const seenIds = new Set<string>();
  const covered = new Set<MarketKind>();
  const points: SummaryPoint[] = [];

  for (const candidate of report.summaryCandidates) {
    const kind = marketKind(candidate.event);
    if (kind) covered.add(kind);
    points.push(eventPoint(candidate.event, report, snapshot, seenIds));
  }

  for (const ranked of report.timeline) {
    if (points.length >= SUMMARY_POINT_LIMITS.max) break;
    if (ranked.event.kind !== "x_post") continue;
    if (points.some((item) => item.eventId === ranked.event.id)) continue;
    points.push(eventPoint(ranked.event, report, snapshot, seenIds));
  }

  if (points.length < SUMMARY_PAD_TARGET) {
    for (const kind of MARKET_KINDS) {
      if (points.length >= SUMMARY_PAD_TARGET) break;
      if (covered.has(kind)) continue;
      if (!canStateLevel(kind, report, snapshot)) continue;
      const text = levelSentence(kind, report, snapshot);
      if (!text) continue;
      const evidence = readMarketEvidence(input.evidence);
      points.push(levelPoint(kind, snapshot, evidence, text, seenIds));
    }
  }

  if (points.length < SUMMARY_POINT_LIMITS.min || points.length > SUMMARY_POINT_LIMITS.max) {
    throw new BriefGeneratorError(
      `Summary must contain ${SUMMARY_POINT_LIMITS.min} to ${SUMMARY_POINT_LIMITS.max} points.`,
    );
  }

  assertPublishable(snapshot, report, points);
  return points;
}

function readReport(value: DeltaReport, snapshot: TokenSnapshot): Report {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) {
    throw new BriefGeneratorError(
      parsed.error.issues[0]?.message ?? "Report does not match the delta contract.",
    );
  }
  const report = parsed.data;
  if (report.ca !== snapshot.ca) {
    throw new BriefGeneratorError("Report is for a different token.");
  }
  if (report.price.currentUsd !== snapshot.priceUsd) {
    throw new BriefGeneratorError("Report price does not match the snapshot.");
  }
  if (report.liquidity.currentUsd !== snapshot.liquidityUsd) {
    throw new BriefGeneratorError("Report liquidity does not match the snapshot.");
  }
  if (report.volume.currentUsd !== snapshot.volumeUsd[report.period]) {
    throw new BriefGeneratorError("Report volume does not match the snapshot.");
  }

  const windowStart = Date.parse(report.windowStart);
  const windowEnd = Date.parse(report.windowEnd);
  if (windowEnd - windowStart !== PERIOD_MS[report.period]) {
    throw new BriefGeneratorError("Report window does not match the period.");
  }
  const capturedAt = Date.parse(snapshot.capturedAt);
  const skew = BASELINE_SKEW_MS[report.period];
  if (capturedAt > windowEnd || capturedAt < windowEnd - skew) {
    throw new BriefGeneratorError("Snapshot time is outside the report window.");
  }
  if (report.baselineCapturedAt != null) {
    const baseline = Date.parse(report.baselineCapturedAt);
    if (Math.abs(baseline - windowStart) > skew) {
      throw new BriefGeneratorError("Baseline time is outside the allowed skew.");
    }
  }

  const timelineById = new Map<string, RankedEvent>();
  const seenMarketKinds = new Set<MarketKind>();
  report.timeline.forEach((item, index) => {
    if (item.rank !== index + 1) {
      throw new BriefGeneratorError("Timeline ranks must be contiguous.");
    }
    if (timelineById.has(item.event.id)) {
      throw new BriefGeneratorError(`Duplicate event id ${item.event.id}.`);
    }
    if (item.event.ca !== report.ca) {
      throw new BriefGeneratorError("Event address does not match the token.");
    }
    const kind = marketKind(item.event);
    if (kind) {
      if (seenMarketKinds.has(kind)) {
        throw new BriefGeneratorError(`Duplicate ${kind} event.`);
      }
      seenMarketKinds.add(kind);
      if (item.event.occurredAt !== snapshot.capturedAt) {
        throw new BriefGeneratorError("Market event time does not match the snapshot.");
      }
      if (!report[kind].significant) {
        throw new BriefGeneratorError(
          `${kind} is on the timeline without a significant change.`,
        );
      }
      assertMetricMatch(item.event, report);
    }
    timelineById.set(item.event.id, item);
  });

  if (report.summaryCandidates.length > SUMMARY_POINT_LIMITS.max) {
    throw new BriefGeneratorError(
      `Summary can cite at most ${SUMMARY_POINT_LIMITS.max} events.`,
    );
  }

  const candidateIds = new Set<string>();
  const covered = new Set<MarketKind>();
  for (const candidate of report.summaryCandidates) {
    const ranked = timelineById.get(candidate.event.id);
    if (!ranked) {
      throw new BriefGeneratorError(
        `Summary candidate ${candidate.event.id} is not in the timeline.`,
      );
    }
    if (candidateIds.has(candidate.event.id)) {
      throw new BriefGeneratorError(`Duplicate summary candidate ${candidate.event.id}.`);
    }
    candidateIds.add(candidate.event.id);
    if (candidate.rank !== ranked.rank || !sameEvent(candidate.event, ranked.event)) {
      throw new BriefGeneratorError(
        `Summary candidate ${candidate.event.id} does not match the timeline event.`,
      );
    }
    const kind = marketKind(candidate.event);
    if (kind) covered.add(kind);
  }

  for (const kind of ["price", "liquidity"] as const) {
    if (report[kind].significant && !covered.has(kind)) {
      throw new BriefGeneratorError(
        `${kind} changed enough to need its own summary point.`,
      );
    }
    const onTimeline = report.timeline.some((item) => item.event.kind === kind);
    if (onTimeline && !covered.has(kind)) {
      throw new BriefGeneratorError(
        `${kind} changed enough to need its own summary point.`,
      );
    }
  }

  return report;
}

function canStateLevel(kind: MarketKind, report: Report, snapshot: TokenSnapshot): boolean {
  if (kind === "price") {
    return (
      marketCapReading(
        snapshot.marketCapUsd,
        report.price.previousUsd,
        report.price.currentUsd,
      ) != null
    );
  }
  const metric = report[kind];
  return metric.previousUsd != null && metric.currentUsd != null;
}

function eventPoint(
  event: TimelineEvent,
  report: Report,
  snapshot: TokenSnapshot,
  seenIds: Set<string>,
): SummaryPoint {
  return point(
    {
      id: summaryId(`event:${event.id}`),
      text: eventSentence(event, report, snapshot),
      occurredAt: event.occurredAt,
      eventId: event.id,
      evidence: copyEvidence(event.evidence),
    },
    seenIds,
  );
}

function levelPoint(
  kind: MarketKind,
  snapshot: TokenSnapshot,
  evidence: EvidenceLink[],
  text: string,
  seenIds: Set<string>,
): SummaryPoint {
  return point(
    {
      id: summaryId(`level:${kind}`),
      text,
      occurredAt: snapshot.capturedAt,
      eventId: null,
      evidence: copyEvidence(evidence),
    },
    seenIds,
  );
}

function point(
  input: {
    id: string;
    text: string;
    occurredAt: string;
    eventId: string | null;
    evidence: EvidenceLink[];
  },
  seenIds: Set<string>,
): SummaryPoint {
  if (seenIds.has(input.id)) {
    throw new BriefGeneratorError(`Duplicate summary point id ${input.id}.`);
  }
  seenIds.add(input.id);
  const parsed = summaryPointSchema.safeParse(input);
  if (!parsed.success) {
    throw new BriefGeneratorError(
      parsed.error.issues[0]?.message ?? "Summary point is invalid.",
    );
  }
  return parsed.data;
}

function assertPublishable(
  snapshot: TokenSnapshot,
  report: Report,
  points: SummaryPoint[],
): void {
  try {
    parseBrief({
      schemaVersion: BRIEF_SCHEMA_VERSION,
      shareId: PUBLISH_SHARE_ID,
      ca: snapshot.ca,
      period: report.period,
      generatedAt: snapshot.capturedAt,
      snapshot,
      summary: points,
      events: report.timeline.map((item) => item.event),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Summary failed the brief contract.";
    throw new BriefGeneratorError(detail);
  }
}

function readMarketEvidence(links: readonly EvidenceLink[] | undefined): EvidenceLink[] {
  if (!Array.isArray(links) || links.length === 0) {
    throw new BriefGeneratorError(
      "Level readings need at least one market evidence link.",
    );
  }
  const allowed = new Set<EvidenceSource>(marketEvidenceSources());
  const seen = new Set<string>();
  return links.map((link) => {
    const parsed = parseEvidenceLink(link);
    if (!allowed.has(parsed.source)) {
      throw new BriefGeneratorError("Level readings can only cite market data sources.");
    }
    if (seen.has(parsed.id)) {
      throw new BriefGeneratorError(`Duplicate evidence id ${parsed.id}.`);
    }
    seen.add(parsed.id);
    return parsed;
  });
}

function copyEvidence(links: readonly EvidenceLink[]): EvidenceLink[] {
  return links.map((link) => parseEvidenceLink(link));
}

function parseEvidenceLink(link: unknown): EvidenceLink {
  const parsed = evidenceLinkSchema.safeParse(link);
  if (!parsed.success) {
    throw new BriefGeneratorError("Evidence link is invalid.");
  }
  return parsed.data;
}

function marketKind(event: TimelineEvent): MarketKind | null {
  if (event.kind === "price" || event.kind === "liquidity" || event.kind === "volume") {
    return event.kind;
  }
  return null;
}

function assertMetricMatch(event: TimelineEvent, report: Report): void {
  if (event.kind !== "price" && event.kind !== "liquidity" && event.kind !== "volume") {
    return;
  }
  const metric = report[event.kind];
  if (
    event.previousUsd !== metric.previousUsd ||
    event.currentUsd !== metric.currentUsd ||
    event.changePct !== metric.changePct
  ) {
    throw new BriefGeneratorError(
      `${event.kind} summary figures do not match the report.`,
    );
  }
  if (event.kind === "volume" && event.window !== report.period) {
    throw new BriefGeneratorError("Volume summary window does not match the period.");
  }
}

function sameEvent(left: TimelineEvent, right: TimelineEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summaryId(suffix: string): string {
  return `summary:${suffix}`;
}

function eventSentence(event: TimelineEvent, report: Report, snapshot: TokenSnapshot): string {
  switch (event.kind) {
    case "price":
      return priceSentence(event, report, snapshot);
    case "liquidity":
      return marketMoveSentence("Liquidity", event, report);
    case "volume":
      return volumeSentence(event, report);
    case "website":
      return websiteSentence(event, report);
    case "x_post":
      return postSentence(event);
    case "listing":
      return `${event.title} for this token at ${event.occurredAt}.`;
  }
}

function priceSentence(
  event: {
    previousUsd: number | null;
    currentUsd: number | null;
    changePct: number | null;
    occurredAt: string;
  },
  report: Report,
  snapshot: TokenSnapshot,
): string {
  const caps = marketCapReading(
    snapshot.marketCapUsd,
    event.previousUsd,
    event.currentUsd,
  );
  if (!caps) return marketMoveSentence("Price", event, report);
  return marketMoveSentence(
    "Market cap",
    { ...event, previousUsd: caps.previousUsd, currentUsd: caps.currentUsd },
    report,
  );
}

function marketMoveSentence(
  label: "Price" | "Market cap" | "Liquidity",
  event: {
    previousUsd: number | null;
    currentUsd: number | null;
    changePct: number | null;
    occurredAt: string;
  },
  report: Report,
): string {
  const from = formatUsd(event.previousUsd ?? 0);
  const to = formatUsd(event.currentUsd ?? 0);
  let change: string;
  if (event.changePct == null) {
    change = `${label} moved from ${from} to ${to} over ${report.period}`;
  } else if (event.changePct === 0) {
    change = `${label} was unchanged over ${report.period} at ${to}`;
  } else {
    const direction = event.changePct > 0 ? "up" : "down";
    change = `${label} moved ${direction} ${formatPct(event.changePct)} over ${report.period}, from ${from} to ${to}`;
  }
  return `${change}. Observed at ${event.occurredAt}, between ${report.windowStart} and ${report.windowEnd}.`;
}

function volumeSentence(
  event: Extract<TimelineEvent, { kind: "volume" }>,
  report: Report,
): string {
  let change = `${event.window} volume was ${formatUsd(event.currentUsd ?? 0)}`;
  if (event.previousUsd != null) {
    change += `, versus ${formatUsd(event.previousUsd)} in the prior ${event.window}`;
    if (event.changePct != null && event.changePct !== 0) {
      const direction = event.changePct > 0 ? "up" : "down";
      change += ` (${direction} ${formatPct(event.changePct)})`;
    } else if (event.changePct === 0) {
      change += " (unchanged)";
    }
  }
  return `${change}. Observed at ${event.occurredAt}, between ${report.windowStart} and ${report.windowEnd}.`;
}

function levelSentence(
  kind: MarketKind,
  report: Report,
  snapshot: TokenSnapshot,
): string | null {
  const at = snapshot.capturedAt;
  if (kind === "volume") {
    return metricSentence(`${report.period} volume`, report.volume, at, report);
  }
  if (kind === "price") {
    const caps = marketCapReading(
      snapshot.marketCapUsd,
      report.price.previousUsd,
      report.price.currentUsd,
    );
    if (!caps) return null;
    return metricSentence(
      "Market cap",
      { ...report.price, previousUsd: caps.previousUsd, currentUsd: caps.currentUsd },
      at,
      report,
    );
  }
  return metricSentence("Liquidity", report.liquidity, at, report);
}

function metricSentence(
  label: string,
  metric: MetricDelta | VolumeDelta,
  at: string,
  report: Report,
): string | null {
  if (metric.currentUsd == null) return null;
  const comparison = comparedWith(
    metric.previousUsd,
    metric.changePct,
    report.baselineCapturedAt,
  );
  if (!comparison) return null;
  return `${label} was ${formatUsd(metric.currentUsd)} at ${at}${comparison}.`;
}

function comparedWith(
  previousUsd: number | null,
  changePct: number | null,
  baselineCapturedAt: string | null,
): string | null {
  if (previousUsd == null) return null;
  const at = baselineCapturedAt == null ? "" : ` at ${baselineCapturedAt}`;
  if (changePct == null) return `, compared with ${formatUsd(previousUsd)}${at}`;
  if (changePct === 0) return `, unchanged from ${formatUsd(previousUsd)}${at}`;
  const direction = changePct > 0 ? "up" : "down";
  return `, compared with ${formatUsd(previousUsd)}${at} (${direction} ${formatPct(changePct)})`;
}

function websiteSentence(
  event: Extract<TimelineEvent, { kind: "website" }>,
  report: Report,
): string {
  const detail = ensurePeriod(event.diffSummary);
  const count = report.timeline.filter((item) => item.event.kind === "website").length;
  if (count > 1) {
    return `${count} website updates. Latest at ${event.occurredAt}: ${event.url} ${detail}`;
  }
  return `Website ${event.url} changed at ${event.occurredAt}: ${detail}`;
}

function postSentence(event: Extract<TimelineEvent, { kind: "x_post" }>): string {
  const quote = quoteExcerpt(event.textExcerpt);
  if (event.about === "contract") {
    return `@${event.account} posted the contract at ${event.occurredAt}: ${quote}.`;
  }
  if (event.about === "ticker") {
    return `@${event.account} mentioned the ticker at ${event.occurredAt}: ${quote}.`;
  }
  return `@${event.account} posted at ${event.occurredAt}: ${quote}.`;
}

function ensurePeriod(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) {
    throw new BriefGeneratorError("Website change is missing a description.");
  }
  return /[.!?]$/.test(flat) ? flat : `${flat}.`;
}

function quoteExcerpt(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) throw new BriefGeneratorError("Post excerpt is empty.");
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

