import { z } from "zod";

import { isoDateTimeSchema, solanaAddressSchema } from "@/lib/dto";

export const WATCHLIST_LIMIT = 20;
export const WATCHLIST_STORAGE_KEY = "trench-brief.watchlist";
export const WATCHLIST_CHANGE_EVENT = "trench-brief:watchlist";

export const watchlistItemSchema = z.object({
  ca: solanaAddressSchema,
  name: z.string().min(1),
  symbol: z.string().min(1),
  imageUrl: z.url().nullable(),
  addedAt: isoDateTimeSchema,
});

export type WatchlistItem = z.infer<typeof watchlistItemSchema>;

export type WatchlistDraft = {
  ca: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
};

export type WatchlistChange =
  | {
      ok: true;
      status: "added" | "updated" | "removed" | "unchanged";
      items: WatchlistItem[];
    }
  | {
      ok: false;
      status: "full" | "invalid" | "unavailable";
      items: WatchlistItem[];
    };

/** Drops invalid rows, keeps the first copy of each address, and caps the list. */
export function parseWatchlist(raw: unknown): WatchlistItem[] {
  if (!Array.isArray(raw)) return [];
  const items: WatchlistItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = watchlistItemSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.ca)) continue;
    seen.add(parsed.data.ca);
    items.push(parsed.data);
    if (items.length === WATCHLIST_LIMIT) break;
  }
  return items;
}

export function addToWatchlist(
  items: WatchlistItem[],
  draft: WatchlistDraft,
  addedAt: string = new Date().toISOString(),
): WatchlistChange {
  const parsed = watchlistItemSchema.safeParse({ ...draft, addedAt });
  if (!parsed.success) return { ok: false, status: "invalid", items };

  const candidate = parsed.data;
  const existingIndex = items.findIndex((item) => item.ca === candidate.ca);
  if (existingIndex >= 0) {
    const current = items[existingIndex];
    if (!current) return { ok: false, status: "invalid", items };
    if (
      current.name === candidate.name &&
      current.symbol === candidate.symbol &&
      current.imageUrl === candidate.imageUrl
    ) {
      return { ok: true, status: "unchanged", items };
    }
    const next = items.slice();
    next[existingIndex] = {
      ca: current.ca,
      name: candidate.name,
      symbol: candidate.symbol,
      imageUrl: candidate.imageUrl,
      addedAt: current.addedAt,
    };
    return { ok: true, status: "updated", items: next };
  }

  if (items.length >= WATCHLIST_LIMIT) {
    return { ok: false, status: "full", items };
  }

  return { ok: true, status: "added", items: [candidate, ...items] };
}

export function removeFromWatchlist(items: WatchlistItem[], ca: string): WatchlistChange {
  const parsed = solanaAddressSchema.safeParse(ca);
  if (!parsed.success) return { ok: false, status: "invalid", items };
  const next = items.filter((item) => item.ca !== parsed.data);
  if (next.length === items.length) {
    return { ok: true, status: "unchanged", items };
  }
  return { ok: true, status: "removed", items: next };
}
