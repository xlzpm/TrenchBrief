"use client";

import { useEffect, useState } from "react";

import { formatUsd } from "./format";

const STORAGE_KEY = "trenchbrief.quoteMode";

type QuoteMode = "price" | "marketCap";

export function PriceMetric({
  priceUsd,
  marketCapUsd,
  connected,
}: {
  priceUsd: number | null;
  marketCapUsd: number | null;
  connected: boolean;
}) {
  const [mode, setMode] = useState<QuoteMode>("price");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "marketCap") setMode("marketCap");
  }, []);

  function choose(next: QuoteMode) {
    setMode(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  const value = mode === "price" ? priceUsd : marketCapUsd;
  const label = mode === "price" ? "Price" : "Market cap";

  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-4">
      <dt className="flex items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Show price in dollars or market cap"
          className="flex rounded-full border border-line bg-paper p-0.5"
        >
          <ModeButton
            pressed={mode === "price"}
            label="Price in dollars"
            onClick={() => choose("price")}
          >
            Price
          </ModeButton>
          <ModeButton
            pressed={mode === "marketCap"}
            label="Market cap"
            onClick={() => choose("marketCap")}
          >
            MCap
          </ModeButton>
        </div>
        {connected ? <LiveMark /> : null}
      </dt>
      <dd className="mt-2 font-mono text-2xl tracking-tight text-ink">
        <span className="sr-only">{label}: </span>
        {formatUsd(value)}
      </dd>
    </div>
  );
}

function ModeButton({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        pressed ? "bg-ink text-paper" : "text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
}

export function LiveMark() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-signal">
      <span aria-hidden className="size-1.5 rounded-full bg-signal" />
      Live
    </span>
  );
}
