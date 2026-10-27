"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  WATCHLIST_CHANGE_EVENT,
  WATCHLIST_LIMIT,
  WATCHLIST_STORAGE_KEY,
  addToWatchlist,
  parseWatchlist,
  removeFromWatchlist,
  type WatchlistChange,
  type WatchlistDraft,
  type WatchlistItem,
} from "@/lib/watchlist";

const SERVER_ITEMS: WatchlistItem[] = [];

let cachedRaw = "";
let cachedItems: WatchlistItem[] = SERVER_ITEMS;

function emptySubscribe(): () => void {
  return () => {};
}

function subscribe(onStoreChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== WATCHLIST_STORAGE_KEY) return;
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(WATCHLIST_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(WATCHLIST_CHANGE_EVENT, onStoreChange);
  };
}

function readRaw(): string {
  try {
    return localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function getSnapshot(): WatchlistItem[] {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedItems;
  cachedRaw = raw;
  try {
    cachedItems = parseWatchlist(JSON.parse(raw));
  } catch {
    cachedItems = [];
  }
  return cachedItems;
}

function getServerSnapshot(): WatchlistItem[] {
  return SERVER_ITEMS;
}

function persist(items: WatchlistItem[]): boolean {
  try {
    const raw = JSON.stringify(items);
    localStorage.setItem(WATCHLIST_STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedItems = items;
    window.dispatchEvent(new Event(WATCHLIST_CHANGE_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function useWatchlist() {
  const ready = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const add = useCallback((draft: WatchlistDraft): WatchlistChange => {
    const result = addToWatchlist(getSnapshot(), draft);
    if (!result.ok || result.status === "unchanged") return result;
    if (!persist(result.items)) {
      return { ok: false, status: "unavailable", items: getSnapshot() };
    }
    return result;
  }, []);

  const remove = useCallback((ca: string): WatchlistChange => {
    const result = removeFromWatchlist(getSnapshot(), ca);
    if (!result.ok || result.status !== "removed") return result;
    if (!persist(result.items)) {
      return { ok: false, status: "unavailable", items: getSnapshot() };
    }
    return result;
  }, []);

  return { items, ready, add, remove, limit: WATCHLIST_LIMIT };
}
