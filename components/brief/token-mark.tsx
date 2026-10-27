"use client";

import { useState } from "react";

import { tokenImageSources } from "@/lib/providers/token-image";

const SIZE = {
  md: "size-14 rounded-2xl text-sm",
  sm: "size-10 rounded-xl text-xs",
} as const;

export function TokenMark({
  ca,
  symbol,
  imageUrl,
  size = "md",
}: {
  ca: string;
  symbol: string;
  imageUrl: string | null;
  size?: keyof typeof SIZE;
}) {
  const sources = tokenImageSources(ca, imageUrl);
  const sourceKey = sources.join("\n");
  const [attempt, setAttempt] = useState({ sourceKey, index: 0 });
  const index = attempt.sourceKey === sourceKey ? attempt.index : 0;
  const src = sources[index];
  const box = SIZE[size];

  if (!src) {
    return (
      <div
        aria-hidden
        className={`flex ${box} shrink-0 items-center justify-center border border-line bg-paper font-mono text-ink`}
      >
        {symbol.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    // Token logos come from market providers and are not known at build time.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size === "sm" ? 40 : 56}
      height={size === "sm" ? 40 : 56}
      referrerPolicy="no-referrer"
      className={`${box} shrink-0 border border-line bg-paper object-cover`}
      onError={() => {
        setAttempt({ sourceKey, index: index + 1 });
      }}
    />
  );
}
