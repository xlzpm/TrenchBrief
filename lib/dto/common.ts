import { z } from "zod";

/** Base58 text of a Solana address (mint, or other 32-byte account). */
export const solanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Expected a Solana address.");

/** X account handle, stored without the @ prefix. */
export const xHandleSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,15}$/, "Expected an X handle without the @ prefix.");

export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const BRIEF_PERIODS = ["1h", "6h", "12h", "24h"] as const;

export const briefPeriodSchema = z.enum(BRIEF_PERIODS);

export const nullableUsdSchema = z.number().finite().min(0).nullable();

export const nullableChangePctSchema = z.number().finite().nullable();

export const EVIDENCE_SOURCES = [
  "birdeye",
  "dexscreener",
  "jupiter",
  "x",
  "website",
] as const;

export const evidenceSourceSchema = z.enum(EVIDENCE_SOURCES);

export const evidenceLinkSchema = z.object({
  id: z.string().min(1),
  source: evidenceSourceSchema,
  url: z.url(),
  label: z.string().min(1),
});

/** Lowercase SHA-256 of normalized website content. */
export const contentHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 hex digest.");

export type BriefPeriod = z.infer<typeof briefPeriodSchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

/** Price, liquidity, and volume readings come from these providers. */
export const MARKET_EVIDENCE_SOURCES = [
  "birdeye",
  "dexscreener",
  "jupiter",
] as const satisfies readonly EvidenceSource[];

/** Reads the market provider list. Prefer this over the const in server code. */
export function marketEvidenceSources(): readonly EvidenceSource[] {
  return MARKET_EVIDENCE_SOURCES;
}

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
