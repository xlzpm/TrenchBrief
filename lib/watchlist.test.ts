import assert from "node:assert/strict";
import test from "node:test";

import {
  WATCHLIST_LIMIT,
  WATCHLIST_STORAGE_KEY,
  addToWatchlist,
  parseWatchlist,
  removeFromWatchlist,
  type WatchlistItem,
} from "./watchlist";

const ADDED = "2026-10-26T05:00:00.000Z";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function address(index: number): string {
  const mark = ALPHABET[index];
  if (!mark) throw new Error(`No address mark for ${index}.`);
  return `${"1".repeat(31)}${mark}`;
}

function draft(index: number) {
  return {
    ca: address(index),
    name: `Token ${index}`,
    symbol: `T${index}`,
    imageUrl: null as string | null,
  };
}

function item(index: number): WatchlistItem {
  return { ...draft(index), addedAt: ADDED };
}

test("the watchlist key and limit stay stable", () => {
  assert.equal(WATCHLIST_LIMIT, 20);
  assert.equal(WATCHLIST_STORAGE_KEY, "trench-brief.watchlist");
});

test("newer tokens are listed first", () => {
  const first = addToWatchlist([], draft(0), ADDED);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = addToWatchlist(first.items, draft(1), ADDED);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    second.items.map((entry) => entry.ca),
    [address(1), address(0)],
  );
});

test("the watchlist stops at 20 tokens", () => {
  let items: WatchlistItem[] = [];
  for (let index = 0; index < WATCHLIST_LIMIT; index += 1) {
    const result = addToWatchlist(items, draft(index), ADDED);
    assert.equal(result.ok, true);
    if (result.ok) items = result.items;
  }
  assert.equal(items.length, WATCHLIST_LIMIT);

  const rejected = addToWatchlist(items, draft(WATCHLIST_LIMIT), ADDED);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.status, "full");
  assert.equal(rejected.items, items);

  const removed = removeFromWatchlist(items, address(0));
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  const added = addToWatchlist(removed.items, draft(WATCHLIST_LIMIT), ADDED);
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.status, "added");
  assert.equal(added.items.length, WATCHLIST_LIMIT);
  assert.equal(added.items[0]?.ca, address(WATCHLIST_LIMIT));
});

test("saving a token that is already listed refreshes its name", () => {
  const first = addToWatchlist([], draft(0), ADDED);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const again = addToWatchlist(
    first.items,
    { ...draft(0), name: "Renamed" },
    "2026-10-26T06:00:00.000Z",
  );
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.status, "updated");
  assert.equal(again.items.length, 1);
  assert.equal(again.items[0]?.name, "Renamed");
  assert.equal(again.items[0]?.addedAt, ADDED);

  const same = addToWatchlist(again.items, { ...draft(0), name: "Renamed" }, ADDED);
  assert.equal(same.ok, true);
  if (!same.ok) return;
  assert.equal(same.status, "unchanged");
  assert.equal(same.items, again.items);
});

test("a token needs a real address and name", () => {
  const badAddress = addToWatchlist(
    [],
    { ca: "nope", name: "A", symbol: "A", imageUrl: null },
    ADDED,
  );
  assert.equal(badAddress.ok, false);
  const badImage = addToWatchlist([], { ...draft(0), imageUrl: "not-a-url" }, ADDED);
  assert.equal(badImage.ok, false);
  const badTime = addToWatchlist([], draft(0), "yesterday");
  assert.equal(badTime.ok, false);
  const removed = removeFromWatchlist([item(0)], "nope");
  assert.equal(removed.ok, false);
  const missing = removeFromWatchlist([item(0)], address(1));
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(missing.status, "unchanged");
});

test("stored watchlists drop invalid rows and extra tokens", () => {
  const parsed = parseWatchlist([
    item(0),
    { ...item(0), name: "Other" },
    { ca: "bad" },
    null,
    ...Array.from({ length: 25 }, (_, index) => item(index + 1)),
  ]);
  assert.equal(parsed.length, WATCHLIST_LIMIT);
  assert.equal(parsed[0]?.ca, address(0));
  assert.equal(parsed[0]?.name, "Token 0");
  assert.equal(parsed[19]?.ca, address(19));
  assert.equal(
    parsed.some((entry) => entry.ca === address(20)),
    false,
  );
  assert.equal(parseWatchlist({ items: [] }).length, 0);
  assert.equal(parseWatchlist("[]").length, 0);
});

test("a saved list can be read back", () => {
  const added = addToWatchlist(
    [],
    { ...draft(0), imageUrl: "https://example.com/t.png" },
    ADDED,
  );
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.deepEqual(parseWatchlist(JSON.parse(JSON.stringify(added.items))), added.items);
});
