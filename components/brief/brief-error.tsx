"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

type BriefErrorProps = {
  title: string;
  message: string;
  onRetry?: () => void;
};

export function BriefError({ title, message, onRetry }: BriefErrorProps) {
  return (
    <section
      role="alert"
      className="flex flex-col gap-3 rounded-2xl border border-down/30 bg-down-soft px-5 py-5"
    >
      <h2 className="font-display text-2xl text-ink">{title}</h2>
      <p className="max-w-2xl text-sm leading-6 text-ink">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 w-fit rounded-full border border-ink px-4 py-2 text-sm font-medium text-ink"
        >
          Try again
        </button>
      ) : (
        <RefreshButton />
      )}
    </section>
  );
}

function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className="mt-1 w-fit rounded-full border border-ink px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
    >
      {pending ? "Trying again…" : "Try again"}
    </button>
  );
}
