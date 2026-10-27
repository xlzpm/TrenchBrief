import { readThroughMarketCache } from "@/lib/cache/market-cache";
import { briefRequestSchema, solanaAddressSchema, type Brief, type BriefPeriod } from "@/lib/dto";
import {
  QUOTE_RATE_LIMIT,
  consumeRateLimit,
  rateLimitHeaders,
  type RateLimitDecision,
} from "@/lib/limit/rate-limit";
import { MarketUnavailableError } from "@/lib/providers";
import { publishBriefVersion } from "@/lib/storage/brief-repository";

import { productionBriefRuntime } from "./runtime";
import {
  BRIEF_MESSAGES,
  runBrief,
  type BriefLoadResult,
  type BriefRuntime,
} from "./run-brief";

const SAVE_FAILED = "This version could not be saved. Try again.";

type PublishBrief = (
  brief: Brief,
) => Promise<{ brief: Brief; saved: boolean }>;

export type BriefHttpOptions = {
  runtime?: BriefRuntime;
  publish?: PublishBrief;
  /** Set by the events route. The brief route reads `ca` from the query. */
  ca?: string;
};

export async function handleBriefGet(
  request: Request,
  options: BriefHttpOptions = {},
): Promise<Response> {
  const runtime = options.runtime ?? (await productionBriefRuntime());
  const query = readBriefQuery(new URL(request.url), options.ca);
  if (!query.ok) {
    return jsonResponse(
      { ok: false, code: "invalid", message: BRIEF_MESSAGES.invalid },
      400,
      runtime.requestId,
    );
  }

  const result = await runBrief(query.ca, query.period, runtime);
  if (!result.ok) return failureResponse(result, runtime.requestId);

  return jsonResponse(
    {
      ok: true,
      cache: result.cache,
      brief: result.brief,
    },
    200,
    runtime.requestId,
    result,
  );
}

/**
 * Saves a new public version at the moment of the request.
 * The market, site, and X account are read again, so the stored brief is
 * not the snapshot from the earlier token lookup.
 */
export async function handleBriefPost(
  request: Request,
  options: BriefHttpOptions = {},
): Promise<Response> {
  const runtime = options.runtime ?? (await productionBriefRuntime());
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const parsed = briefRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonResponse(
      { ok: false, code: "invalid", message: BRIEF_MESSAGES.invalid },
      400,
      runtime.requestId,
    );
  }

  const result = await runBrief(parsed.data.ca, parsed.data.period, runtime, {
    fresh: true,
  });
  if (!result.ok) return failureResponse(result, runtime.requestId);

  const published = await (options.publish ?? publishBriefVersion)(result.brief);
  if (!published.saved) {
    return jsonResponse(
      { ok: false, code: "unavailable", message: SAVE_FAILED },
      503,
      runtime.requestId,
      result,
    );
  }

  return jsonResponse(
    {
      ok: true,
      saved: true,
      sharePath: `/brief/${published.brief.shareId}`,
      cache: result.cache,
      brief: published.brief,
    },
    200,
    runtime.requestId,
    result,
  );
}

export async function handleEventsGet(
  request: Request,
  ca: string,
  options: BriefHttpOptions = {},
): Promise<Response> {
  const runtime = options.runtime ?? (await productionBriefRuntime());
  const query = readBriefQuery(new URL(request.url), ca);
  if (!query.ok) {
    return jsonResponse(
      { ok: false, code: "invalid", message: BRIEF_MESSAGES.invalid },
      400,
      runtime.requestId,
    );
  }

  const result = await runBrief(query.ca, query.period, runtime);
  if (!result.ok) return failureResponse(result, runtime.requestId);

  return jsonResponse(
    {
      ok: true,
      ca: result.brief.ca,
      period: result.brief.period,
      generatedAt: result.brief.generatedAt,
      cache: result.cache,
      events: result.brief.events,
    },
    200,
    runtime.requestId,
    result,
  );
}

/**
 * Latest price, market cap, liquidity, and volume for an open token page.
 * Uses the same market cache as a brief, without rebuilding the summary.
 */
export async function handleQuoteGet(
  _request: Request,
  ca: string,
  options: BriefHttpOptions = {},
): Promise<Response> {
  const runtime = options.runtime ?? (await productionBriefRuntime());
  const address = solanaAddressSchema.safeParse(ca);
  if (!address.success) {
    return jsonResponse(
      { ok: false, code: "invalid", message: "Enter a Solana contract address." },
      400,
      runtime.requestId,
    );
  }

  const logger = runtime.log;
  let rateLimit: RateLimitDecision;
  try {
    rateLimit = await consumeRateLimit(
      runtime.store,
      "quote",
      runtime.clientKey,
      QUOTE_RATE_LIMIT,
      runtime.now,
    );
  } catch (error) {
    logger?.error("quote.rate_limit_failed", {
      requestId: runtime.requestId,
      ca: address.data,
      message: error instanceof Error ? error.message : "Rate limit failed.",
    });
    rateLimit = {
      allowed: true,
      limit: QUOTE_RATE_LIMIT.limit,
      remaining: QUOTE_RATE_LIMIT.limit,
      retryAfterSeconds: 0,
    };
  }

  if (!rateLimit.allowed) {
    return jsonResponse(
      {
        ok: false,
        code: "rate_limited",
        message: "Too many price checks were requested from this network. Wait a minute and try again.",
      },
      429,
      runtime.requestId,
      {
        ok: false,
        code: "rate_limited",
        message: BRIEF_MESSAGES.rateLimited,
        rateLimit,
      },
    );
  }

  try {
    const market = await readThroughMarketCache(
      runtime.store,
      address.data,
      runtime.readMarket,
      logger,
    );
    const { priceUsd, marketCapUsd, liquidityUsd, volumeUsd, capturedAt } =
      market.result.snapshot;
    const headers = rateLimitHeaders(rateLimit);
    headers.set("x-request-id", runtime.requestId);
    headers.set("x-market-cache", market.cache);
    headers.set("cache-control", "no-store");
    return Response.json(
      {
        ok: true,
        ca: address.data,
        priceUsd,
        marketCapUsd,
        liquidityUsd,
        volumeUsd,
        capturedAt,
        cache: market.cache,
      },
      { status: 200, headers },
    );
  } catch (error) {
    const missed =
      error instanceof MarketUnavailableError &&
      error.causes.length > 0 &&
      error.causes.every((cause) => cause.code === "not_found");
    return jsonResponse(
      {
        ok: false,
        code: missed ? "not_found" : "unavailable",
        message: missed ? BRIEF_MESSAGES.notFound : BRIEF_MESSAGES.unavailable,
      },
      missed ? 404 : 503,
      runtime.requestId,
      {
        ok: false,
        code: missed ? "not_found" : "unavailable",
        message: missed ? BRIEF_MESSAGES.notFound : BRIEF_MESSAGES.unavailable,
        rateLimit,
      },
    );
  }
}

function readBriefQuery(
  url: URL,
  caOverride?: string,
): { ok: true; ca: string; period: BriefPeriod } | { ok: false } {
  const parsed = briefRequestSchema.safeParse({
    ca: caOverride ?? url.searchParams.get("ca") ?? "",
    period: url.searchParams.get("period") ?? "24h",
  });
  if (!parsed.success) return { ok: false };
  return { ok: true, ca: parsed.data.ca, period: parsed.data.period };
}

function failureResponse(result: BriefLoadResult & { ok: false }, requestId: string): Response {
  const status =
    result.code === "rate_limited" ? 429 : result.code === "not_found" ? 404 : 503;
  return jsonResponse(
    {
      ok: false,
      code: result.code,
      message: result.message,
      retryAfterSeconds: result.code === "rate_limited" ? result.rateLimit.retryAfterSeconds : undefined,
    },
    status,
    requestId,
    result,
  );
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  result?: BriefLoadResult,
): Response {
  const headers = result ? rateLimitHeaders(result.rateLimit) : new Headers();
  headers.set("x-request-id", requestId);
  if (result?.ok) headers.set("x-market-cache", result.cache);
  return Response.json(body, { status, headers });
}
