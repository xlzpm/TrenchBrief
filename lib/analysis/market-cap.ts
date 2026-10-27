/**
 * Market cap moves with price when supply is unchanged.
 * The pair is null when either side of that comparison is missing,
 * including a zero previous price, which cannot be scaled.
 */
export function marketCapReading(
  marketCapUsd: number | null,
  previousPrice: number | null,
  currentPrice: number | null,
): { previousUsd: number; currentUsd: number } | null {
  if (
    marketCapUsd == null ||
    !(marketCapUsd > 0) ||
    previousPrice == null ||
    !(previousPrice > 0) ||
    currentPrice == null ||
    !(currentPrice > 0)
  ) {
    return null;
  }
  return {
    previousUsd: marketCapUsd * (previousPrice / currentPrice),
    currentUsd: marketCapUsd,
  };
}
