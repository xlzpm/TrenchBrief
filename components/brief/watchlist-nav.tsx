"use client";

import Link from "next/link";

import { useWatchlist } from "@/hooks/use-watchlist";

export function WatchlistNavLink() {
  const { items, ready, limit } = useWatchlist();
  const count = ready ? items.length : 0;

  return (
    <Link href="/#watchlist" className="text-sm font-medium text-ink">
      Watchlist
      {count > 0 ? <span className="ml-1 font-mono text-xs">{count}</span> : null}
      <span className="sr-only">
        {ready ? `, ${items.length} of ${limit} tokens` : ", loading"}
      </span>
    </Link>
  );
}
