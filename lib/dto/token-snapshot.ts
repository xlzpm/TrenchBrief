import { z } from "zod";

import {
  isoDateTimeSchema,
  nullableUsdSchema,
  solanaAddressSchema,
  xHandleSchema,
} from "./common";

export const volumeUsdByPeriodSchema = z.object({
  "1h": nullableUsdSchema,
  "6h": nullableUsdSchema,
  "12h": nullableUsdSchema,
  "24h": nullableUsdSchema,
});

export const tokenSocialsSchema = z.object({
  xHandle: xHandleSchema.nullable(),
  xUrl: z.url().nullable(),
});

export const tokenSnapshotSchema = z.object({
  ca: solanaAddressSchema,
  name: z.string().min(1),
  symbol: z.string().min(1),
  imageUrl: z.url().nullable(),
  priceUsd: nullableUsdSchema,
  /** Circulating market cap, or FDV when that is the only published figure. */
  marketCapUsd: nullableUsdSchema.default(null),
  liquidityUsd: nullableUsdSchema,
  volumeUsd: volumeUsdByPeriodSchema,
  website: z.url().nullable(),
  socials: tokenSocialsSchema,
  capturedAt: isoDateTimeSchema,
});

export type TokenSocials = z.infer<typeof tokenSocialsSchema>;
export type TokenSnapshot = z.infer<typeof tokenSnapshotSchema>;

export function parseTokenSnapshot(input: unknown): TokenSnapshot {
  return tokenSnapshotSchema.parse(input);
}
