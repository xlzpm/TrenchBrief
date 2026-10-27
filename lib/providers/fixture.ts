import { parseTokenSnapshot } from "@/lib/dto/token-snapshot";
import { marketEvidence } from "@/lib/providers/normalize";
import type { MarketSnapshotResult } from "@/lib/providers/types";
import { log } from "@/lib/observability/log";

const FIXTURE_CAPTURED_AT = "2026-10-26T12:00:00.000Z";

let announced = false;

/**
 * Playwright sets BRIEF_E2E_FIXTURES=1. Production ignores the flag so a
 * mis-set variable cannot serve invented market data to real visitors.
 */
export function e2eFixturesEnabled(): boolean {
  const enabled =
    process.env.BRIEF_E2E_FIXTURES === "1" && process.env.NODE_ENV !== "production";
  if (enabled && !announced) {
    announced = true;
    log.warn("market.fixtures", {
      message: "E2E market fixtures are enabled.",
    });
  }
  return enabled;
}

export function fixtureMarket(ca: string): MarketSnapshotResult {
  const snapshot = parseTokenSnapshot({
    ca,
    name: "Fixture Coin",
    symbol: "FIX",
    imageUrl: "https://example.com/fix.png",
    priceUsd: 1.25,
    marketCapUsd: 2_500_000,
    liquidityUsd: 25_000,
    volumeUsd: { "1h": 100, "6h": 200, "12h": 300, "24h": 400 },
    website: "https://example.com/fix",
    socials: { xHandle: null, xUrl: null },
    capturedAt: FIXTURE_CAPTURED_AT,
  });
  return {
    snapshot,
    evidence: [marketEvidence("dexscreener", ca)],
  };
}
