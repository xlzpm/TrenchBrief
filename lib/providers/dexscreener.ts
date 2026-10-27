import { solanaAddressSchema } from "../dto/common";
import { ProviderError } from "./errors";
import { getJson, type ProviderClientOptions } from "./http";
import {
  asHttpUrl,
  asUsd,
  buildTokenSnapshot,
  firstUsd,
  capturedAtIso,
  isRecord,
  marketEvidence,
} from "./normalize";
import type { SourcedSnapshot } from "./types";

type DexCandidate = {
  pageUrl: string | null;
  name: unknown;
  symbol: unknown;
  imageUrl: unknown;
  priceUsd: unknown;
  marketCapUsd: unknown;
  fdvUsd: unknown;
  liquidityUsd: number | null;
  volume1h: unknown;
  volume6h: unknown;
  volume24h: unknown;
  website: unknown;
  x: unknown;
};

function pairsFromBody(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.pairs)) return body.pairs;
  if (isRecord(body) && body.pairs === null) return [];
  return null;
}

function socialValue(info: Record<string, unknown>): unknown {
  if (!Array.isArray(info.socials)) return null;
  for (const social of info.socials) {
    if (!isRecord(social)) continue;
    const kind = String(social.platform ?? social.type ?? "").toLowerCase();
    if (kind !== "twitter" && kind !== "x") continue;
    return social.url ?? social.handle ?? null;
  }
  return null;
}

function websiteValue(info: Record<string, unknown>): unknown {
  if (!Array.isArray(info.websites)) return null;
  for (const site of info.websites) {
    if (!isRecord(site)) continue;
    if (asHttpUrl(site.url)) return site.url;
  }
  return null;
}

function parseCandidate(value: unknown, ca: string): DexCandidate | null {
  if (!isRecord(value) || !isRecord(value.baseToken)) return null;
  if (value.baseToken.address !== ca) return null;
  const info = isRecord(value.info) ? value.info : {};
  const volume = isRecord(value.volume) ? value.volume : {};
  const liquidity = isRecord(value.liquidity) ? value.liquidity : {};
  return {
    pageUrl: typeof value.url === "string" ? value.url : null,
    name: value.baseToken.name,
    symbol: value.baseToken.symbol,
    imageUrl: info.imageUrl,
    priceUsd: value.priceUsd,
    marketCapUsd: value.marketCap,
    fdvUsd: value.fdv,
    liquidityUsd: asUsd(liquidity.usd),
    volume1h: volume.h1,
    volume6h: volume.h6,
    volume24h: volume.h24,
    website: websiteValue(info),
    x: socialValue(info),
  };
}

function pickCandidate(candidates: DexCandidate[]): DexCandidate | null {
  const ranked = [...candidates].sort(
    (left, right) => (right.liquidityUsd ?? -1) - (left.liquidityUsd ?? -1),
  );
  return ranked.find((candidate) => asUsd(candidate.priceUsd) != null) ?? ranked[0] ?? null;
}

export async function fetchDexScreenerSnapshot(
  ca: string,
  options: ProviderClientOptions = {},
): Promise<SourcedSnapshot> {
  const address = solanaAddressSchema.parse(ca);
  const url = `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(address)}`;
  const body = await getJson(url, {}, { ...options, provider: "dexscreener" });
  const pairs = pairsFromBody(body);
  if (!pairs) {
    throw new ProviderError("DexScreener returned an unexpected payload.", {
      provider: "dexscreener",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }

  const candidate = pickCandidate(
    pairs.flatMap((pair) => {
      const parsed = parseCandidate(pair, address);
      return parsed ? [parsed] : [];
    }),
  );
  if (!candidate) {
    throw new ProviderError("DexScreener has no Solana pool for this token.", {
      provider: "dexscreener",
      status: null,
      retryable: false,
      code: "not_found",
    });
  }

  return {
    snapshot: buildTokenSnapshot({
      ca: address,
      name: candidate.name,
      symbol: candidate.symbol,
      imageUrl: candidate.imageUrl,
      priceUsd: candidate.priceUsd,
      marketCapUsd: firstUsd(candidate.marketCapUsd, candidate.fdvUsd),
      liquidityUsd: candidate.liquidityUsd,
      volumeUsd: {
        "1h": candidate.volume1h,
        "6h": candidate.volume6h,
        "24h": candidate.volume24h,
      },
      website: candidate.website,
      x: candidate.x,
      capturedAt: capturedAtIso(options.now),
    }),
    evidence: marketEvidence("dexscreener", address, candidate.pageUrl),
  };
}
