import { z } from "zod";

import type { KvStore } from "@/lib/cache/store";
import { contentHashSchema, isoDateTimeSchema, type BriefPeriod } from "@/lib/dto/common";
import { linkedPostSubject, sourceStrength } from "@/lib/brief/token-attention";
import { parseTimelineEvent, timelineEventSchema, type TimelineEvent } from "@/lib/dto/event";
import type { TokenSnapshot } from "@/lib/dto/token-snapshot";
import { PERIOD_MS } from "@/lib/analysis";
import { errorFields, type Logger } from "@/lib/observability/log";
import {
  checkWebsite as fetchWebsite,
  fetchDexOrders,
  fetchLinkedXPosts,
  fetchTokenMentions,
  type DexOrderQuery,
  type TokenMentionQuery,
  type WebsiteBaseline,
  type WebsiteMonitorOptions,
  type XPostOptions,
} from "@/lib/providers";

const WEBSITE_STATE_TTL_SECONDS = 48 * 60 * 60;
const WEBSITE_RECHECK_MS = 60_000;
const POST_CACHE_TTL_SECONDS = 60;

const storedWebsiteSchema = z.object({
  url: z.url(),
  contentHash: contentHashSchema,
  textHash: contentHashSchema.nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  checkedAt: isoDateTimeSchema,
  changes: z.array(timelineEventSchema),
});

type StoredWebsite = z.infer<typeof storedWebsiteSchema>;

export type WebsiteBaselineNote = {
  url: string;
  observedAt: string;
};

export type LinkedActivity = {
  posts: TimelineEvent[];
  websiteChanges: TimelineEvent[];
  listings: TimelineEvent[];
  /** Set when this read stored the first copy of the token website. */
  websiteBaseline?: WebsiteBaselineNote | null;
};

type ActivityInput = {
  snapshot: TokenSnapshot;
  period: BriefPeriod;
  windowEnd: Date;
  store: KvStore;
  logger: Logger;
  now?: () => Date;
  checkWebsite?: typeof fetchWebsite;
  websiteOptions?: WebsiteMonitorOptions;
  recheckMs?: number;
  readPosts?: typeof fetchLinkedXPosts;
  readMentions?: (query: TokenMentionQuery, options?: XPostOptions) => Promise<TimelineEvent[]>;
  readListings?: (query: DexOrderQuery) => Promise<TimelineEvent[]>;
  /** Skip the post cache and the website recheck delay. */
  fresh?: boolean;
};

/**
 * Website updates need a stored baseline. The first successful read records
 * the page and does not invent a change. Later reads report what changed
 * and keep those events for the longest brief window.
 * Every new post from the linked account is kept. Posts that name this mint,
 * its ticker, or the token name are labeled; the rest stay as account posts.
 * Mentions are posts from other accounts that name this mint or ticker.
 * Listings are paid DexScreener orders for this mint.
 */
export async function readLinkedActivity(input: ActivityInput): Promise<LinkedActivity> {
  const [ownPosts, mentions, website, listings] = await Promise.all([
    readPosts(input),
    readMentions(input),
    readWebsiteChanges(input),
    readListings(input),
  ]);
  return {
    posts: mergePosts(ownPosts, mentions),
    websiteChanges: website.changes,
    listings,
    websiteBaseline: website.baseline,
  };
}

async function readPosts(input: ActivityInput): Promise<TimelineEvent[]> {
  const handle = input.snapshot.socials.xHandle;
  if (!handle) return [];
  const capturedAt = Date.parse(input.snapshot.capturedAt);
  if (Number.isNaN(capturedAt)) return [];
  const since = new Date(input.windowEnd.getTime() - PERIOD_MS[input.period]);
  const load = input.readPosts ?? fetchLinkedXPosts;
  const events = await loadCached(input, {
    key: `x-posts:v3:${input.snapshot.ca}:${handle.toLowerCase()}:${input.period}`,
    kind: "x_post",
    fail: "x.posts_failed",
    cacheFail: "x.cache_write_failed",
    log: { handle },
    load: () => load({ ca: input.snapshot.ca, handle, since }),
  });
  return postsAboutThisToken(events, input.snapshot);
}

function postsAboutThisToken(
  events: readonly TimelineEvent[],
  snapshot: TokenSnapshot,
): TimelineEvent[] {
  const kept: TimelineEvent[] = [];
  for (const event of events) {
    if (event.kind !== "x_post") continue;
    const subject = linkedPostSubject({
      text: event.textExcerpt,
      ca: snapshot.ca,
      symbol: snapshot.symbol,
      name: snapshot.name,
    });
    const about = subject ?? "account";
    kept.push(
      parseTimelineEvent({
        ...event,
        about,
        title: linkedPostTitle(event.account, about, snapshot.symbol, subject != null),
      }),
    );
  }
  return kept;
}

function linkedPostTitle(
  account: string,
  about: "contract" | "ticker" | "account",
  symbol: string,
  namesToken: boolean,
): string {
  if (about === "contract") return `@${account} posted this contract`;
  if (about === "ticker") return `@${account} posted this ticker`;
  if (namesToken) return `@${account} posted about ${symbol}`;
  return `@${account} posted`;
}

async function readMentions(input: ActivityInput): Promise<TimelineEvent[]> {
  const capturedAt = Date.parse(input.snapshot.capturedAt);
  if (Number.isNaN(capturedAt)) return [];
  const since = new Date(input.windowEnd.getTime() - PERIOD_MS[input.period]);
  const symbol = input.snapshot.symbol;
  const load = input.readMentions ?? fetchTokenMentions;
  return loadCached(input, {
    key: `x-mentions:v1:${input.snapshot.ca}:${symbol.toLowerCase()}:${input.period}`,
    kind: "x_post",
    fail: "x.mentions_failed",
    cacheFail: "x.mentions_cache_failed",
    log: { symbol },
    load: () => load({ ca: input.snapshot.ca, symbol, since }, { attempts: 1, timeoutMs: 8_000 }),
  });
}

async function readListings(input: ActivityInput): Promise<TimelineEvent[]> {
  const since = new Date(input.windowEnd.getTime() - PERIOD_MS[input.period]);
  const load = input.readListings ?? fetchDexOrders;
  return loadCached(input, {
    key: `dex-orders:v1:${input.snapshot.ca}:${input.period}`,
    kind: "listing",
    fail: "listing.orders_failed",
    cacheFail: "listing.cache_failed",
    load: () => load({ ca: input.snapshot.ca, since, until: input.windowEnd }),
  });
}

async function loadCached(
  input: ActivityInput,
  spec: {
    key: string;
    kind: TimelineEvent["kind"];
    fail: string;
    cacheFail: string;
    log?: Record<string, unknown>;
    load: () => Promise<TimelineEvent[]>;
  },
): Promise<TimelineEvent[]> {
  if (!input.fresh) {
    const cached = await readCachedKind(input.store, spec.key, spec.kind);
    if (cached) return cached;
  }
  try {
    const events = await spec.load();
    await writeCache(input, spec.key, events, spec.cacheFail);
    return events;
  } catch (error) {
    input.logger.warn(spec.fail, {
      ca: input.snapshot.ca,
      ...spec.log,
      ...errorFields(error),
    });
    if (input.fresh) {
      const cached = await readCachedKind(input.store, spec.key, spec.kind);
      if (cached) return cached;
    }
    return [];
  }
}

function mergePosts(ownPosts: readonly TimelineEvent[], mentions: readonly TimelineEvent[]): TimelineEvent[] {
  const byPost = new Map<string, Extract<TimelineEvent, { kind: "x_post" }>>();
  for (const event of [...ownPosts, ...mentions]) {
    if (event.kind !== "x_post") continue;
    const current = byPost.get(event.postId);
    if (!current || preferPost(event, current)) byPost.set(event.postId, event);
  }
  return [...byPost.values()];
}

function preferPost(
  next: Extract<TimelineEvent, { kind: "x_post" }>,
  current: Extract<TimelineEvent, { kind: "x_post" }>,
): boolean {
  const richness = postRichness(next) - postRichness(current);
  if (richness !== 0) return richness > 0;
  return Date.parse(next.occurredAt) >= Date.parse(current.occurredAt);
}

function postRichness(event: Extract<TimelineEvent, { kind: "x_post" }>): number {
  const about = event.about === "contract" ? 2 : event.about === "ticker" ? 1 : 0;
  return (
    about * 2 +
    (event.followers != null ? 1 : 0) +
    (event.verification != null ? 1 : 0) +
    sourceStrength(event)
  );
}

async function writeCache(
  input: ActivityInput,
  key: string,
  events: readonly TimelineEvent[],
  eventName: string,
): Promise<void> {
  if (events.length === 0) return;
  await input.store.set(key, JSON.stringify(events), POST_CACHE_TTL_SECONDS).catch((error: unknown) => {
    input.logger.warn(eventName, {
      ca: input.snapshot.ca,
      ...errorFields(error),
    });
  });
}

async function readWebsiteChanges(input: ActivityInput): Promise<{
  changes: TimelineEvent[];
  baseline: WebsiteBaselineNote | null;
}> {
  const url = input.snapshot.website;
  if (!url || isXHost(url)) return { changes: [], baseline: null };
  const now = (input.now ?? (() => new Date()))();
  const key = websiteStateKey(input.snapshot.ca);
  const stored = await readState(input.store, key, input.logger, input.snapshot.ca);
  const page = stored?.url === url ? stored : null;
  const recheckMs = input.fresh ? 0 : (input.recheckMs ?? WEBSITE_RECHECK_MS);
  if (page && now.getTime() - Date.parse(page.checkedAt) < recheckMs) {
    return { changes: freshChanges(page.changes, input.windowEnd), baseline: null };
  }

  const check = input.checkWebsite ?? fetchWebsite;
  try {
    const result = await check(
      {
        ca: input.snapshot.ca,
        url,
        previous: page ? baseline(page) : null,
      },
      {
        ...input.websiteOptions,
        now: () => input.windowEnd,
      },
    );
    const changes = freshChanges(page?.changes ?? [], input.windowEnd);
    if (result.event && !changes.some((event) => event.id === result.event?.id)) {
      changes.push(result.event);
    }
    await writeState(input.store, key, {
      url: result.url,
      contentHash: result.contentHash,
      textHash: result.textHash,
      title: result.title,
      description: result.description,
      checkedAt: now.toISOString(),
      changes,
    }, input.logger, input.snapshot.ca);
    const firstCopy = page == null && result.event == null;
    return {
      changes,
      baseline: firstCopy ? { url: result.url, observedAt: result.observedAt } : null,
    };
  } catch (error) {
    input.logger.warn("website.check_failed", {
      ca: input.snapshot.ca,
      ...errorFields(error),
    });
    return {
      changes: freshChanges(stored?.changes ?? [], input.windowEnd),
      baseline: null,
    };
  }
}

function websiteStateKey(ca: string): string {
  return `website:v1:${ca}`;
}

function baseline(stored: StoredWebsite): WebsiteBaseline {
  return {
    contentHash: stored.contentHash,
    textHash: stored.textHash,
    title: stored.title,
    description: stored.description,
  };
}

function freshChanges(events: readonly TimelineEvent[], windowEnd: Date): TimelineEvent[] {
  const earliest = windowEnd.getTime() - PERIOD_MS["24h"];
  const end = windowEnd.getTime();
  const kept: TimelineEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const parsed = parseTimelineEvent(event);
    if (parsed.kind !== "website" || seen.has(parsed.id)) continue;
    const at = Date.parse(parsed.occurredAt);
    if (at <= earliest || at > end) continue;
    seen.add(parsed.id);
    kept.push(parsed);
  }
  return kept;
}

async function readCachedKind(
  store: KvStore,
  key: string,
  kind: TimelineEvent["kind"],
): Promise<TimelineEvent[] | null> {
  try {
    const raw = await store.get(key);
    if (!raw) return null;
    const parsed = z.array(timelineEventSchema).safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.some((event) => event.kind !== kind)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function readState(
  store: KvStore,
  key: string,
  logger: Logger,
  ca: string,
): Promise<StoredWebsite | null> {
  try {
    const raw = await store.get(key);
    if (!raw) return null;
    const parsed = storedWebsiteSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch (error) {
    logger.warn("website.state_read_failed", { ca, ...errorFields(error) });
    return null;
  }
}

async function writeState(
  store: KvStore,
  key: string,
  state: StoredWebsite,
  logger: Logger,
  ca: string,
): Promise<void> {
  try {
    await store.set(key, JSON.stringify(state), WEBSITE_STATE_TTL_SECONDS);
  } catch (error) {
    logger.warn("website.state_write_failed", { ca, ...errorFields(error) });
  }
}

function isXHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "x.com" ||
      host === "twitter.com" ||
      host === "mobile.x.com" ||
      host === "mobile.twitter.com"
    );
  } catch {
    return false;
  }
}
