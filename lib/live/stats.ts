import { solanaAddressSchema } from "@/lib/dto";
import { asUsd, firstUsd, isRecord } from "@/lib/providers/normalize";

/**
 * Birdeye token-stats intervals do not include 12h. That window stays on the
 * snapshot the page already rendered.
 */
const VOLUME_KEYS = {
  "1h": ["volume_1h_usd", "v1hUSD", "volume_1h"],
  "6h": ["volume_6h_usd", "v6hUSD", "volume_6h"],
  "24h": ["volume_24h_usd", "v24hUSD", "volume_24h"],
} as const;

export const TOKEN_STATS_SELECT = {
  price: true,
  trade_data: {
    volume: true,
    intervals: ["1h", "6h", "24h"],
  },
  marketcap: true,
  fdv: true,
  liquidity: true,
} as const;

export type LiveVolume = Partial<Record<"1h" | "6h" | "24h", number>>;

export type LiveStatsFrame = {
  type: "stats";
  ca: string;
  capturedAt: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: LiveVolume;
};

export type LiveStatusFrame = {
  type: "status";
  live: boolean;
};

export type LiveServerFrame = LiveStatsFrame | LiveStatusFrame;

export type LiveReading = {
  ca: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: Record<"1h" | "6h" | "12h" | "24h", number | null>;
};

export function subscribeTokenStats(addresses: readonly string[]) {
  return {
    type: "SUBSCRIBE_TOKEN_STATS",
    data: {
      address: addresses.length === 1 ? addresses[0] : [...addresses],
      select: TOKEN_STATS_SELECT,
    },
  };
}

export function unsubscribeTokenStats(address: string) {
  return {
    type: "UNSUBSCRIBE_TOKEN_STATS",
    data: { address },
  };
}

export function liveFrameFromBirdeye(message: unknown, now: Date): LiveStatsFrame | null {
  if (!isRecord(message) || message.type !== "TOKEN_STATS_DATA" || !isRecord(message.data)) {
    return null;
  }
  const data = message.data;
  const address = solanaAddressSchema.safeParse(data.address);
  if (!address.success) return null;

  const frame: LiveStatsFrame = {
    type: "stats",
    ca: address.data,
    capturedAt: capturedAtFrom(data, now),
  };
  const priceUsd = asUsd(data.price);
  const marketCapUsd = firstUsd(data.marketcap, data.marketCap, data.market_cap, data.mc, data.fdv);
  const liquidityUsd = liquidityOf(data);
  if (priceUsd != null) frame.priceUsd = priceUsd;
  if (marketCapUsd != null) frame.marketCapUsd = marketCapUsd;
  if (liquidityUsd != null) frame.liquidityUsd = liquidityUsd;

  const volumeUsd: LiveVolume = {};
  for (const period of ["1h", "6h", "24h"] as const) {
    const amount = firstUsd(...VOLUME_KEYS[period].map((key) => data[key]));
    if (amount != null) volumeUsd[period] = amount;
  }
  if (Object.keys(volumeUsd).length > 0) frame.volumeUsd = volumeUsd;

  if (
    frame.priceUsd == null &&
    frame.marketCapUsd == null &&
    frame.liquidityUsd == null &&
    frame.volumeUsd == null
  ) {
    return null;
  }
  return frame;
}

export function parseLiveServerFrame(value: unknown): LiveServerFrame | null {
  if (!isRecord(value)) return null;
  if (value.type === "status") {
    return typeof value.live === "boolean" ? { type: "status", live: value.live } : null;
  }
  if (value.type !== "stats") return null;
  const address = solanaAddressSchema.safeParse(value.ca);
  if (!address.success || typeof value.capturedAt !== "string") return null;
  if (Number.isNaN(Date.parse(value.capturedAt))) return null;

  const frame: LiveStatsFrame = {
    type: "stats",
    ca: address.data,
    capturedAt: value.capturedAt,
  };
  const priceUsd = optionalUsd(value.priceUsd);
  const marketCapUsd = optionalUsd(value.marketCapUsd);
  const liquidityUsd = optionalUsd(value.liquidityUsd);
  if (priceUsd === "invalid" || marketCapUsd === "invalid" || liquidityUsd === "invalid") {
    return null;
  }
  if (typeof priceUsd === "number") frame.priceUsd = priceUsd;
  if (typeof marketCapUsd === "number") frame.marketCapUsd = marketCapUsd;
  if (typeof liquidityUsd === "number") frame.liquidityUsd = liquidityUsd;

  if (value.volumeUsd !== undefined) {
    if (!isRecord(value.volumeUsd)) return null;
    const volumeUsd: LiveVolume = {};
    for (const period of ["1h", "6h", "24h"] as const) {
      const amount = optionalUsd(value.volumeUsd[period]);
      if (amount === "invalid") return null;
      if (typeof amount === "number") volumeUsd[period] = amount;
    }
    if (Object.keys(volumeUsd).length > 0) frame.volumeUsd = volumeUsd;
  }
  return frame;
}

export type LiveQuote = {
  ca: string;
  capturedAt: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: LiveReading["volumeUsd"];
};

const QUOTE_VOLUME_PERIODS = ["1h", "6h", "12h", "24h"] as const;

/** A full market quote replaces every card. Null means the provider omitted it. */
export function parseLiveQuote(value: unknown): LiveQuote | null {
  if (!isRecord(value) || value.ok !== true) return null;
  const address = solanaAddressSchema.safeParse(value.ca);
  if (!address.success || typeof value.capturedAt !== "string") return null;
  if (Number.isNaN(Date.parse(value.capturedAt))) return null;

  const priceUsd = optionalUsd(value.priceUsd);
  const marketCapUsd = optionalUsd(value.marketCapUsd);
  const liquidityUsd = optionalUsd(value.liquidityUsd);
  if (priceUsd === "invalid" || marketCapUsd === "invalid" || liquidityUsd === "invalid") {
    return null;
  }
  if (!isRecord(value.volumeUsd)) return null;

  const volumeUsd = {} as LiveReading["volumeUsd"];
  for (const period of QUOTE_VOLUME_PERIODS) {
    const amount = optionalUsd(value.volumeUsd[period]);
    if (amount === "invalid") return null;
    volumeUsd[period] = amount;
  }

  return {
    ca: address.data,
    capturedAt: value.capturedAt,
    priceUsd,
    marketCapUsd,
    liquidityUsd,
    volumeUsd,
  };
}

export function applyLiveQuote(current: LiveReading, quote: LiveQuote): LiveReading {
  if (quote.ca !== current.ca) return current;
  return {
    ca: current.ca,
    priceUsd: quote.priceUsd,
    marketCapUsd: quote.marketCapUsd,
    liquidityUsd: quote.liquidityUsd,
    volumeUsd: { ...quote.volumeUsd },
  };
}

export function applyLiveStats(current: LiveReading, frame: LiveStatsFrame): LiveReading {
  if (frame.ca !== current.ca) return current;
  return {
    ca: current.ca,
    priceUsd: frame.priceUsd ?? current.priceUsd,
    marketCapUsd: frame.marketCapUsd ?? current.marketCapUsd,
    liquidityUsd: frame.liquidityUsd ?? current.liquidityUsd,
    volumeUsd: {
      "1h": frame.volumeUsd?.["1h"] ?? current.volumeUsd["1h"],
      "6h": frame.volumeUsd?.["6h"] ?? current.volumeUsd["6h"],
      "12h": current.volumeUsd["12h"],
      "24h": frame.volumeUsd?.["24h"] ?? current.volumeUsd["24h"],
    },
  };
}

function liquidityOf(data: Record<string, unknown>): number | null {
  if (isRecord(data.liquidity)) return asUsd(data.liquidity.usd);
  return firstUsd(data.liquidity, data.liquidity_usd, data.liquidityUsd);
}

function capturedAtFrom(data: Record<string, unknown>, now: Date): string {
  const unix = data.last_trade_unix_time;
  if (typeof unix !== "number" || !Number.isFinite(unix) || unix <= 0) {
    return now.toISOString();
  }
  const ms = unix > 1e12 ? unix : unix * 1000;
  return new Date(ms).toISOString();
}

function optionalUsd(value: unknown): number | null | "invalid" {
  if (value == null) return null;
  const amount = asUsd(value);
  return amount == null ? "invalid" : amount;
}
