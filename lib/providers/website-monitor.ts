import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { solanaAddressSchema } from "../dto/common";
import { parseTimelineEvent, type TimelineEvent } from "../dto/event";
import { ProviderError } from "./errors";
import { fetchWithRetry, type ProviderClientOptions } from "./http";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 750_000;
const HASH_TEXT_LIMIT = 2_000;
const EXCERPT_LIMIT = 280;
const USER_AGENT = "TrenchBrief/0.1 (token website monitor)";

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.0.0.0", 24, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedAddresses.addSubnet("198.18.0.0", 15, "ipv4");
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedAddresses.addAddress("255.255.255.255", "ipv4");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");

export type WebsiteBaseline = {
  contentHash: string;
  textHash?: string | null;
  title: string | null;
  description: string | null;
};

export type WebsiteCheck = {
  url: string;
  requestedUrl: string;
  observedAt: string;
  contentHash: string;
  textHash: string;
  title: string | null;
  description: string | null;
  excerpt: string;
  changed: boolean;
  diffSummary: string | null;
  event: Extract<TimelineEvent, { kind: "website" }> | null;
};

export type WebsiteCheckInput = {
  ca: string;
  url: string;
  previous?: WebsiteBaseline | null;
};

export type WebsiteMonitorOptions = ProviderClientOptions & {
  resolveHost?: (hostname: string) => Promise<string[]>;
  maxBytes?: number;
};

type WebsiteSignals = {
  title: string | null;
  description: string | null;
  excerpt: string;
  contentHash: string;
  textHash: string;
};

function blocked(message: string, cause?: unknown): ProviderError {
  return new ProviderError(message, {
    provider: "website",
    status: null,
    retryable: false,
    code: "blocked_url",
    cause,
  });
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4FromMapped(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match?.[1] ?? null;
}

function isBlockedAddress(address: string): boolean {
  const mapped = ipv4FromMapped(address);
  if (mapped) return isBlockedAddress(mapped);
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    return true;
  }
  if (/^\d+$/.test(hostname)) return true;
  if (/^(?:\d+\.){3}\d+$/.test(hostname) && isIP(hostname) === 0) return true;
  return false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch (error) {
    throw blocked(`Could not resolve website host ${hostname}.`, error);
  }
}

export async function assertPublicHttpUrl(
  value: string,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw blocked("Website URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw blocked("Website URL must use http or https.");
  }
  if (url.username || url.password) {
    throw blocked("Website URL cannot include credentials.");
  }
  const hostname = hostnameOf(url);
  if (!hostname || isBlockedHostname(hostname)) {
    throw blocked("Website host is not allowed.");
  }
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) throw blocked("Website address is not allowed.");
    return url;
  }
  // Checked at request time. The subsequent connection is still a normal DNS lookup.
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw blocked("Website host does not resolve to a public address.");
  }
  return url;
}

function codePoint(code: number): string {
  if (
    !Number.isFinite(code) ||
    code < 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return "";
  }
  return String.fromCodePoint(code);
}

function decodeHtml(input: string): string {
  let value = input;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
        codePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_, dec: string) =>
        codePoint(Number.parseInt(dec, 10)),
      )
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;|&#39;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
    if (next === value) break;
    value = next;
  }
  return value;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hashPart(value: string): string {
  return collapse(value).toLowerCase();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function metaDescription(html: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = attribute(tag, "name") ?? attribute(tag, "property");
    if (!name || !/^(description|og:description)$/i.test(name)) continue;
    const content = attribute(tag, "content");
    if (content) return collapse(decodeHtml(content));
  }
  return "";
}

export function extractWebsiteSignals(html: string): WebsiteSignals {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutHidden);
  const title = collapse(decodeHtml(titleMatch?.[1] ?? ""));
  const description = metaDescription(withoutHidden);
  const visible = withoutHidden.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, " ");
  const text = collapse(decodeHtml(visible.replace(/<[^>]+>/g, " ")));
  const hashedText = text.slice(0, HASH_TEXT_LIMIT);
  const normalizedTitle = hashPart(title);
  const normalizedDescription = hashPart(description);
  const normalizedText = hashPart(hashedText);
  return {
    title: title || null,
    description: description || null,
    excerpt: hashedText.slice(0, EXCERPT_LIMIT),
    textHash: sha256(normalizedText),
    contentHash: sha256(
      [normalizedTitle, normalizedDescription, normalizedText].join("\n"),
    ),
  };
}

const SUMMARY_QUOTE_LIMIT = 120;

function summarizeChange(
  previous: WebsiteBaseline,
  next: WebsiteSignals,
): string {
  const titleChanged = hashPart(previous.title ?? "") !== hashPart(next.title ?? "");
  const descriptionChanged =
    hashPart(previous.description ?? "") !== hashPart(next.description ?? "");
  const textChanged =
    previous.textHash != null
      ? previous.textHash !== next.textHash
      : !titleChanged && !descriptionChanged;
  const parts = [
    titleChanged ? "title" : null,
    descriptionChanged ? "description" : null,
    textChanged ? "text" : null,
  ].filter((part): part is "title" | "description" | "text" => part != null);

  const quotes = changedQuotes(parts, next);
  if (parts.length === 0) return "Page content changed.";
  if (parts.length === 1 && parts[0] === "title") {
    return quotes ? `Title changed to ${quotes}.` : "Title changed.";
  }
  if (parts.length === 1 && parts[0] === "description") {
    return quotes ? `Description changed to ${quotes}.` : "Description changed.";
  }
  if (parts.length === 1 && parts[0] === "text") {
    return quotes ? `Page text changed to ${quotes}.` : "Page text changed.";
  }
  const label =
    parts.length === 3
      ? "Title, description, and page text changed"
      : !parts.includes("text")
        ? "Title and description changed"
        : parts.includes("title")
          ? "Title and page text changed"
          : "Description and page text changed";
  return quotes ? `${label} to ${quotes}.` : `${label}.`;
}

function changedQuotes(
  parts: readonly ("title" | "description" | "text")[],
  next: WebsiteSignals,
): string {
  const quotes: string[] = [];
  if (parts.includes("title") && next.title) quotes.push(quote(next.title, 80));
  if (parts.includes("description") && next.description) quotes.push(quote(next.description, 100));
  if (parts.includes("text") && next.excerpt) {
    const excerpt = collapse(next.excerpt);
    const alreadyQuoted = [next.title, next.description].some(
      (value) => value != null && value.length > 0 && excerpt.startsWith(value),
    );
    if (!alreadyQuoted) quotes.push(quote(excerpt, SUMMARY_QUOTE_LIMIT));
  }
  return quotes.filter((item) => item.length > 2).join(" — ");
}

function quote(value: string, limit: number): string {
  const flat = collapse(value).replace(/[“”"]/g, "'");
  if (!flat) return "";
  const clipped =
    flat.length > limit ? `${flat.slice(0, Math.max(1, limit - 1)).trimEnd()}…` : flat;
  return `"${clipped}"`;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isTextDocument(contentType: string | null): boolean {
  if (!contentType) return true;
  return /text\/|xml|json|html/i.test(contentType);
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = maxBytes - received;
    const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(slice);
    received += slice.byteLength;
    if (value.byteLength > remaining) {
      await reader.cancel();
      break;
    }
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

async function fetchDocument(
  start: URL,
  options: WebsiteMonitorOptions,
): Promise<{ url: URL; html: string }> {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchWithRetry(
      current.toString(),
      {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
          "user-agent": USER_AGENT,
        },
      },
      {
        ...options,
        provider: "website",
        acceptStatus: (status) =>
          (status >= 200 && status < 300) || isRedirect(status),
      },
    );

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new ProviderError("Website redirect did not include a destination.", {
          provider: "website",
          status: response.status,
          retryable: false,
          code: "invalid_response",
        });
      }
      if (hop === MAX_REDIRECTS) {
        throw new ProviderError("Website redirected too many times.", {
          provider: "website",
          status: response.status,
          retryable: false,
          code: "invalid_response",
        });
      }
      current = await assertPublicHttpUrl(
        new URL(location, current).toString(),
        resolveHost,
      );
      continue;
    }

    const contentType = response.headers.get("content-type");
    if (!isTextDocument(contentType)) {
      await response.body?.cancel();
      throw new ProviderError("Website did not return a text document.", {
        provider: "website",
        status: response.status,
        retryable: false,
        code: "invalid_response",
      });
    }
    return { url: current, html: await readLimitedText(response, maxBytes) };
  }

  throw new ProviderError("Website redirected too many times.", {
    provider: "website",
    status: null,
    retryable: false,
    code: "invalid_response",
  });
}

export async function checkWebsite(
  input: WebsiteCheckInput,
  options: WebsiteMonitorOptions = {},
): Promise<WebsiteCheck> {
  const ca = solanaAddressSchema.parse(input.ca);
  const requested = await assertPublicHttpUrl(
    input.url,
    options.resolveHost ?? defaultResolveHost,
  );
  const document = await fetchDocument(requested, options);
  const signals = extractWebsiteSignals(document.html);
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const changed = Boolean(
    input.previous && input.previous.contentHash !== signals.contentHash,
  );
  const diffSummary =
    changed && input.previous ? summarizeChange(input.previous, signals) : null;
  const url = document.url.toString();
  const event =
    changed && diffSummary
      ? parseTimelineEvent({
          id: `website:${signals.contentHash}:${observedAt}`,
          ca,
          kind: "website",
          occurredAt: observedAt,
          title: "Website content changed",
          evidence: [
            {
              id: `website:${ca}`,
              source: "website",
              url,
              label: "Website",
            },
          ],
          url,
          contentHash: signals.contentHash,
          diffSummary,
        })
      : null;

  if (event && event.kind !== "website") {
    throw new ProviderError("Website event was not a website change.", {
      provider: "website",
      status: null,
      retryable: false,
      code: "invalid_response",
    });
  }

  return {
    url,
    requestedUrl: requested.toString(),
    observedAt,
    contentHash: signals.contentHash,
    textHash: signals.textHash,
    title: signals.title,
    description: signals.description,
    excerpt: signals.excerpt,
    changed,
    diffSummary,
    event,
  };
}
