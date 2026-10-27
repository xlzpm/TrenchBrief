export const PROVIDER_NAMES = [
  "birdeye",
  "dexscreener",
  "jupiter",
  "x",
  "website",
  "market",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type ProviderErrorCode =
  | "http"
  | "network"
  | "not_found"
  | "invalid_response"
  | "config"
  | "blocked_url";

type ProviderErrorOptions = {
  provider: ProviderName;
  status: number | null;
  retryable: boolean;
  code: ProviderErrorCode;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly code: ProviderErrorCode;

  constructor(message: string, options: ProviderErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable;
    this.code = options.code;
  }
}

export class MarketUnavailableError extends ProviderError {
  readonly causes: readonly ProviderError[];

  constructor(ca: string, causes: readonly ProviderError[]) {
    const summary = causes
      .map((cause) => `${cause.provider}: ${cause.message}`)
      .join("; ");
    super(
      summary
        ? `No market provider returned a snapshot for ${ca}. ${summary}`
        : `No market provider returned a snapshot for ${ca}.`,
      {
        provider: "market",
        status: null,
        retryable: false,
        code: "not_found",
      },
    );
    this.causes = causes;
  }
}

export function providerLabel(provider: ProviderName): string {
  switch (provider) {
    case "birdeye":
      return "Birdeye";
    case "dexscreener":
      return "DexScreener";
    case "jupiter":
      return "Jupiter";
    case "x":
      return "X";
    case "website":
      return "Website";
    case "market":
      return "Market";
  }
}

export function asProviderError(
  error: unknown,
  provider: ProviderName,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const message =
    error instanceof Error ? error.message : "Provider request failed.";
  return new ProviderError(message, {
    provider,
    status: null,
    retryable: false,
    code: "network",
    cause: error,
  });
}
