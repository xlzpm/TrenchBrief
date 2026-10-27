import { solanaAddressSchema } from "../dto/common";
import { ProviderError } from "./errors";
import { getJson, type ProviderClientOptions } from "./http";
import {
  asUsd,
  buildTokenSnapshot,
  firstUsd,
  capturedAtIso,
  isRecord,
  marketEvidence,
} from "./normalize";
import type { SourcedSnapshot } from "./types";

function windowVolume(stats: unknown): number | null {
  if (!isRecord(stats)) return null;
  const buy = asUsd(stats.buyVolume);
  const sell = asUsd(stats.sellVolume);
  if (buy == null && sell == null) return null;
  return (buy ?? 0) + (sell ?? 0);
}

export async function fetchJupiterSnapshot(
  ca: string,
  options: ProviderClientOptions = {},
): Promise<SourcedSnapshot> {
  const address = solanaAddressSchema.parse(ca);
  const url = new URL("https://api.jup.ag/tokens/v2/search");
  url.searchParams.set("query", address);
  const body = await getJson(url.toString(), {}, { ...options, provider: "jupiter" });
  if (!Array.isArray(body)) {
    throw new ProviderError("Jupiter returned an unexpected payload.", {
      provider: "jupiter",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }

  const token = body.find((item) => isRecord(item) && item.id === address);
  if (!isRecord(token)) {
    throw new ProviderError("Jupiter has no metadata for this token.", {
      provider: "jupiter",
      status: null,
      retryable: false,
      code: "not_found",
    });
  }

  return {
    snapshot: buildTokenSnapshot({
      ca: address,
      name: token.name,
      symbol: token.symbol,
      imageUrl: token.icon,
      priceUsd: token.usdPrice,
      marketCapUsd: firstUsd(token.mcap, token.fdv),
      liquidityUsd: token.liquidity,
      volumeUsd: {
        "1h": windowVolume(token.stats1h),
        "6h": windowVolume(token.stats6h),
        "24h": windowVolume(token.stats24h),
      },
      website: token.website,
      x: token.twitter,
      capturedAt: capturedAtIso(options.now),
    }),
    evidence: marketEvidence("jupiter", address),
  };
}
