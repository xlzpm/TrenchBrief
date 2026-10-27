"use client";

import Link from "next/link";

import { useWatchlist } from "@/hooks/use-watchlist";
import { shortenAddress } from "@/components/brief/format";

import { TokenMark } from "./token-mark";

export function WatchlistPanel() {
  const { items, ready, remove, limit } = useWatchlist();

  return (
    <section id="watchlist" aria-labelledby="watchlist-heading" className="scroll-mt-8">
      <div className="flex flex-col gap-1">
        <h2 id="watchlist-heading" className="font-display text-2xl text-ink">
          Watchlist
        </h2>
        <p className="text-sm text-ink-soft">
          {ready
            ? `${items.length} of ${limit} saved in this browser.`
            : "Loading saved tokens."}
        </p>
      </div>
      {!ready ? null : items.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-dashed border-line bg-card px-4 py-5 text-sm leading-6 text-ink-soft">
          Tokens you save from a brief appear here. This browser keeps up to {limit},
          and the list stays on this device.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.ca}
              className="flex items-center gap-3 rounded-2xl border border-line bg-card px-3 py-3"
            >
              <Link
                href={`/token/${item.ca}?period=1h`}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <TokenMark
                  ca={item.ca}
                  symbol={item.symbol}
                  imageUrl={item.imageUrl}
                  size="sm"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">
                    {item.name}
                  </span>
                  <span className="block truncate text-xs text-ink-soft">
                    {item.symbol} · {shortenAddress(item.ca)}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                onClick={() => remove(item.ca)}
                aria-label={`Remove ${item.name} (${item.symbol}) from watchlist`}
                className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-soft"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
