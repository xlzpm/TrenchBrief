import { solanaAddressSchema } from "../dto/common";
import type { TokenSnapshot } from "../dto/token-snapshot";
import { parseTokenSnapshot } from "../dto/token-snapshot";
import { env } from "../env";
import { fetchBirdeyeSnapshot } from "./birdeye";
import { fetchDexScreenerSnapshot } from "./dexscreener";
import {
  asProviderError,
  MarketUnavailableError,
  ProviderError,
} from "./errors";
import { fetchJupiterSnapshot } from "./jupiter";
import type { ProviderClientOptions } from "./http";
import { UNKNOWN_TOKEN_NAME, UNKNOWN_TOKEN_SYMBOL } from "./normalize";
import type { MarketSnapshotResult, SourcedSnapshot } from "./types";

export type MarketReadOptions = ProviderClientOptions & {
  /**
   * Pass null to skip Birdeye. Leave unset to use BIRDEYE_API_KEY when it exists.
   */
  birdeyeApiKey?: string | null;
};

function resolvedBirdeyeKey(options: MarketReadOptions): string | null {
  if (options.birdeyeApiKey === null) return null;
  if (options.birdeyeApiKey) return options.birdeyeApiKey;
  return env.BIRDEYE_API_KEY ?? null;
}

/**
 * DexScreener and Jupiter do not publish a 12h volume. A missing 12h window
 * stays null and does not, by itself, force another provider call.
 * Market cap is filled from the next source when the primary omits it.
 * Website is filled when missing because the site monitor depends on it.
 */
export function needsAnotherMarketSource(snapshot: TokenSnapshot): boolean {
  const marketMissing =
    snapshot.priceUsd == null ||
    snapshot.marketCapUsd == null ||
    snapshot.liquidityUsd == null ||
    snapshot.volumeUsd["1h"] == null ||
    snapshot.volumeUsd["6h"] == null ||
    snapshot.volumeUsd["24h"] == null;
  const profileMissing =
    snapshot.website == null ||
    (snapshot.imageUrl == null && snapshot.socials.xHandle == null);
  return marketMissing || profileMissing;
}

export function mergeTokenSnapshots(
  primary: TokenSnapshot,
  fallback: TokenSnapshot,
): TokenSnapshot {
  if (primary.ca !== fallback.ca) {
    throw new ProviderError(
      "Refusing to merge market snapshots for different tokens.",
      {
        provider: "market",
        status: null,
        retryable: false,
        code: "invalid_response",
      },
    );
  }
  const socials = primary.socials.xHandle ? primary.socials : fallback.socials;
  return parseTokenSnapshot({
    ca: primary.ca,
    name: primary.name === UNKNOWN_TOKEN_NAME ? fallback.name : primary.name,
    symbol:
      primary.symbol === UNKNOWN_TOKEN_SYMBOL ? fallback.symbol : primary.symbol,
    imageUrl: primary.imageUrl ?? fallback.imageUrl,
    priceUsd: primary.priceUsd ?? fallback.priceUsd,
    marketCapUsd: primary.marketCapUsd ?? fallback.marketCapUsd,
    liquidityUsd: primary.liquidityUsd ?? fallback.liquidityUsd,
    volumeUsd: {
      "1h": primary.volumeUsd["1h"] ?? fallback.volumeUsd["1h"],
      "6h": primary.volumeUsd["6h"] ?? fallback.volumeUsd["6h"],
      "12h": primary.volumeUsd["12h"] ?? fallback.volumeUsd["12h"],
      "24h": primary.volumeUsd["24h"] ?? fallback.volumeUsd["24h"],
    },
    website: primary.website ?? fallback.website,
    socials,
    capturedAt: primary.capturedAt,
  });
}

export async function readTokenSnapshot(
  ca: string,
  options: MarketReadOptions = {},
): Promise<MarketSnapshotResult> {
  const address = solanaAddressSchema.parse(ca);
  const clientOptions: ProviderClientOptions = options;
  let snapshot: TokenSnapshot | null = null;
  const evidence: MarketSnapshotResult["evidence"] = [];
  const causes: ProviderError[] = [];

  const consider = async (
    read: () => Promise<SourcedSnapshot>,
    provider: "birdeye" | "dexscreener" | "jupiter",
  ) => {
    try {
      const result = await read();
      snapshot = snapshot
        ? mergeTokenSnapshots(snapshot, result.snapshot)
        : result.snapshot;
      evidence.push(result.evidence);
    } catch (error) {
      causes.push(asProviderError(error, provider));
    }
  };

  const birdeyeKey = resolvedBirdeyeKey(options);
  if (birdeyeKey) {
    await consider(
      () => fetchBirdeyeSnapshot(address, { ...clientOptions, apiKey: birdeyeKey }),
      "birdeye",
    );
  }
  if (!snapshot || needsAnotherMarketSource(snapshot)) {
    await consider(
      () => fetchDexScreenerSnapshot(address, clientOptions),
      "dexscreener",
    );
  }
  if (!snapshot || needsAnotherMarketSource(snapshot)) {
    await consider(
      () => fetchJupiterSnapshot(address, clientOptions),
      "jupiter",
    );
  }

  if (!snapshot) throw new MarketUnavailableError(address, causes);
  return { snapshot, evidence };
}
