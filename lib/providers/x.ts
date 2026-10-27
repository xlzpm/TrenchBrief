import { solanaAddressSchema, xHandleSchema } from "../dto/common";
import { fetchFxProfilePosts } from "./fx-twitter";
import {
  hasCheckmark,
  isOfficialVerification,
  readAccountVerification,
  readIdentityFlag,
  readNonNegativeInt,
  type AccountVerification,
  type MentionCandidate,
} from "../brief/token-attention";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";
import { env, readServerSecret } from "../env";
import { ProviderError } from "./errors";
import { fetchWithRetry, getJson, PUBLIC_PAGE_USER_AGENT, type ProviderClientOptions } from "./http";
import { isRecord } from "./normalize";

const X_API = "https://api.x.com/2";

export type XPostOptions = ProviderClientOptions & {
  bearerToken?: string;
};

export type XPostQuery = {
  ca: string;
  handle: string;
  since: Date;
  maxResults?: number;
};

function bearerToken(explicit: string | undefined): string {
  if (explicit) return explicit;
  try {
    return readServerSecret("X_BEARER_TOKEN");
  } catch (error) {
    throw new ProviderError(
      error instanceof Error ? error.message : "Missing X bearer token.",
      {
        provider: "x",
        status: null,
        retryable: false,
        code: "config",
        cause: error,
      },
    );
  }
}

function xStartTime(since: Date, now: Date): Date {
  const sinceMs = since.getTime();
  if (Number.isNaN(sinceMs)) {
    throw new ProviderError("X post window start is invalid.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }
  const latestAllowed = now.getTime() - 15_000;
  return new Date(Math.min(sinceMs, latestAllowed));
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function postsFromBody(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body)) {
    throw new ProviderError("X returned an unexpected payload.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }
  if (!Array.isArray(body.data)) return [];
  return body.data.filter(isRecord);
}

export async function fetchXPosts(
  query: XPostQuery,
  options: XPostOptions = {},
): Promise<TimelineEvent[]> {
  const ca = solanaAddressSchema.parse(query.ca);
  const handle = xHandleSchema.parse(query.handle);
  const now = (options.now ?? (() => new Date()))();
  const start = xStartTime(query.since, now);
  const maxResults = Math.min(100, Math.max(5, query.maxResults ?? 10));
  const token = bearerToken(options.bearerToken);
  const headers = { authorization: `Bearer ${token}` };

  const userUrl = new URL(
    `${X_API}/users/by/username/${encodeURIComponent(handle)}`,
  );
  userUrl.searchParams.set(
    "user.fields",
    "username,public_metrics,verified_type,is_identity_verified,verified_followers_count",
  );
  const userBody = await getJson(
    userUrl.toString(),
    { headers },
    { ...options, provider: "x" },
  );
  if (!isRecord(userBody) || !isRecord(userBody.data)) {
    throw new ProviderError("X did not return a user for this handle.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "not_found",
    });
  }
  const userId = userBody.data.id;
  const username = userBody.data.username;
  if (typeof userId !== "string" || !/^[0-9]{1,19}$/.test(userId)) {
    throw new ProviderError("X returned an invalid user id.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }
  const parsedAccount = xHandleSchema.safeParse(username);
  if (!parsedAccount.success) {
    throw new ProviderError("X returned an invalid username.", {
      provider: "x",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }
  const account = parsedAccount.data;
  const userMetrics = isRecord(userBody.data.public_metrics) ? userBody.data.public_metrics : {};
  const accountFollowers = readNonNegativeInt(userMetrics.followers_count);
  const accountVerification = readAccountVerification(userBody.data.verified_type);
  const accountIdentity = readIdentityFlag(userBody.data.is_identity_verified);
  const accountVerifiedFollowers = readNonNegativeInt(userBody.data.verified_followers_count);
  const tweetsUrl = new URL(`${X_API}/users/${userId}/tweets`);
  tweetsUrl.searchParams.set("max_results", String(maxResults));
  tweetsUrl.searchParams.set("tweet.fields", "created_at,text,public_metrics");
  // Retweets are not posts written by this account. Replies stay because
  // project accounts often publish updates as replies.
  tweetsUrl.searchParams.set("exclude", "retweets");
  tweetsUrl.searchParams.set(
    "start_time",
    start.toISOString().replace(/\.\d{3}Z$/, "Z"),
  );
  const tweetsBody = await getJson(
    tweetsUrl.toString(),
    { headers },
    { ...options, provider: "x" },
  );

  const sinceMs = query.since.getTime();
  const events: TimelineEvent[] = [];
  for (const post of postsFromBody(tweetsBody)) {
    if (typeof post.id !== "string" || typeof post.text !== "string" || typeof post.created_at !== "string") {
      continue;
    }
    const occurredMs = Date.parse(post.created_at);
    if (Number.isNaN(occurredMs) || occurredMs < sinceMs) continue;
    const metrics = isRecord(post.public_metrics) ? post.public_metrics : {};
    const event = xPostEvent({
      ca,
      account,
      postId: post.id,
      occurredAtMs: occurredMs,
      text: post.text,
      followers: accountFollowers,
      likes: readNonNegativeInt(metrics.like_count),
      verification: accountVerification,
      identityVerified: accountIdentity,
      verifiedFollowers: accountVerifiedFollowers,
    });
    if (event) events.push(event);
  }
  return events;
}

const PROFILE_DIRECT_TIMEOUT_MS = 4_000;
const PROFILE_MIRROR_TIMEOUT_MS = 8_000;
const TWEET_MARK =
  /rest_id\\":\\"(\d+)\\",\\"result\\":\{\\"__isTweetResult\\":\\"Tweet\\"/g;

export type DocumentTweet = {
  id: string;
  account: string;
  text: string;
  occurredAtMs: number;
  followers: number | null;
  verification: AccountVerification | null;
  identityVerified: boolean | null;
  verifiedFollowers: number | null;
};

export function tweetsFromDocument(html: string): DocumentTweet[] {
  const marks = [...html.matchAll(TWEET_MARK)];
  const posts: DocumentTweet[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const id = mark?.[1];
    const start = mark?.index ?? 0;
    if (!id || seen.has(id)) continue;
    const end = marks[index + 1]?.index ?? start + 20_000;
    const block = html.slice(start, end);
    const screen = /screen_name\\":\\"([A-Za-z0-9_]{1,15})\\"/.exec(block);
    const created = /created_at_ms\\":(\d{10,16})/.exec(block);
    const textMatch = /full_text\\":\\"([\s\S]*?)\\",\\"hashtag_entities\\"/.exec(block);
    const followersMatch = /(?<![A-Za-z_])followers_count\\":(\d+)/.exec(block);
    const verifiedFollowersMatch = /verified_followers_count\\":(\d+)/.exec(block);
    const identityMatch = /is_identity_verified\\":(true|false)/.exec(block);
    const verifiedMatch = /verified_type\\?":\\?"([A-Za-z]+)\\?"/.exec(block);
    if (!screen?.[1] || !created || !textMatch) continue;
    const text = unescapeProfileText(textMatch[1] ?? "");
    const occurredAtMs = Number(created[1]);
    const followers = followersMatch ? Number(followersMatch[1]) : null;
    if (!text || !Number.isFinite(occurredAtMs)) continue;
    seen.add(id);
    posts.push({
      id,
      account: screen[1],
      text,
      occurredAtMs,
      followers: followers != null && Number.isFinite(followers) ? followers : null,
      verification: readAccountVerification(verifiedMatch?.[1]),
      identityVerified: identityMatch?.[1] === "true" ? true : identityMatch?.[1] === "false" ? false : null,
      verifiedFollowers: verifiedFollowersMatch ? Number(verifiedFollowersMatch[1]) : null,
    });
    if (posts.length === 40) break;
  }
  return posts;
}

export function postsFromProfileDocument(
  html: string,
  handle: string,
): Array<{ id: string; text: string; occurredAtMs: number }> {
  const wanted = handle.toLowerCase();
  const posts: Array<{ id: string; text: string; occurredAtMs: number }> = [];
  for (const tweet of tweetsFromDocument(html)) {
    if (tweet.account.toLowerCase() !== wanted) continue;
    posts.push({
      id: tweet.id,
      text: tweet.text,
      occurredAtMs: tweet.occurredAtMs,
    });
    if (posts.length === 20) break;
  }
  return posts;
}

export async function fetchLinkedXPosts(
  query: XPostQuery,
  options: XPostOptions = {},
): Promise<TimelineEvent[]> {
  if (options.bearerToken || env.X_BEARER_TOKEN) {
    try {
      return await fetchXPosts(query, {
        ...options,
        attempts: options.attempts ?? 1,
        timeoutMs: options.timeoutMs ?? PROFILE_DIRECT_TIMEOUT_MS,
      });
    } catch (error) {
      if (!canReadPublicProfile(error)) throw error;
    }
  }
  const fromFx = eventsFromCandidates(
    await fetchFxProfilePosts(query.handle, options),
    solanaAddressSchema.parse(query.ca),
    xHandleSchema.parse(query.handle),
    query.since,
  );
  if (fromFx.length > 0) return fromFx;
  return fetchPublicXPosts(query, options);
}

function eventsFromCandidates(
  posts: readonly MentionCandidate[],
  ca: string,
  handle: string,
  since: Date,
): TimelineEvent[] {
  const sinceMs = since.getTime();
  const events: TimelineEvent[] = [];
  for (const post of posts) {
    if (post.username.toLowerCase() !== handle.toLowerCase()) continue;
    const at = Date.parse(post.createdAt);
    if (Number.isNaN(at) || at < sinceMs) continue;
    const event = xPostEvent({
      ca,
      account: handle,
      postId: post.id,
      occurredAtMs: at,
      text: post.text,
      followers: post.followers,
      likes: post.likes,
      verification: post.verification,
      identityVerified: post.identityVerified,
      verifiedFollowers: post.verifiedFollowers,
    });
    if (event) events.push(event);
  }
  return events;
}

function xPostEvent(input: {
  ca: string;
  account: string;
  postId: string;
  occurredAtMs: number;
  text: string;
  followers?: number | null;
  likes?: number | null;
  verification?: AccountVerification | null;
  identityVerified?: boolean | null;
  verifiedFollowers?: number | null;
}): TimelineEvent | null {
  if (!/^[0-9]+$/.test(input.postId)) return null;
  const textExcerpt = excerpt(input.text);
  if (!textExcerpt) return null;
  const account = xHandleSchema.parse(input.account);
  const verification = input.verification ?? null;
  const postUrl = `https://x.com/${account}/status/${input.postId}`;
  return parseTimelineEvent({
    id: `x:${input.postId}`,
    ca: input.ca,
    kind: "x_post",
    occurredAt: new Date(input.occurredAtMs).toISOString(),
    title: `New post from @${account}`,
    evidence: [
      {
        id: `x:${input.postId}`,
        source: "x",
        url: postUrl,
        label: `Post by @${account}`,
      },
    ],
    account,
    postId: input.postId,
    postUrl,
    textExcerpt,
    followers: input.followers ?? null,
    likes: input.likes ?? null,
    verification: isOfficialVerification(verification) ? verification : null,
    checked: hasCheckmark(verification),
    identityVerified: input.identityVerified ?? null,
    verifiedFollowers: input.verifiedFollowers ?? null,
    about: textExcerpt.includes(input.ca) ? "contract" : "account",
  });
}

async function fetchPublicXPosts(
  query: XPostQuery,
  options: XPostOptions,
): Promise<TimelineEvent[]> {
  const handle = xHandleSchema.parse(query.handle);
  const ca = solanaAddressSchema.parse(query.ca);
  const sources: Array<{
    url: string;
    timeoutMs: number;
    headers: Record<string, string>;
  }> = [
    {
      url: `https://x.com/${handle}`,
      timeoutMs: PROFILE_DIRECT_TIMEOUT_MS,
      headers: { "user-agent": PUBLIC_PAGE_USER_AGENT },
    },
    {
      url: `https://r.jina.ai/https://x.com/${handle}`,
      timeoutMs: PROFILE_MIRROR_TIMEOUT_MS,
      headers: {
        "user-agent": PUBLIC_PAGE_USER_AGENT,
        "x-return-format": "html",
      },
    },
  ];

  return new Promise((resolve) => {
    let open = sources.length;
    let settled = false;
    const finish = (events: TimelineEvent[]) => {
      if (settled) return;
      if (events.length > 0 || open === 1) {
        settled = true;
        resolve(events);
        return;
      }
      open -= 1;
    };

    for (const source of sources) {
      readProfile(source.url, source.headers, source.timeoutMs, options)
        .then((html) => finish(eventsFromProfile(html, ca, handle, query.since)))
        .catch(() => finish([]));
    }
  });
}

function eventsFromProfile(
  html: string,
  ca: string,
  handle: string,
  since: Date,
): TimelineEvent[] {
  const sinceMs = since.getTime();
  const events: TimelineEvent[] = [];
  for (const post of postsFromProfileDocument(html, handle)) {
    if (post.occurredAtMs < sinceMs) continue;
    const event = xPostEvent({
      ca,
      account: handle,
      postId: post.id,
      occurredAtMs: post.occurredAtMs,
      text: post.text,
    });
    if (event) events.push(event);
  }
  return events;
}

async function readProfile(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  options: XPostOptions,
): Promise<string> {
  const response = await fetchWithRetry(
    url,
    { method: "GET", headers },
    { ...options, provider: "x", attempts: 1, timeoutMs },
  );
  return response.text();
}

function canReadPublicProfile(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.code === "network" || error.code === "config") return true;
  return error.status === 401 || error.status === 403 || error.status === 429;
}

function unescapeProfileText(value: string): string {
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = JSON.parse(`"${text}"`);
      if (typeof next !== "string" || next === text) break;
      text = next;
    } catch {
      break;
    }
  }
  return text;
}
