const STATUS_URL =
  /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\?[^\s)]*)?/gi;

export function xProfileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

export function xSearchUrl(query: string): string {
  const search = new URL("https://x.com/search");
  search.searchParams.set("q", query);
  search.searchParams.set("src", "typed_query");
  search.searchParams.set("f", "live");
  return search.toString();
}

/** Pulls X status URLs out of a sentence so the page can link them as "View post". */
export function extractStatusUrls(text: string): { prose: string; postUrls: string[] } {
  const postUrls: string[] = [];
  const seen = new Set<string>();
  const stripped = text.replace(STATUS_URL, (_match, handle: string, id: string) => {
    const url = `https://x.com/${handle}/status/${id}`;
    const key = url.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      postUrls.push(url);
    }
    return "";
  });
  const prose = stripped
    .replace(/[ \t]*\([ \t]*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([:;,.])/g, "$1")
    .trim();
  return { prose, postUrls };
}

export function statusUrlsForPoint(
  text: string,
  event: { kind: string; postUrl: string } | undefined,
): { prose: string; postUrls: string[] } {
  const extracted = extractStatusUrls(text);
  const urls = event?.kind === "x_post" ? [event.postUrl, ...extracted.postUrls] : extracted.postUrls;
  return { prose: extracted.prose, postUrls: dedupeStatusUrls(urls) };
}

export type LinkedPart =
  | { kind: "text"; text: string }
  | { kind: "mention"; handle: string }
  | { kind: "url"; href: string };

const LINKED =
  /https?:\/\/[^\s<>"']+|@([A-Za-z0-9_]{1,15})/g;
const TRAILING_URL_MARK = new Set([...".,;:!?'\"”’…"]);

/** Splits post text into plain words, @handles, and http(s) links. */
export function linkParts(text: string): LinkedPart[] {
  const parts: LinkedPart[] = [];
  let last = 0;
  for (const match of text.matchAll(LINKED)) {
    const at = match.index ?? 0;
    const raw = match[0];
    if (raw.startsWith("@")) {
      const previous = at > 0 ? text[at - 1] : "";
      if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
      pushText(parts, text.slice(last, at));
      parts.push({ kind: "mention", handle: match[1] ?? "" });
      last = at + raw.length;
      continue;
    }
    const end = urlLength(raw);
    const href = raw.slice(0, end);
    if (!isHttpUrl(href)) continue;
    pushText(parts, text.slice(last, at));
    parts.push({ kind: "url", href });
    last = at + end;
  }
  pushText(parts, text.slice(last));
  return parts;
}

function pushText(parts: LinkedPart[], text: string) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.kind === "text") {
    previous.text += text;
    return;
  }
  parts.push({ kind: "text", text });
}

function urlLength(raw: string): number {
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1] ?? "";
    const opener = char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : "";
    if (opener) {
      const head = raw.slice(0, end);
      if (countChar(head, char) <= countChar(head, opener)) break;
      end -= 1;
      continue;
    }
    if (!TRAILING_URL_MARK.has(char)) break;
    end -= 1;
  }
  return end;
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const item of value) if (item === char) count += 1;
  return count;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function dedupeStatusUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const key = url
      .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com/i, "https://x.com")
      .toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(url);
  }
  return unique;
}
