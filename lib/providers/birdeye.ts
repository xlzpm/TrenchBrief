import { solanaAddressSchema } from "../dto/common";
import { readServerSecret } from "../env";
import { ProviderError } from "./errors";
import { getJson, type ProviderClientOptions } from "./http";
import {
  buildTokenSnapshot,
  capturedAtIso,
  firstPresent,
  firstUsd,
  isRecord,
  marketEvidence,
} from "./normalize";
import type { SourcedSnapshot } from "./types";

const BIRDEYE_OVERVIEW = "https://public-api.birdeye.so/defi/token_overview";

/**
 * Birdeye's hour frames are 1h, 2h, 4h, 8h, and 24h. 6h and 12h are requested
 * as 360m and 720m. The reader accepts either the minute field names or the
 * hour aliases when the API returns them.
 */
const BIRDEYE_FRAMES = "1h,360m,720m,24h";

export type BirdeyeSnapshotOptions = ProviderClientOptions & {
  apiKey?: string;
};

function birdeyeKey(explicit: string | undefined): string {
  if (explicit) return explicit;
  try {
    return readServerSecret("BIRDEYE_API_KEY");
  } catch (error) {
    throw new ProviderError(
      error instanceof Error ? error.message : "Missing Birdeye API key.",
      {
        provider: "birdeye",
        status: null,
        retryable: false,
        code: "config",
        cause: error,
      },
    );
  }
}

export async function fetchBirdeyeSnapshot(
  ca: string,
  options: BirdeyeSnapshotOptions = {},
): Promise<SourcedSnapshot> {
  const address = solanaAddressSchema.parse(ca);
  const url = new URL(BIRDEYE_OVERVIEW);
  url.searchParams.set("address", address);
  url.searchParams.set("frames", BIRDEYE_FRAMES);
  const apiKey = birdeyeKey(options.apiKey);
  const body = await getJson(
    url.toString(),
    {
      headers: {
        "x-chain": "solana",
        "X-API-KEY": apiKey,
      },
    },
    { ...options, provider: "birdeye" },
  );

  const data = isRecord(body) ? body.data : null;
  if (!isRecord(body) || body.success === false || !isRecord(data)) {
    const rawMessage =
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : "Birdeye returned no token overview.";
    const message = rawMessage.replaceAll(apiKey, "[redacted]").slice(0, 180);
    const notFound = /not found|not exist/i.test(message) || !isRecord(data);
    throw new ProviderError(message, {
      provider: "birdeye",
      status: null,
      retryable: false,
      code: notFound ? "not_found" : "invalid_response",
    });
  }

  if (data.address !== address) {
    throw new ProviderError("Birdeye returned a different token address.", {
      provider: "birdeye",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }

  const extensions = isRecord(data.extensions) ? data.extensions : {};
  const capturedAt = capturedAtIso(options.now);
  return {
    snapshot: buildTokenSnapshot({
      ca: address,
      name: data.name,
      symbol: data.symbol,
      imageUrl: data.logoURI,
      priceUsd: data.price,
      marketCapUsd: firstUsd(data.mc, data.fdv),
      liquidityUsd: data.liquidity,
      volumeUsd: {
        "1h": data.v1hUSD,
        "6h": firstPresent(data.v6hUSD, data.v360mUSD),
        "12h": firstPresent(data.v12hUSD, data.v720mUSD),
        "24h": data.v24hUSD,
      },
      website: extensions.website,
      x: extensions.twitter,
      capturedAt,
    }),
    evidence: marketEvidence("birdeye", address),
  };
}
