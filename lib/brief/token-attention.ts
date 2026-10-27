import { solanaAddressSchema, xHandleSchema } from "../dto/common";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";

/** Used to call out the largest accounts in the trading read. */
export const TICKER_FOLLOWERS = 10_000;
/** Mentions from other accounts need visible engagement. */
export const MENTION_LIKES_MIN = 100;
export const MENTION_LIMIT = 12;
/** Audience size that counts toward source strength. */
export const SOURCE_FOLLOWERS_MIN = 15_000;
/** Verified audience that counts toward source strength. */
export const SOURCE_VERIFIED_FOLLOWERS_MIN = 1_000;

/**
 * Check carried by the account. `business` is the gold organization check
 * (FxTwitter calls that `organization`). `blue` is a paid Premium check and
 * does not make the account an official source.
 */
export type AccountVerification = "business" | "government" | "blue" | "none";

export function readAccountVerification(value: unknown): AccountVerification | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "business":
    case "organization":
      return "business";
    case "government":
      return "government";
    case "blue":
    case "individual":
      return "blue";
    case "none":
      return "none";
    default:
      return null;
  }
}

export function readNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readIdentityFlag(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

export function hasCheckmark(verification: AccountVerification | null): boolean {
  return verification === "business" || verification === "government" || verification === "blue";
}

export function isOfficialVerification(
  verification: AccountVerification | null | undefined,
): verification is "business" | "government" {
  return verification === "business" || verification === "government";
}

export type SourceSignals = {
  verification?: AccountVerification | null;
  /** Set when a blue check was recorded separately from an official check. */
  checked?: boolean;
  followers: number | null;
  identityVerified: boolean | null;
  verifiedFollowers: number | null;
};

function sourceMarks(input: SourceSignals): string[] {
  const marks: string[] = [];
  if (input.checked === true || hasCheckmark(input.verification ?? null)) marks.push("check");
  if (input.followers != null && input.followers > SOURCE_FOLLOWERS_MIN) {
    marks.push("15k+ followers");
  }
  if (input.identityVerified === true) marks.push("ID verified");
  if (
    input.verifiedFollowers != null &&
    input.verifiedFollowers > SOURCE_VERIFIED_FOLLOWERS_MIN
  ) {
    marks.push("1k+ verified followers");
  }
  return marks;
}

export function sourceStrength(input: SourceSignals): number {
  return sourceMarks(input).length;
}

export function sourceStrengthLabel(input: SourceSignals): string | null {
  const marks = sourceMarks(input);
  if (marks.length === 0) return null;
  return `Source strength ${marks.length}/4: ${marks.join(", ")}`;
}

/**
 * Business and government checks are official. A checkmark plus the three
 * audience signals is a strong source. Every other post needs 100 likes.
 */
export function isOfficialSource(input: {
  verification: AccountVerification | null;
  likes: number | null;
  followers?: number | null;
  identityVerified?: boolean | null;
  verifiedFollowers?: number | null;
}): boolean {
  if (isOfficialVerification(input.verification)) return true;
  if (
    sourceStrength({
      verification: input.verification,
      followers: input.followers ?? null,
      identityVerified: input.identityVerified ?? null,
      verifiedFollowers: input.verifiedFollowers ?? null,
    }) === 4
  ) {
    return true;
  }
  return (
    typeof input.likes === "number" &&
    Number.isInteger(input.likes) &&
    input.likes >= MENTION_LIKES_MIN
  );
}

const GENERIC_TICKERS = new Set([
  "SOL",
  "ETH",
  "BTC",
  "USDC",
  "USDT",
  "USD",
  "USD1",
  "AI",
  "THE",
  "AND",
  "FOR",
  "YOU",
  "NEW",
  "MEME",
  "COIN",
  "TOKEN",
  "PUMP",
  "TEST",
  "MOON",
  "PEPE",
  "BONK",
  "WIF",
  "TRUMP",
  "DOGE",
]);

export type MentionCandidate = {
  id: string;
  text: string;
  createdAt: string;
  username: string;
  followers: number | null;
  likes: number | null;
  verification: AccountVerification | null;
  identityVerified: boolean | null;
  verifiedFollowers: number | null;
};

/** Cashtag for a specific ticker. Generic and major symbols are left out. */
export function cashtagForSymbol(symbol: string): string | null {
  const clean = symbol.trim().replace(/^\$+/, "");
  if (!/^[A-Za-z][A-Za-z0-9]{2,9}$/.test(clean)) return null;
  if (GENERIC_TICKERS.has(clean.toUpperCase())) return null;
  return `$${clean}`;
}

/** Recent-search query: the mint, plus the cashtag when the symbol is specific. */
export function mentionSearchQuery(ca: string, symbol: string): string {
  const address = solanaAddressSchema.parse(ca);
  const quoted = `"${address}"`;
  const tag = cashtagForSymbol(symbol);
  const body = tag ? `(${quoted} OR ${tag})` : quoted;
  return `${body} -is:retweet`;
}

/**
 * Public search pages return a short slice, so the mint and the cashtag
 * are queried separately. Generic symbols stay off the cashtag query.
 */
export function publicMentionQueries(ca: string, symbol: string): string[] {
  const address = solanaAddressSchema.parse(ca);
  const queries = [`"${address}" -is:retweet`];
  const tag = cashtagForSymbol(symbol);
  if (tag) queries.push(`${tag} -is:retweet`);
  return queries;
}

/**
 * Labels a linked-account post when it names the mint, the cashtag, or the
 * token name. A post that names none of those is still a new account post.
 */
export function linkedPostSubject(input: {
  text: string;
  ca: string;
  symbol: string;
  name: string;
}): "contract" | "ticker" | "account" | null {
  const ca = solanaAddressSchema.parse(input.ca);
  const about = classifyMention(input.text, ca, cashtagForSymbol(input.symbol));
  if (about) return about;
  return namesToken(input.text, input.name) ? "account" : null;
}

/**
 * Keeps posts that name this mint or its ticker. A business or government
 * check is enough on its own. A checkmark with more than 15k followers,
 * identity verification, and more than 1k verified followers is a strong
 * source. Every other post needs at least 100 likes. Strongest first,
 * then newest and largest, capped to the timeline.
 */
export function selectTokenMentions(input: {
  ca: string;
  symbol: string;
  sinceMs: number;
  posts: readonly MentionCandidate[];
}): TimelineEvent[] {
  const ca = solanaAddressSchema.parse(input.ca);
  const tag = cashtagForSymbol(input.symbol);
  const ranked: Array<{ event: TimelineEvent; strength: number; followers: number; at: number }> = [];
  const seen = new Set<string>();

  for (const post of input.posts) {
    if (!/^[0-9]+$/.test(post.id) || seen.has(post.id)) continue;
    const account = xHandleSchema.safeParse(post.username);
    if (!account.success) continue;
    if (post.followers != null && (!Number.isInteger(post.followers) || post.followers < 0)) {
      continue;
    }
    const likes = post.likes;
    const officialCheck = isOfficialVerification(post.verification);
    const signals = {
      verification: post.verification,
      followers: post.followers,
      identityVerified: post.identityVerified,
      verifiedFollowers: post.verifiedFollowers,
    };
    if (!isOfficialSource({ ...signals, likes })) continue;
    const text = post.text.replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("RT @")) continue;
    const at = Date.parse(post.createdAt);
    if (Number.isNaN(at) || at <= input.sinceMs) continue;
    const about = classifyMention(text, ca, tag);
    if (!about) continue;
    const recordedLikes =
      typeof likes === "number" && Number.isInteger(likes) && likes >= 0 ? likes : null;

    const postUrl = `https://x.com/${account.data}/status/${post.id}`;
    seen.add(post.id);
    ranked.push({
      strength: sourceStrength(signals),
      followers: post.followers ?? -1,
      at,
      event: parseTimelineEvent({
        id: `x:${post.id}`,
        ca,
        kind: "x_post",
        occurredAt: new Date(at).toISOString(),
        title:
          about === "contract"
            ? `Call from @${account.data}`
            : `Ticker mention from @${account.data}`,
        evidence: [
          {
            id: `x:${post.id}`,
            source: "x",
            url: postUrl,
            label: `Post by @${account.data}`,
          },
        ],
        account: account.data,
        postId: post.id,
        postUrl,
        textExcerpt: text.slice(0, 500),
        followers: post.followers,
        likes: recordedLikes,
        verification: officialCheck ? post.verification : null,
        checked: hasCheckmark(post.verification),
        identityVerified: post.identityVerified,
        verifiedFollowers: post.verifiedFollowers,
        about,
      }),
    });
  }

  ranked.sort(
    (left, right) =>
      right.strength - left.strength ||
      right.followers - left.followers ||
      right.at - left.at ||
      (left.event.id < right.event.id ? -1 : 1),
  );
  return ranked.slice(0, MENTION_LIMIT).map((item) => item.event);
}

function classifyMention(
  text: string,
  ca: string,
  tag: string | null,
): "contract" | "ticker" | null {
  if (text.includes(ca)) return "contract";
  if (tag && hasCashtag(text, tag)) return "ticker";
  return null;
}

function hasCashtag(text: string, tag: string): boolean {
  return new RegExp(`${escapeRegExp(tag)}(?![A-Za-z0-9])`, "i").test(text);
}

function namesToken(text: string, name: string): boolean {
  const clean = name.trim();
  if (clean.length < 4 || GENERIC_TICKERS.has(clean.toUpperCase())) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(clean)}(?=$|[^A-Za-z0-9])`, "i").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
