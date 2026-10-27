import { solanaAddressSchema } from "../dto/common";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";
import { ProviderError } from "./errors";
import { getJson, type ProviderClientOptions } from "./http";
import { isRecord } from "./normalize";

const PLACEMENT = {
  tokenProfile: "profile",
  communityTakeover: "takeover",
  tokenAd: "ad",
  trendingBarAd: "trending",
} as const;

const TITLE = {
  profile: "Paid DexScreener profile",
  takeover: "Paid DexScreener community takeover",
  ad: "Paid DexScreener ad",
  trending: "Paid DexScreener trending placement",
  boost: "Paid DexScreener boost",
} as const;

const LIVE_STATUS = new Set(["approved", "processing", "on-hold"]);

export type DexOrderQuery = {
  ca: string;
  since: Date;
  until: Date;
};

/**
 * Paid DexScreener orders for this mint. Cancelled and rejected orders are
 * omitted. The token page is the source link, and the payment time is the
 * event time.
 */
export async function fetchDexOrders(
  query: DexOrderQuery,
  options: ProviderClientOptions = {},
): Promise<TimelineEvent[]> {
  const ca = solanaAddressSchema.parse(query.ca);
  const url = `https://api.dexscreener.com/orders/v1/solana/${encodeURIComponent(ca)}`;
  const body = await getJson(
    url,
    {},
    {
      ...options,
      provider: "dexscreener",
      attempts: options.attempts ?? 1,
      timeoutMs: options.timeoutMs ?? 4_000,
    },
  );
  return ordersFromBody(body, ca, query.since.getTime(), query.until.getTime());
}

export function ordersFromBody(
  body: unknown,
  ca: string,
  sinceMs: number,
  untilMs: number,
): TimelineEvent[] {
  const address = solanaAddressSchema.parse(ca);
  const rows = orderRows(body);
  const events: TimelineEvent[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    if (typeof row.tokenAddress === "string" && row.tokenAddress !== address) return;
    if (typeof row.chainId === "string" && row.chainId.toLowerCase() !== "solana") return;
    const placement = PLACEMENT[row.type as keyof typeof PLACEMENT];
    const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
    if (!placement || !LIVE_STATUS.has(status)) return;
    const paidAt = paidAtMs(row.paymentTimestamp);
    if (paidAt == null || paidAt <= sinceMs || paidAt > untilMs) return;
    const id = `dex:${placement}:${paidAt}:${index}`;
    if (seen.has(id)) return;
    seen.add(id);
    const page = `https://dexscreener.com/solana/${encodeURIComponent(address)}`;
    events.push(
      parseTimelineEvent({
        id,
        ca: address,
        kind: "listing",
        occurredAt: new Date(paidAt).toISOString(),
        title: TITLE[placement],
        evidence: [
          {
            id,
            source: "dexscreener",
            url: page,
            label: "DexScreener token page",
          },
        ],
        url: page,
        placement,
      }),
    );
  });

  if (isRecord(body) && Array.isArray(body.boosts)) {
    for (const row of body.boosts) {
      const event = boostEvent(row, address, sinceMs, untilMs, events.length);
      if (event && !seen.has(event.id)) {
        seen.add(event.id);
        events.push(event);
      }
    }
  }

  return events;
}

function boostEvent(
  row: unknown,
  ca: string,
  sinceMs: number,
  untilMs: number,
  index: number,
): TimelineEvent | null {
  if (!isRecord(row)) return null;
  if (typeof row.tokenAddress === "string" && row.tokenAddress !== ca) return null;
  if (typeof row.chainId === "string" && row.chainId.toLowerCase() !== "solana") return null;
  const paidAt = paidAtMs(row.paymentTimestamp);
  if (paidAt == null || paidAt <= sinceMs || paidAt > untilMs) return null;
  const amount = typeof row.amount === "number" && row.amount > 0 ? row.amount : null;
  const id =
    typeof row.id === "string" && row.id.trim()
      ? `dex:boost:${row.id.trim()}`
      : `dex:boost:${paidAt}:${index}`;
  const page = `https://dexscreener.com/solana/${encodeURIComponent(ca)}`;
  return parseTimelineEvent({
    id,
    ca,
    kind: "listing",
    occurredAt: new Date(paidAt).toISOString(),
    title: amount == null ? TITLE.boost : `${TITLE.boost} of ${amount}`,
    evidence: [
      {
        id,
        source: "dexscreener",
        url: page,
        label: "DexScreener token page",
      },
    ],
    url: page,
    placement: "boost",
  });
}

function orderRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.orders)) return body.orders;
  throw new ProviderError("DexScreener orders returned an unexpected payload.", {
    provider: "dexscreener",
    status: null,
    retryable: false,
    code: "invalid_response",
  });
}

function paidAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  return Number.isFinite(ms) ? ms : null;
}
