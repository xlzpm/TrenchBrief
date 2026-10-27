import { xSearchUrl } from "../brief/post-links";
import {
  isOfficialVerification,
  publicMentionQueries,
  readAccountVerification,
  readIdentityFlag,
  readNonNegativeInt,
  selectTokenMentions,
  mentionSearchQuery,
  type AccountVerification,
  type MentionCandidate,
} from "../brief/token-attention";
import { solanaAddressSchema } from "../dto/common";
import type { TimelineEvent } from "../dto/event";
import { env, readServerSecret } from "../env";
import { ProviderError } from "./errors";
import { fetchWithRetry, getJson, PUBLIC_PAGE_USER_AGENT, type ProviderClientOptions } from "./http";
import { isRecord } from "./normalize";
import { fetchFxMentionPosts } from "./fx-twitter";
import { tweetsFromDocument, type XPostOptions } from "./x";

const X_API = "https://api.x.com/2";
const SEARCH_TIMEOUT_MS = 8_000;
const PUBLIC_DIRECT_TIMEOUT_MS = 4_000;

export type TokenMentionQuery = {
  ca: string;
  symbol: string;
  since: Date;
};

/**
 * Posts from other accounts that name this mint or its ticker.
 * The X recent search is used when a bearer token is set. FxTwitter search
 * is the public fallback, then the X search page. Only posts whose audience
 * is known are kept.
 */
type MentionOptions = Omit<XPostOptions, "bearerToken"> & {
  bearerToken?: string | null;
};

export async function fetchTokenMentions(
  query: TokenMentionQuery,
  options: MentionOptions = {},
): Promise<TimelineEvent[]> {
  const ca = solanaAddressSchema.parse(query.ca);
  const token = bearer(options.bearerToken);
  if (token) {
    try {
      return await fetchRecentMentions(ca, query, token, options);
    } catch (error) {
      if (!canSearchPublicly(error)) throw error;
    }
  }
  return fetchPublicMentions(ca, query, options);
}

async function fetchRecentMentions(
  ca: string,
  query: TokenMentionQuery,
  token: string,
  options: ProviderClientOptions,
): Promise<TimelineEvent[]> {
  const now = (options.now ?? (() => new Date()))();
  const start = searchStart(query.since, now);
  const url = new URL(`${X_API}/tweets/search/recent`);
  url.searchParams.set("query", mentionSearchQuery(ca, query.symbol));
  url.searchParams.set("max_results", "50");
  url.searchParams.set("tweet.fields", "created_at,text,author_id,public_metrics");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set(
    "user.fields",
    "username,public_metrics,verified_type,is_identity_verified,verified_followers_count",
  );
  url.searchParams.set("start_time", start.toISOString().replace(/\.\d{3}Z$/, "Z"));

  const body = await getJson(
    url.toString(),
    { headers: { authorization: `Bearer ${token}` } },
    { ...options, provider: "x", attempts: options.attempts ?? 1, timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS },
  );
  return selectTokenMentions({
    ca,
    symbol: query.symbol,
    sinceMs: query.since.getTime(),
    posts: candidatesFromSearch(body),
  });
}

function candidatesFromSearch(body: unknown): MentionCandidate[] {
  if (!isRecord(body)) {
    throw new ProviderError("X search returned an unexpected payload.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }
  const users = new Map<
    string,
    {
      username: string;
      followers: number | null;
      verification: AccountVerification | null;
      identityVerified: boolean | null;
      verifiedFollowers: number | null;
    }
  >();
  const includes = isRecord(body.includes) ? body.includes : {};
  if (Array.isArray(includes.users)) {
    for (const user of includes.users) {
      if (!isRecord(user) || typeof user.id !== "string" || typeof user.username !== "string") {
        continue;
      }
      const metrics = isRecord(user.public_metrics) ? user.public_metrics : {};
      const followers = readNonNegativeInt(metrics.followers_count);
      const verification = readAccountVerification(user.verified_type);
      const official = isOfficialVerification(verification);
      if (followers == null && !official) continue;
      users.set(user.id, {
        username: user.username,
        followers,
        verification,
        identityVerified: readIdentityFlag(user.is_identity_verified),
        verifiedFollowers: readNonNegativeInt(user.verified_followers_count),
      });
    }
  }
  if (!Array.isArray(body.data)) return [];
  const posts: MentionCandidate[] = [];
  for (const tweet of body.data) {
    if (!isRecord(tweet)) continue;
    if (typeof tweet.id !== "string" || typeof tweet.text !== "string") continue;
    if (typeof tweet.created_at !== "string" || typeof tweet.author_id !== "string") continue;
    const author = users.get(tweet.author_id);
    if (!author) continue;
    const metrics = isRecord(tweet.public_metrics) ? tweet.public_metrics : {};
    const likes = readNonNegativeInt(metrics.like_count);
    posts.push({
      id: tweet.id,
      text: tweet.text,
      createdAt: tweet.created_at,
      username: author.username,
      followers: author.followers,
      likes,
      verification: author.verification,
      identityVerified: author.identityVerified,
      verifiedFollowers: author.verifiedFollowers,
    });
  }
  return posts;
}

async function fetchPublicMentions(
  ca: string,
  query: TokenMentionQuery,
  options: ProviderClientOptions,
): Promise<TimelineEvent[]> {
  const fromFx = await fetchFxMentionPosts(ca, query.symbol, options);
  if (fromFx.length > 0) {
    return selectTokenMentions({
      ca,
      symbol: query.symbol,
      sinceMs: query.since.getTime(),
      posts: fromFx,
    });
  }

  const sources = publicMentionQueries(ca, query.symbol).flatMap((q) => {
    const direct = xSearchUrl(q);
    return [
      { url: direct, timeoutMs: PUBLIC_DIRECT_TIMEOUT_MS },
      { url: `https://r.jina.ai/${direct}`, timeoutMs: SEARCH_TIMEOUT_MS },
    ];
  });

  const htmls = await Promise.all(
    sources.map(async (source) => {
      try {
        const response = await fetchWithRetry(
          source.url,
          {
            method: "GET",
            headers: {
              "user-agent": PUBLIC_PAGE_USER_AGENT,
              accept: "text/html",
            },
          },
          { ...options, provider: "x", attempts: 1, timeoutMs: source.timeoutMs },
        );
        return response.text();
      } catch {
        return "";
      }
    }),
  );

  const posts: MentionCandidate[] = [];
  for (const html of htmls) {
    for (const tweet of tweetsFromDocument(html)) {
      const official = isOfficialVerification(tweet.verification);
      if (tweet.followers == null && !official) continue;
      posts.push({
        id: tweet.id,
        text: tweet.text,
        createdAt: new Date(tweet.occurredAtMs).toISOString(),
        username: tweet.account,
        followers: tweet.followers,
        likes: null,
        verification: tweet.verification,
        identityVerified: tweet.identityVerified,
        verifiedFollowers: tweet.verifiedFollowers,
      });
    }
  }
  return selectTokenMentions({
    ca,
    symbol: query.symbol,
    sinceMs: query.since.getTime(),
    posts,
  });
}

function bearer(explicit: string | null | undefined): string | null {
  if (explicit === null) return null;
  if (explicit) return explicit;
  if (!env.X_BEARER_TOKEN) return null;
  try {
    return readServerSecret("X_BEARER_TOKEN");
  } catch {
    return null;
  }
}

function searchStart(since: Date, now: Date): Date {
  const sinceMs = since.getTime();
  if (Number.isNaN(sinceMs)) {
    throw new ProviderError("X mention window start is invalid.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }
  return new Date(Math.min(sinceMs, now.getTime() - 15_000));
}

function canSearchPublicly(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.code === "network" || error.code === "config") return true;
  return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 429;
}
