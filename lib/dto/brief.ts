import { z } from "zod";

import {
  briefPeriodSchema,
  evidenceLinkSchema,
  isoDateTimeSchema,
  marketEvidenceSources,
  solanaAddressSchema,
  type EvidenceLink,
  type EvidenceSource,
} from "./common";
import { timelineEventSchema, type TimelineEvent } from "./event";
import { tokenSnapshotSchema } from "./token-snapshot";

export const BRIEF_SCHEMA_VERSION = 1 as const;

export const SUMMARY_POINT_LIMITS = { min: 0, max: 5 } as const;

const MARKET_EVIDENCE_SOURCE_SET = new Set<EvidenceSource>(marketEvidenceSources());

/**
 * One English thesis.
 * `occurredAt` is when the claim was observed. The sentence repeats that
 * timestamp. Evidence stays attached for provenance, and the sentence does
 * not name those sources. `eventId` cites the timeline event
 * the thesis was copied from, or is null for a market level reading taken
 * at the snapshot time.
 */
export const summaryPointSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    occurredAt: isoDateTimeSchema,
    eventId: z.string().min(1).nullable(),
    evidence: z.array(evidenceLinkSchema).min(1),
  })
  .superRefine((point, ctx) => {
    if (!point.text.includes(point.occurredAt)) {
      ctx.addIssue({
        code: "custom",
        message: "Summary text must include the observation time.",
        path: ["text"],
        input: point.text,
      });
    }

    const seenEvidence = new Set<string>();
    point.evidence.forEach((link, index) => {
      if (seenEvidence.has(link.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Evidence ids must be unique on a summary point.",
          path: ["evidence", index, "id"],
          input: link.id,
        });
      }
      seenEvidence.add(link.id);
    });
  });

export const briefRequestSchema = z.object({
  ca: solanaAddressSchema,
  period: briefPeriodSchema,
});

export const briefSchema = z
  .object({
    schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
    shareId: z.uuid(),
    ca: solanaAddressSchema,
    period: briefPeriodSchema,
    generatedAt: isoDateTimeSchema,
    snapshot: tokenSnapshotSchema,
    summary: z
      .array(summaryPointSchema)
      .min(SUMMARY_POINT_LIMITS.min)
      .max(SUMMARY_POINT_LIMITS.max),
    events: z.array(timelineEventSchema),
  })
  .superRefine((brief, ctx) => {
    const eventsById = new Map<string, TimelineEvent>();
    const seenEventIds = new Set<string>();
    brief.events.forEach((event, index) => {
      if (event.ca !== brief.ca) {
        ctx.addIssue({
          code: "custom",
          message: "Event address must match the brief address.",
          path: ["events", index, "ca"],
          input: event.ca,
        });
      }
      if (seenEventIds.has(event.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Event ids must be unique on a brief.",
          path: ["events", index, "id"],
          input: event.id,
        });
      }
      seenEventIds.add(event.id);
      eventsById.set(event.id, event);
    });

    const seenPointIds = new Set<string>();
    const citedEventIds = new Set<string>();
    brief.summary.forEach((point, index) => {
      if (seenPointIds.has(point.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Summary point ids must be unique.",
          path: ["summary", index, "id"],
          input: point.id,
        });
      }
      seenPointIds.add(point.id);

      if (point.eventId == null) {
        bindLevelReading(brief.snapshot.capturedAt, point, index, ctx);
        return;
      }

      if (citedEventIds.has(point.eventId)) {
        ctx.addIssue({
          code: "custom",
          message: "Each summary event can be cited once.",
          path: ["summary", index, "eventId"],
          input: point.eventId,
        });
      }
      citedEventIds.add(point.eventId);

      const event = eventsById.get(point.eventId);
      if (!event) {
        ctx.addIssue({
          code: "custom",
          message: "Summary point must cite an event on this brief.",
          path: ["summary", index, "eventId"],
          input: point.eventId,
        });
        return;
      }
      if (point.occurredAt !== event.occurredAt) {
        ctx.addIssue({
          code: "custom",
          message: "Summary time must match the cited event.",
          path: ["summary", index, "occurredAt"],
          input: point.occurredAt,
        });
      }
      point.evidence.forEach((link, linkIndex) => {
        if (!event.evidence.some((item) => sameEvidence(item, link))) {
          ctx.addIssue({
            code: "custom",
            message: "Summary evidence must come from the cited event.",
            path: ["summary", index, "evidence", linkIndex],
            input: link,
          });
        }
      });
    });
  });

function bindLevelReading(
  capturedAt: string,
  point: { occurredAt: string; evidence: EvidenceLink[] },
  index: number,
  ctx: z.RefinementCtx,
): void {
  if (point.occurredAt !== capturedAt) {
    ctx.addIssue({
      code: "custom",
      message: "A level reading must use the snapshot time.",
      path: ["summary", index, "occurredAt"],
      input: point.occurredAt,
    });
  }
  if (point.evidence.length > 0 && point.evidence.every((link) => link.source === "website")) {
    return;
  }
  point.evidence.forEach((link, linkIndex) => {
    if (!MARKET_EVIDENCE_SOURCE_SET.has(link.source)) {
      ctx.addIssue({
        code: "custom",
        message: "A level reading can only cite market data sources.",
        path: ["summary", index, "evidence", linkIndex, "source"],
        input: link.source,
      });
    }
  });
}

function sameEvidence(left: EvidenceLink, right: EvidenceLink): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.url === right.url &&
    left.label === right.label
  );
}

export type SummaryPoint = z.infer<typeof summaryPointSchema>;
export type BriefRequest = z.infer<typeof briefRequestSchema>;
export type Brief = z.infer<typeof briefSchema>;

export function parseBriefRequest(input: unknown): BriefRequest {
  return briefRequestSchema.parse(input);
}

export function parseBrief(input: unknown): Brief {
  return briefSchema.parse(input);
}
