import { z } from "zod";

import {
  briefPeriodSchema,
  contentHashSchema,
  evidenceLinkSchema,
  isoDateTimeSchema,
  nullableChangePctSchema,
  nullableUsdSchema,
  solanaAddressSchema,
  xHandleSchema,
} from "./common";

const timelineEventFields = {
  id: z.string().min(1),
  ca: solanaAddressSchema,
  occurredAt: isoDateTimeSchema,
  title: z.string().min(1),
  evidence: z.array(evidenceLinkSchema).min(1),
};

const usdChangeFields = {
  previousUsd: nullableUsdSchema,
  currentUsd: nullableUsdSchema,
  changePct: nullableChangePctSchema,
};

export const timelineEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...timelineEventFields,
    kind: z.literal("price"),
    ...usdChangeFields,
  }),
  z.object({
    ...timelineEventFields,
    kind: z.literal("liquidity"),
    ...usdChangeFields,
  }),
  z.object({
    ...timelineEventFields,
    kind: z.literal("volume"),
    window: briefPeriodSchema,
    ...usdChangeFields,
  }),
  z.object({
    ...timelineEventFields,
    kind: z.literal("website"),
    url: z.url(),
    contentHash: contentHashSchema,
    diffSummary: z.string().min(1),
  }),
  z.object({
    ...timelineEventFields,
    kind: z.literal("x_post"),
    account: xHandleSchema,
    postId: z.string().min(1),
    postUrl: z.url(),
    textExcerpt: z.string().min(1).max(500),
    /** Followers when the post was read. Null for a post taken from a profile page. */
    followers: z.number().int().nonnegative().nullable().default(null),
    /** Likes when the post was read. Null when the source does not expose it. */
    likes: z.number().int().nonnegative().nullable().default(null),
    /**
     * Business or government check on the author. A blue Premium check is
     * stored as null: it does not make the account an official source.
     */
    verification: z.enum(["business", "government"]).nullable().default(null),
    /**
     * Any checkmark, including a paid blue check. Organization and government
     * checks stay on `verification`.
     */
    checked: z.boolean().default(false),
    /** X identity check. Null when the source did not say. */
    identityVerified: z.boolean().nullable().default(null),
    /** Followers who are themselves verified. Null when the source did not say. */
    verifiedFollowers: z.number().int().nonnegative().nullable().default(null),
    /**
     * `contract` names this mint. `ticker` names the symbol without the mint.
     * `account` is a post from the linked project account.
     */
    about: z.enum(["contract", "ticker", "account"]).default("account"),
  }),
  z.object({
    ...timelineEventFields,
    kind: z.literal("listing"),
    url: z.url(),
    placement: z.enum(["profile", "takeover", "ad", "trending", "boost"]),
  }),
]);

export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export function parseTimelineEvent(input: unknown): TimelineEvent {
  return timelineEventSchema.parse(input);
}
