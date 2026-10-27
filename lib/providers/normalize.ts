import type { BriefPeriod } from "../dto/common";
import { evidenceLinkSchema, type EvidenceLink, type EvidenceSource } from "../dto/common";
import {
  parseTokenSnapshot,
  type TokenSnapshot,
  type TokenSocials,
} from "../dto/token-snapshot";

export const UNKNOWN_TOKEN_NAME = "Unknown";
export const UNKNOWN_TOKEN_SYMBOL = "UNKNOWN";

const RESERVED_X_PATHS = new Set([
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "login",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "tos",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asUsd(value: unknown): number | null {
  const numeric =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return numeric;
}

export function asLabel(
  value: unknown,
  placeholder: string,
  maxLength: number,
): string {
  if (typeof value !== "string") return placeholder;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return cleaned || placeholder;
}

export function asHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (!candidate || candidate.length > 2_048) return null;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  if (!/^https?:\/\//i.test(candidate)) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function xHandleFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (
    host !== "x.com" &&
    host !== "twitter.com" &&
    host !== "mobile.x.com" &&
    host !== "mobile.twitter.com"
  ) {
    return null;
  }
  const screenName = url.searchParams.get("screen_name");
  if (screenName) return screenName;
  const segments = url.pathname.split("/").filter(Boolean);
  const profile = segments[0];
  if (!profile) return null;
  if (segments.length === 1) return profile;
  // DexScreener often links the project account as a specific post.
  if (segments.length >= 3 && segments[1]?.toLowerCase() === "status") return profile;
  return null;
}

export function asXSocial(value: unknown): TokenSocials {
  const empty: TokenSocials = { xHandle: null, xUrl: null };
  const raw = isRecord(value) ? (value.url ?? value.handle ?? value.twitter) : value;
  if (typeof raw !== "string") return empty;
  const trimmed = raw.trim();
  if (!trimmed) return empty;

  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const fromProfile = /[./]/.test(bare) ? xHandleFromUrl(trimmed) : bare;
  if (!fromProfile || !/^[A-Za-z0-9_]{1,15}$/.test(fromProfile)) return empty;
  if (RESERVED_X_PATHS.has(fromProfile.toLowerCase())) return empty;
  return {
    xHandle: fromProfile,
    xUrl: `https://x.com/${fromProfile}`,
  };
}

export function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/** First finite USD amount. Zero counts; missing and unusable values do not. */
export function firstUsd(...values: unknown[]): number | null {
  for (const value of values) {
    const amount = asUsd(value);
    if (amount != null) return amount;
  }
  return null;
}

export type SnapshotDraft = {
  ca: string;
  name?: unknown;
  symbol?: unknown;
  imageUrl?: unknown;
  priceUsd?: unknown;
  marketCapUsd?: unknown;
  liquidityUsd?: unknown;
  volumeUsd?: Partial<Record<BriefPeriod, unknown>>;
  website?: unknown;
  x?: unknown;
  capturedAt: string;
};

export function buildTokenSnapshot(draft: SnapshotDraft): TokenSnapshot {
  return parseTokenSnapshot({
    ca: draft.ca,
    name: asLabel(draft.name, UNKNOWN_TOKEN_NAME, 120),
    symbol: asLabel(draft.symbol, UNKNOWN_TOKEN_SYMBOL, 32),
    imageUrl: asHttpUrl(draft.imageUrl),
    priceUsd: asUsd(draft.priceUsd),
    marketCapUsd: asUsd(draft.marketCapUsd),
    liquidityUsd: asUsd(draft.liquidityUsd),
    volumeUsd: {
      "1h": asUsd(draft.volumeUsd?.["1h"]),
      "6h": asUsd(draft.volumeUsd?.["6h"]),
      "12h": asUsd(draft.volumeUsd?.["12h"]),
      "24h": asUsd(draft.volumeUsd?.["24h"]),
    },
    website: asHttpUrl(draft.website),
    socials: asXSocial(draft.x),
    capturedAt: draft.capturedAt,
  });
}

const MARKET_PAGES: Record<
  Extract<EvidenceSource, "birdeye" | "dexscreener" | "jupiter">,
  (ca: string) => string
> = {
  birdeye: (ca) =>
    `https://birdeye.so/token/${encodeURIComponent(ca)}?chain=solana`,
  dexscreener: (ca) => `https://dexscreener.com/solana/${encodeURIComponent(ca)}`,
  jupiter: (ca) => `https://jup.ag/tokens/${encodeURIComponent(ca)}`,
};

const MARKET_LABELS = {
  birdeye: "Birdeye",
  dexscreener: "DexScreener",
  jupiter: "Jupiter",
} as const;

export function marketEvidence(
  source: keyof typeof MARKET_PAGES,
  ca: string,
  pageUrl?: string | null,
): EvidenceLink {
  return evidenceLinkSchema.parse({
    id: `${source}:${ca}`,
    source,
    url: asHttpUrl(pageUrl) ?? MARKET_PAGES[source](ca),
    label: MARKET_LABELS[source],
  });
}

export function capturedAtIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}
