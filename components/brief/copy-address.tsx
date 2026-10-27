"use client";

import { useState } from "react";

export function CopyAddress({ value }: { value: string }) {
  const [label, setLabel] = useState("Copy");

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setLabel("Copied");
        } catch {
          setLabel("Copy failed");
        }
        window.setTimeout(() => setLabel("Copy"), 1500);
      }}
      className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink-soft"
    >
      {label}
    </button>
  );
}
