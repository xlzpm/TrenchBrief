import Link from "next/link";
import type { ReactNode } from "react";

import { cashtagForSymbol, isOfficialVerification, sourceStrength, sourceStrengthLabel, TICKER_FOLLOWERS } from "@/lib/brief/token-attention";
import { marketCapReading } from "@/lib/analysis/market-cap";
import { linkParts, statusUrlsForPoint, xProfileUrl, xSearchUrl } from "@/lib/brief/post-links";
import { formatMultiple } from "@/lib/format/amounts";
import type { Brief, EvidenceLink, SummaryPoint, TimelineEvent, TokenSnapshot } from "@/lib/dto";

import { BriefToolbar } from "./brief-toolbar";
import { CopyAddress } from "./copy-address";
import { LiveMetrics } from "./live-metrics";
import {
  PERIOD_LABELS,
  formatProseTimestamps,
  formatSignedPct,
  formatTimestamp,
  formatUsd,
} from "./format";
import { TokenMark } from "./token-mark";

const TRADE_PAGES = [
  {
    label: "Axiom",
    href: (ca: string) => `https://axiom.trade/t/${encodeURIComponent(ca)}?chain=sol`,
  },
  {
    label: "GMGN",
    href: (ca: string) => `https://gmgn.ai/sol/token/${encodeURIComponent(ca)}`,
  },
  {
    label: "Padre",
    href: (ca: string) => `https://trade.padre.gg/trade/solana/${encodeURIComponent(ca)}`,
  },
] as const;

const KIND_LABEL: Record<TimelineEvent["kind"], string> = {
  price: "Price",
  liquidity: "Liquidity",
  volume: "Volume",
  website: "Website",
  x_post: "X post",
  listing: "Paid listing",
};

type TradingRead = {
  headline: string;
  tone: "up" | "down" | "mixed";
  bullets: string[];
};

export function BriefReport({
  brief,
  frozen = false,
}: {
  brief: Brief;
  frozen?: boolean;
}) {
  const { snapshot } = brief;
  const events = newestFirst(brief.events);
  const timelineEvents = events.filter((event) => {
    if (event.kind !== "x_post") return true;
    return isExternalSignalPost(event, snapshot);
  });
  const timelinePosts = timelineEvents.filter(
    (event): event is Extract<TimelineEvent, { kind: "x_post" }> => event.kind === "x_post",
  );
  const read = buildTradingRead(brief, events);
  const summary = brief.summary.filter((point) => {
    if (missingBaselineNote(point.text)) return false;
    if (!point.eventId) return true;
    const event = events.find((item) => item.id === point.eventId);
    if (!event || event.kind !== "x_post") return true;
    return isLinkedAccountPost(event, snapshot);
  });

  return (
    <div className="flex flex-col gap-8">
      {frozen ? <SavedBanner brief={brief} /> : null}
      <section className="flex flex-col gap-5" aria-labelledby="token-name">
        <div className="flex items-start gap-4">
          <TokenMark
            ca={snapshot.ca}
            symbol={snapshot.symbol}
            imageUrl={snapshot.imageUrl}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 id="token-name" className="font-display text-3xl tracking-tight text-ink">
                {snapshot.name}
              </h1>
              <p className="text-sm font-medium text-ink-soft">{snapshot.symbol}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="break-all font-mono text-xs text-ink-soft">{snapshot.ca}</p>
              <CopyAddress value={snapshot.ca} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {snapshot.website ? (
                <ExternalLink href={snapshot.website}>Website</ExternalLink>
              ) : null}
              {snapshot.socials.xUrl ? (
                <ExternalLink href={snapshot.socials.xUrl}>
                  {snapshot.socials.xHandle
                    ? `@${snapshot.socials.xHandle}`
                    : "X account"}
                </ExternalLink>
              ) : null}
            </div>
          </div>
        </div>
        <p className="text-sm text-ink-soft">
          Snapshot taken{" "}
          <time dateTime={snapshot.capturedAt}>{formatTimestamp(snapshot.capturedAt)}</time>
          . Summary window: {PERIOD_LABELS[brief.period]}.
        </p>
        <BriefToolbar
          token={{
            ca: snapshot.ca,
            name: snapshot.name,
            symbol: snapshot.symbol,
            imageUrl: snapshot.imageUrl,
          }}
          publication={
            frozen
              ? { kind: "saved", shareId: brief.shareId }
              : { kind: "live", ca: snapshot.ca, period: brief.period }
          }
        />
        <LiveMetrics
          key={snapshot.ca}
          ca={snapshot.ca}
          period={brief.period}
          priceUsd={snapshot.priceUsd}
          marketCapUsd={snapshot.marketCapUsd}
          liquidityUsd={snapshot.liquidityUsd}
          volumeUsd={snapshot.volumeUsd}
          live={!frozen}
        />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="trading-read-heading">
        <h2 id="trading-read-heading" className="font-display text-2xl text-ink">
          What this means now
        </h2>
        <TradingReadCard read={read} period={brief.period} />
      </section>

      {summary.length > 0 ? (
      <section className="flex flex-col gap-4" aria-labelledby="summary-heading">
        <div className="flex flex-col gap-1">
          <h2 id="summary-heading" className="font-display text-2xl text-ink">
            What changed
          </h2>
          <p className="text-sm leading-6 text-ink-soft">
            {summary.length} {summary.length === 1 ? "point" : "points"} for the
            last {PERIOD_LABELS[brief.period]}. New posts from the linked X account stay in this list.
          </p>
        </div>
        <ol className="flex flex-col gap-3">
          {summary.map((point, index) => (
            <li
              key={point.id}
              className="rounded-2xl border border-line bg-card px-4 py-4 sm:px-5"
            >
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">
                {index + 1}
                <span className="sr-only">
                  , observed <time dateTime={point.occurredAt}>{formatTimestamp(point.occurredAt)}</time>
                </span>
              </p>
              <SummaryBody
                point={point}
                event={point.eventId ? events.find((item) => item.id === point.eventId) : undefined}
                token={snapshot}
              />
            </li>
          ))}
        </ol>
      </section>
      ) : null}

      <section className="flex flex-col gap-4" aria-labelledby="timeline-heading">
        <div className="flex flex-col gap-1">
          <h2 id="timeline-heading" className="font-display text-2xl text-ink">
            Timeline
          </h2>
          <p className="text-sm leading-6 text-ink-soft">
            Price, liquidity, website changes, and posts about this coin from business
            or government accounts, from a checked account with more than 15k followers,
            an identity check, and more than 1k verified followers, or posts with at
            least 100 likes. Source strength counts those four signs. Each item has a
            time and a source link. Posts from the linked account are not repeated here.
          </p>
        </div>
        {timelineEvents.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-card px-4 py-5 text-sm leading-6 text-ink-soft">
            No external X mentions with engagement were confirmed in this window, and no paid
            listing, site change, or market move cleared the bar.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {timelineEvents.map((event) => (
              <li key={event.id}>
                <EventCard event={event} marketCapUsd={snapshot.marketCapUsd} token={snapshot} />
              </li>
            ))}
          </ol>
        )}
        {timelinePosts.length === 0 ? <ExternalSignalHint token={snapshot} /> : null}
      </section>

      <nav aria-label="Open this token" className="flex flex-wrap gap-x-4 gap-y-2">
        {TRADE_PAGES.map((page) => (
          <ExternalLink key={page.label} href={page.href(snapshot.ca)}>
            {page.label}
          </ExternalLink>
        ))}
      </nav>
    </div>
  );
}

function EventCard({
  event,
  marketCapUsd,
  token,
}: {
  event: TimelineEvent;
  marketCapUsd: number | null;
  token: TokenSnapshot;
}) {
  const caps =
    event.kind === "price"
      ? marketCapReading(marketCapUsd, event.previousUsd, event.currentUsd)
      : null;
  const sources = uniqueEvidence(event.evidence);
  return (
    <article className="rounded-2xl border border-line bg-card px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-signal">
          {eventKindLabel(event, caps != null)}
        </p>
        <time dateTime={event.occurredAt} className="text-xs text-ink-soft">
          {formatTimestamp(event.occurredAt)}
        </time>
        {event.kind === "x_post" && event.followers != null ? (
          <p className="text-xs text-ink-soft">{formatFollowers(event.followers)}</p>
        ) : null}
        {event.kind === "x_post" && event.likes != null ? (
          <p className="text-xs text-ink-soft">{formatLikes(event.likes)}</p>
        ) : null}
        {event.kind === "x_post" && sourceStrengthLabel(event) ? (
          <p className="text-xs text-ink-soft">{sourceStrengthLabel(event)}</p>
        ) : null}
      </div>
      <h3 className="mt-2 text-base font-medium text-ink">{linkifyText(event.title)}</h3>
      {sources.length > 0 ? (
        <p className="mt-2 text-xs text-ink-soft">
          Sources:{" "}
          {sources.map((source, index) => (
            <span key={`${source.id}-${source.url}`}>
              {index > 0 ? ", " : null}
              <ExternalLink href={source.url} inline>
                {source.label}
              </ExternalLink>
            </span>
          ))}
        </p>
      ) : null}
      <EventBody event={event} marketCapUsd={marketCapUsd} token={token} />
    </article>
  );
}

function EventBody({
  event,
  marketCapUsd,
  token,
}: {
  event: TimelineEvent;
  marketCapUsd: number | null;
  token: TokenSnapshot;
}) {
  if (event.kind === "price" || event.kind === "liquidity" || event.kind === "volume") {
    const caps =
      event.kind === "price"
        ? marketCapReading(marketCapUsd, event.previousUsd, event.currentUsd)
        : null;
    const previousUsd = caps ? caps.previousUsd : event.previousUsd;
    const currentUsd = caps ? caps.currentUsd : event.currentUsd;
    const change =
      event.changePct == null ? null : (
        <span className={event.changePct < 0 ? "text-down" : "text-signal"}>
          {formatSignedPct(event.changePct)}
        </span>
      );
    return (
      <div className="mt-2 flex flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ink">
          {previousUsd == null ? (
            <span className="font-mono">{formatUsd(currentUsd)}</span>
          ) : (
            <>
              <span className="font-mono">{formatUsd(previousUsd)}</span>
              <span aria-hidden className="text-ink-soft">{"->"}</span>
              <span className="font-mono">{formatUsd(currentUsd)}</span>
            </>
          )}
          {change}
          {event.kind === "volume" ? (
            <span className="text-ink-soft">{event.window} window</span>
          ) : null}
        </p>
      </div>
    );
  }
  if (event.kind === "website") {
    return (
      <div className="mt-2 flex flex-col gap-2 text-sm leading-6 text-ink">
        <p>{event.diffSummary}</p>
        <ExternalLink href={event.url}>{event.url}</ExternalLink>
      </div>
    );
  }
  if (event.kind === "listing") {
    return (
      <div className="mt-2 flex flex-col gap-2 text-sm leading-6 text-ink">
        <p>
          {event.placement === "boost"
            ? "Someone paid DexScreener to boost this token."
            : "Someone paid DexScreener to feature this token."}
        </p>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm leading-6 text-ink">
      <p>
        <ExternalLink href={xProfileUrl(event.account)} inline>
          @{event.account}
        </ExternalLink>
      </p>
      <p className="text-ink-soft">
        {"\""}
        {linkifyText(event.textExcerpt)}
        {"\""}
      </p>
      <p className="text-xs text-ink-soft">{postSignal(event, token)}</p>
      <ExternalLink href={event.postUrl}>View post</ExternalLink>
    </div>
  );
}

function eventKindLabel(event: TimelineEvent, marketCap: boolean): string {
  if (marketCap) return "Market cap";
  if (event.kind === "x_post") {
    if (event.about === "contract") return "Contract call";
    if (event.about === "ticker") return "Ticker mention";
  }
  return KIND_LABEL[event.kind];
}

function formatFollowers(count: number): string {
  return formatCount(count, "followers");
}

function formatLikes(count: number): string {
  return formatCount(count, "likes");
}

function formatCount(count: number, unit: string): string {
  if (count >= 1_000_000) return `${compactCount(count / 1_000_000)}M ${unit}`;
  if (count >= 1_000) return `${compactCount(count / 1_000)}k ${unit}`;
  return `${count} ${unit}`;
}

function compactCount(value: number): string {
  return String(Number(value.toFixed(value >= 10 ? 0 : 1)));
}

function postSignal(
  event: Extract<TimelineEvent, { kind: "x_post" }>,
  token: TokenSnapshot,
): string {
  if (event.about === "contract") return "Names this contract. Open the source and confirm the mint.";
  if (event.about === "ticker") {
    return "Names the ticker, not the contract. Another mint can share the symbol.";
  }
  return postMentionsToken(event, token)
    ? "Project account named this token. Confirm the mint in the source."
    : "Does not name this contract or ticker.";
}

function SummaryBody({
  point,
  event,
  token,
}: {
  point: SummaryPoint;
  event: TimelineEvent | undefined;
  token: TokenSnapshot;
}) {
  const statusEvent = event?.kind === "x_post" ? event : undefined;
  const { prose, postUrls } = statusUrlsForPoint(formatProseTimestamps(point.text), statusEvent);
  const weakPostSignal = event?.kind === "x_post" && !postMentionsToken(event, token);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-sm leading-6 text-ink">{linkifyText(prose)}</p>
      {weakPostSignal ? (
        <p className="text-xs text-ink-soft">
          Post does not mention token markers (symbol, address, or project domain).
        </p>
      ) : null}
      {postUrls.map((url) => (
        <ExternalLink key={url} href={url}>
          View post
        </ExternalLink>
      ))}
    </div>
  );
}

function ExternalSignalHint({ token }: { token: TokenSnapshot }) {
  const cashtag = cashtagForSymbol(token.symbol);
  const links = [
    {
      label: "Live search: contract address",
      href: xSearchUrl(`"${token.ca}" -is:retweet`),
    },
    cashtag
      ? {
          label: `Live search: ${cashtag}`,
          href: xSearchUrl(`${cashtag} -is:retweet`),
        }
      : null,
    token.socials.xHandle
      ? {
          label: `Project profile: @${token.socials.xHandle}`,
          href: xProfileUrl(token.socials.xHandle),
        }
      : null,
  ].filter((item): item is { label: string; href: string } => item != null);

  return (
    <aside className="rounded-2xl border border-dashed border-line bg-card px-4 py-4 text-sm leading-6 text-ink-soft">
      <p>No qualifying external X mentions were confirmed in this window.</p>
      <p className="mt-1">
        {token.socials.xHandle
          ? "Use these links to monitor engagement signals while this token builds social reach."
          : "This token snapshot has no linked X handle, so monitoring relies on public mention search."}
      </p>
      <div className="mt-2 flex flex-col gap-1">
        {links.map((link) => (
          <ExternalLink key={link.href} href={link.href}>
            {link.label}
          </ExternalLink>
        ))}
      </div>
    </aside>
  );
}

function linkifyText(text: string): ReactNode[] {
  return linkParts(text).map((part, index) => {
    if (part.kind === "mention") {
      return (
        <ExternalLink key={`${index}-${part.handle}`} href={xProfileUrl(part.handle)} inline>
          @{part.handle}
        </ExternalLink>
      );
    }
    if (part.kind === "url") {
      return (
        <ExternalLink key={`${index}-url`} href={part.href} inline>
          {part.href}
        </ExternalLink>
      );
    }
    return part.text;
  });
}

function ExternalLink({
  href,
  children,
  inline = false,
}: {
  href: string;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        inline
          ? "break-all text-signal underline decoration-signal/30 underline-offset-4"
          : "break-all text-sm text-signal underline decoration-signal/30 underline-offset-4"
      }
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function TradingReadCard({ read, period }: { read: TradingRead; period: Brief["period"] }) {
  const toneClass =
    read.tone === "up" ? "text-signal" : read.tone === "down" ? "text-down" : "text-ink";
  return (
    <article className="rounded-2xl border border-line bg-card px-4 py-4 sm:px-5">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">
        For the last {PERIOD_LABELS[period]}
      </p>
      <p className={`mt-2 text-base font-medium ${toneClass}`}>{read.headline}</p>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm leading-6 text-ink">
        {read.bullets.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </article>
  );
}

function missingBaselineNote(text: string): boolean {
  return (
    /No (prior )?\d+h baseline/.test(text) ||
    /No prior \d+h volume was available/.test(text)
  );
}

function buildTradingRead(brief: Brief, events: TimelineEvent[]): TradingRead {
  const price = events.find((event): event is Extract<TimelineEvent, { kind: "price" }> => event.kind === "price");
  const liquidity = events.find(
    (event): event is Extract<TimelineEvent, { kind: "liquidity" }> => event.kind === "liquidity",
  );
  const volume = events.find((event): event is Extract<TimelineEvent, { kind: "volume" }> => event.kind === "volume");
  const websiteUpdates = events.filter((event) => event.kind === "website");
  const posts = events.filter(
    (event): event is Extract<TimelineEvent, { kind: "x_post" }> => event.kind === "x_post",
  );
  const calls = posts.filter((event) => event.about !== "account");
  const largeCalls = calls.filter((event) => (event.followers ?? 0) >= TICKER_FOLLOWERS);
  const paidListings = events.filter((event) => event.kind === "listing").length;
  const relevantPosts = posts.filter((event) => postMentionsToken(event, brief.snapshot)).length;
  const paidNote =
    paidListings === 0
      ? ""
      : ` ${paidListings} paid DexScreener listing${paidListings === 1 ? "" : "s"} in this window.`;
  const turnover =
    volume?.currentUsd != null && brief.snapshot.liquidityUsd != null && brief.snapshot.liquidityUsd > 0
      ? volume.currentUsd / brief.snapshot.liquidityUsd
      : null;

  let tone: TradingRead["tone"] = "mixed";
  let headline = `Mixed signals over ${brief.period}; wait for confirmation.`;
  if (liquidity?.changePct != null && liquidity.changePct <= -25) {
    tone = "down";
    headline = "Liquidity dropped fast; exits can slip and trend reversals can be violent.";
  } else if (price?.changePct != null && price.changePct < 0 && (liquidity?.changePct ?? 0) <= 0) {
    tone = "down";
    headline = "Price and liquidity both moved down; momentum is currently risk-off.";
  } else if (price?.changePct != null && price.changePct > 0 && (liquidity?.changePct ?? 0) >= 0) {
    tone = "up";
    headline = "Price moved up with flat or improving liquidity; move has support.";
  } else if (turnover != null && turnover >= 5 && (brief.snapshot.liquidityUsd ?? 0) < 20_000) {
    tone = "down";
    headline = "Very high churn on thin liquidity; this often means fast in-and-out flow.";
  } else if (price == null && liquidity == null && volume == null) {
    headline = `No market move cleared ${brief.period} thresholds; this window is mostly noise-level.`;
  }

  const marketSignals: string[] = [];
  if (price?.changePct != null) marketSignals.push(`market cap ${directionWord(price.changePct)} ${formatSignedPct(price.changePct)}`);
  if (liquidity?.changePct != null) {
    marketSignals.push(`liquidity ${directionWord(liquidity.changePct)} ${formatSignedPct(liquidity.changePct)}`);
  }
  if (volume?.currentUsd != null) marketSignals.push(`${volume.window} volume ${formatUsd(volume.currentUsd)}`);
  if (turnover != null) marketSignals.push(`${formatMultiple(turnover)} turnover vs liquidity`);

  const marketLine =
    marketSignals.length > 0
      ? `Market: ${marketSignals.join(", ")}.`
      : `Market: no price or liquidity move qualified for the timeline in this window.`;
  const socialLine =
    largeCalls.length > 0
      ? `Attention: ${largeCalls.length} post(s) from accounts with at least 10k followers name this token.${paidNote}`
      : calls.length > 0
        ? `Attention: ${calls.length} post(s) name this contract or ticker.${paidNote}`
        : posts.length === 0
          ? `Attention: no large-account posts named this contract or ticker.${paidNote}`
          : relevantPosts === 0
            ? `Attention: ${posts.length} post(s) appeared, but none mention symbol/address/domain, so signal quality is weak.${paidNote}`
            : relevantPosts === posts.length
              ? `Attention: all ${posts.length} post(s) mention token markers.${paidNote}`
              : `Attention: ${relevantPosts} of ${posts.length} post(s) mention token markers; separate signal from noise.${paidNote}`;
  const websiteLine =
    websiteUpdates.length === 0
      ? "Website: no page change events in this window."
      : `Website: ${websiteUpdates.length} update(s) detected; verify if content aligns with the current token narrative.`;
  const actionLine =
    tone === "down"
      ? "Risk read: treat entries as high-slippage risk until liquidity stabilizes."
      : tone === "up"
        ? "Risk read: setup is healthier, but still confirm holder and dev-wallet flow before sizing up."
        : "Risk read: mixed setup; wait for either stronger liquidity or clearer token-specific attention.";

  return { headline, tone, bullets: [marketLine, socialLine, websiteLine, actionLine] };
}

function postMentionsToken(event: Extract<TimelineEvent, { kind: "x_post" }>, token: TokenSnapshot): boolean {
  if (event.about === "contract" || event.about === "ticker") return true;
  const text = event.textExcerpt.toLowerCase();
  if (text.includes(token.ca.toLowerCase())) return true;

  const symbol = normalizeWord(token.symbol);
  if (symbol && (text.includes(`$${symbol}`) || containsWord(text, symbol))) return true;

  const name = normalizeWord(token.name);
  if (name && name.length >= 4 && text.includes(name)) return true;

  const host = hostFromUrl(token.website);
  if (host && text.includes(host)) return true;
  return false;
}

function containsWord(text: string, fragment: string): boolean {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function hostFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeWord(value: string): string {
  return value.trim().toLowerCase();
}

function directionWord(value: number): "up" | "down" {
  return value >= 0 ? "up" : "down";
}

function SavedBanner({ brief }: { brief: Brief }) {
  return (
    <aside className="rounded-2xl border border-line bg-card px-4 py-4 text-sm leading-6 text-ink-soft">
      <p>
        Saved copy from{" "}
        <time dateTime={brief.generatedAt}>{formatTimestamp(brief.generatedAt)}</time>.
        This page does not change when the market moves.
      </p>
      <p className="mt-2">
        <Link
          href={`/token/${brief.ca}?period=${brief.period}`}
          className="text-signal underline decoration-signal/30 underline-offset-4"
        >
          Open the live {PERIOD_LABELS[brief.period]} brief
        </Link>
      </p>
    </aside>
  );
}

function newestFirst(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const time = Date.parse(right.event.occurredAt) - Date.parse(left.event.occurredAt);
      if (time !== 0) return time;
      return left.index - right.index;
    })
    .map((item) => item.event);
}

function isLinkedAccountPost(
  event: Extract<TimelineEvent, { kind: "x_post" }>,
  snapshot: TokenSnapshot,
): boolean {
  const linked = snapshot.socials.xHandle?.trim().toLowerCase();
  if (!linked) return false;
  return event.account.toLowerCase() === linked;
}

function isExternalSignalPost(
  event: Extract<TimelineEvent, { kind: "x_post" }>,
  snapshot: TokenSnapshot,
): boolean {
  if (isLinkedAccountPost(event, snapshot)) return false;
  if (isOfficialVerification(event.verification)) return true;
  if (sourceStrength(event) === 4) return true;
  return event.followers != null && event.likes != null;
}

function uniqueEvidence(evidence: readonly EvidenceLink[]): EvidenceLink[] {
  const seen = new Set<string>();
  const links: EvidenceLink[] = [];
  for (const link of evidence) {
    const key = `${link.url}::${link.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}
