import {
  isOfficialVerification,
  publicMentionQueries,
  readAccountVerification,
  readIdentityFlag,
  readNonNegativeInt,
} from "../brief/token-attention";
import type { AccountVerification, MentionCandidate } from "../brief/token-attention";
import { fetchWithRetry, PUBLIC_PAGE_USER_AGENT, type ProviderClientOptions } from "./http";
import { isRecord } from "./normalize";

const FX_API = "https://api.fxtwitter.com";
const FX_TIMEOUT_MS = 8_000;

/**
 * Public posts from FxTwitter. X's own search page is a login wall, so this
 * is the path that still returns a post, its time, its author, followers, and
 * often like counts.
 */
export async function fetchFxMentionPosts(
  ca: string,
  symbol: string,
  options: ProviderClientOptions,
): Promise<MentionCandidate[]> {
  const posts: MentionCandidate[] = [];
  await Promise.all(
    publicMentionQueries(ca, symbol).map(async (query) => {
      const url = new URL(`${FX_API}/2/search`);
      url.searchParams.set("q", query.replace(/ -is:retweet$/, ""));
      url.searchParams.set("feed", "latest");
      url.searchParams.set("count", "30");
      posts.push(...(await readFxPosts(url.toString(), options)));
    }),
  );
  return posts;
}

export async function fetchFxProfilePosts(
  handle: string,
  options: ProviderClientOptions,
): Promise<MentionCandidate[]> {
  const url = new URL(`${FX_API}/2/profile/${encodeURIComponent(handle)}/statuses`);
  url.searchParams.set("count", "20");
  return readFxPosts(url.toString(), options);
}

export function mentionsFromFxBody(body: unknown): MentionCandidate[] {
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const posts: MentionCandidate[] = [];
  for (const row of body.results) {
    if (!isRecord(row) || row.type !== "status" || row.reposted_by != null) continue;
    const author = isRecord(row.author) ? row.author : null;
    if (!author || typeof author.screen_name !== "string") continue;
    if (typeof row.id !== "string" || typeof row.text !== "string") continue;
    const verification = fxVerification(author);
    const followers = readNonNegativeInt(author.followers);
    const official = isOfficialVerification(verification);
    if (followers == null && !official) continue;
    const identityVerified =
      readIdentityFlag(author.is_identity_verified) ??
      readIdentityFlag(isRecord(author.verification) ? author.verification.is_identity_verified : null);
    const at = fxTime(row);
    if (at == null) continue;
    posts.push({
      id: row.id,
      text: row.text,
      createdAt: new Date(at).toISOString(),
      username: author.screen_name,
      followers,
      likes: fxLikes(row),
      verification,
      identityVerified,
      verifiedFollowers:
        readNonNegativeInt(author.verified_followers_count) ??
        readNonNegativeInt(author.verified_followers),
    });
  }
  return posts;
}

async function readFxPosts(url: string, options: ProviderClientOptions): Promise<MentionCandidate[]> {
  try {
    const response = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": PUBLIC_PAGE_USER_AGENT,
        },
      },
      {
        ...options,
        provider: "x",
        attempts: 1,
        timeoutMs: options.timeoutMs ?? FX_TIMEOUT_MS,
        acceptStatus: (status) => status === 200 || status === 404,
      },
    );
    if (response.status === 404) {
      await response.text();
      return [];
    }
    const text = await response.text();
    if (!text.trim()) return [];
    return mentionsFromFxBody(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

function fxTime(row: Record<string, unknown>): number | null {
  const stamp = row.created_timestamp;
  if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) {
    return stamp < 1_000_000_000_000 ? stamp * 1000 : stamp;
  }
  if (typeof row.created_at === "string") {
    const parsed = Date.parse(row.created_at);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function fxVerification(author: Record<string, unknown>): AccountVerification | null {
  const verification = isRecord(author.verification) ? author.verification : null;
  if (verification) {
    const fromType = readAccountVerification(verification.type);
    if (fromType) return fromType;
  }
  return readAccountVerification(author.verified_type);
}

function fxLikes(row: Record<string, unknown>): number | null {
  return (
    readNonNegativeInt(row.favorite_count) ??
    readNonNegativeInt(row.likes) ??
    readNonNegativeInt(row.favorites)
  );
}
