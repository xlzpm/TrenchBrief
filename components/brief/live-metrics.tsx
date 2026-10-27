"use client";

import { useEffect, useState } from "react";

import type { BriefPeriod } from "@/lib/dto";
import { browserLiveSocketUrl } from "@/lib/live/port";
import {
  applyLiveQuote,
  applyLiveStats,
  parseLiveQuote,
  parseLiveServerFrame,
  type LiveReading,
} from "@/lib/live/stats";

import { formatUsd } from "./format";
import { LiveMark, PriceMetric } from "./price-metric";

const VOLUME_WINDOWS = ["1h", "6h", "12h", "24h"] as const;

/** About four market reads a minute, inside the quote rate limit. */
const QUOTE_POLL_MS = 15_000;

export function LiveMetrics({
  ca,
  period,
  priceUsd,
  marketCapUsd,
  liquidityUsd,
  volumeUsd,
  live,
}: {
  ca: string;
  period: BriefPeriod;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: LiveReading["volumeUsd"];
  live: boolean;
}) {
  const [reading, setReading] = useState<LiveReading>(() => ({
    ca,
    priceUsd,
    marketCapUsd,
    liquidityUsd,
    volumeUsd,
  }));
  const [connected, setConnected] = useState(false);
  const [quoted, setQuoted] = useState(false);

  useEffect(() => {
    if (!live) return;
    let socket: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer = 0;
    let quoteTimer = 0;
    let socketLive = false;

    const readQuote = async () => {
      if (stopped || socketLive || document.hidden) return;
      try {
        const response = await fetch(`/api/token/${encodeURIComponent(ca)}/quote`, {
          cache: "no-store",
        });
        if (!response.ok || stopped || socketLive) return;
        const quote = parseLiveQuote(await response.json());
        if (!quote || quote.ca !== ca || stopped || socketLive) return;
        setQuoted(true);
        setReading((current) => applyLiveQuote(current, quote));
      } catch {
        if (!stopped) setQuoted(false);
      }
    };

    const connect = () => {
      if (stopped) return;
      const next = new WebSocket(browserLiveSocketUrl(ca, window.location));
      socket = next;
      next.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const frame = parseLiveServerFrame(parsed);
        if (!frame || stopped) return;
        if (frame.type === "status") {
          socketLive = frame.live;
          setConnected(frame.live);
          if (!frame.live) void readQuote();
          return;
        }
        if (frame.ca !== ca) return;
        socketLive = true;
        setConnected(true);
        setReading((current) => applyLiveStats(current, frame));
      };
      next.onopen = () => {
        attempt = 0;
      };
      next.onclose = () => {
        if (socket !== next) return;
        socketLive = false;
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(1_000 * 2 ** attempt, 15_000);
        attempt += 1;
        timer = window.setTimeout(connect, delay);
        void readQuote();
      };
    };

    connect();
    void readQuote();
    quoteTimer = window.setInterval(() => {
      void readQuote();
    }, QUOTE_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void readQuote();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(quoteTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, [ca, live]);

  const volume = reading.volumeUsd[period];

  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <PriceMetric
        priceUsd={reading.priceUsd}
        marketCapUsd={reading.marketCapUsd}
        connected={connected || quoted}
      />
      <div className="rounded-2xl border border-line bg-card px-4 py-4">
        <dt className="flex items-center justify-between gap-2 text-sm text-ink-soft">
          Liquidity
          {connected || quoted ? <LiveMark /> : null}
        </dt>
        <dd className="mt-2 font-mono text-2xl tracking-tight text-ink">
          {formatUsd(reading.liquidityUsd)}
        </dd>
      </div>
      <div className="rounded-2xl border border-line bg-card px-4 py-4">
        <dt className="flex items-center justify-between gap-2 text-sm text-ink-soft">
          {period} volume
          {connected || quoted ? <LiveMark /> : null}
        </dt>
        <dd className="mt-2 font-mono text-2xl tracking-tight text-ink">{formatUsd(volume)}</dd>
        <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
          {VOLUME_WINDOWS.map((window) => {
            const amount = reading.volumeUsd[window];
            const selected = window === period;
            return (
              <li
                key={window}
                className={`flex items-baseline justify-between gap-3 text-xs ${
                  selected ? "font-medium text-ink" : "text-ink-soft"
                }`}
              >
                <span>{window}</span>
                <span className="font-mono whitespace-nowrap">
                  {amount == null ? <span aria-label="Not reported">—</span> : formatUsd(amount)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </dl>
  );
}
