"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useWatchlist } from "@/hooks/use-watchlist";
import type { BriefPeriod } from "@/lib/dto";
import type { WatchlistDraft } from "@/lib/watchlist";

export type SharePublication =
  | { kind: "saved"; shareId: string }
  | { kind: "live"; ca: string; period: BriefPeriod };

export function BriefToolbar({
  token,
  publication,
}: {
  token: WatchlistDraft;
  publication: SharePublication;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-card px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <WatchControl token={token} />
      {publication.kind === "saved" ? (
        <SavedShareControl shareId={publication.shareId} />
      ) : (
        <LiveShareControl ca={publication.ca} period={publication.period} />
      )}
    </div>
  );
}

function WatchControl({ token }: { token: WatchlistDraft }) {
  const { items, ready, add, remove, limit } = useWatchlist();
  const [notice, setNotice] = useState<string | null>(null);
  const watching = items.some((item) => item.ca === token.ca);
  const full = ready && !watching && items.length >= limit;

  function onAdd() {
    const result = add(token);
    if (result.ok) {
      setNotice(null);
      return;
    }
    if (result.status === "full") {
      setNotice("Watchlist is full. Remove a token before adding another.");
      return;
    }
    if (result.status === "unavailable") {
      setNotice("This browser blocked saving the watchlist.");
      return;
    }
    setNotice("This token could not be saved.");
  }

  function onRemove() {
    const result = remove(token.ca);
    setNotice(
      result.ok ? null : "This browser blocked saving the watchlist.",
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {ready ? (
        <button
          type="button"
          disabled={full}
          aria-pressed={watching}
          onClick={watching ? onRemove : onAdd}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-60"
        >
          {watching
            ? "Remove from watchlist"
            : full
              ? "Watchlist is full"
              : "Add to watchlist"}
        </button>
      ) : (
        <button
          type="button"
          disabled
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-60"
        >
          Watchlist
        </button>
      )}
      <p className="text-sm text-ink-soft">
        {ready
          ? `${items.length} of ${limit} saved in this browser.`
          : "Loading watchlist."}
      </p>
      {notice ? (
        <p role="status" className="text-sm text-down">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function SavedShareControl({ shareId }: { shareId: string }) {
  const path = `/brief/${shareId}`;
  return (
    <div className="flex max-w-sm flex-col items-start gap-2">
      <p className="break-all font-mono text-xs text-ink-soft">{path}</p>
      <CopyLinkButton path={path} />
    </div>
  );
}

function LiveShareControl({ ca, period }: { ca: string; period: BriefPeriod }) {
  const router = useRouter();
  const pathRef = useRef<string | null>(null);
  const pending = useRef<Promise<string | null> | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `${ca}:${period}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [savedScope, setSavedScope] = useState(scope);
  if (savedScope !== scope) {
    setSavedScope(scope);
    setPath(null);
    setError(null);
    setSaving(false);
    pathRef.current = null;
    pending.current = null;
  }

  function ensureSaved(): Promise<string | null> {
    if (pathRef.current) return Promise.resolve(pathRef.current);
    if (!pending.current) {
      const job = saveVersion(scope);
      pending.current = job;
      void job.finally(() => {
        if (pending.current === job) pending.current = null;
      });
    }
    return pending.current;
  }

  async function saveVersion(requested: string): Promise<string | null> {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ca, period }),
      });
      if (scopeRef.current !== requested) return null;
      const body: unknown = await response.json();
      if (scopeRef.current !== requested) return null;
      const sharePath = readSharePath(body);
      if (!response.ok || !sharePath) {
        setError("This version could not be saved. Try again.");
        return null;
      }
      pathRef.current = sharePath;
      setPath(sharePath);
      return sharePath;
    } catch {
      if (scopeRef.current !== requested) return null;
      setError("This version could not be saved. Try again.");
      return null;
    } finally {
      if (scopeRef.current === requested) setSaving(false);
    }
  }

  return (
    <div className="flex max-w-sm flex-col items-start gap-2">
      <p className="text-sm leading-6 text-ink-soft">
        {path
          ? "The public link keeps this version."
          : "Open or copy the link to save the brief as it is now."}
      </p>
      {path ? <p className="break-all font-mono text-xs text-ink-soft">{path}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            void ensureSaved().then((sharePath) => {
              if (sharePath) router.push(sharePath);
            });
          }}
          className="rounded-full border border-ink px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-60"
        >
          Open public page
        </button>
        <CopyLinkButton path={path} resolvePath={ensureSaved} disabled={saving} />
      </div>
      {error ? (
        <p role="status" className="text-sm text-down">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CopyLinkButton({
  path,
  resolvePath,
  disabled = false,
}: {
  path: string | null;
  resolvePath?: () => Promise<string | null>;
  disabled?: boolean;
}) {
  const [label, setLabel] = useState("Copy link");

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={async () => {
        const sharePath = resolvePath ? await resolvePath() : path;
        if (!sharePath) return;
        const absolute = `${window.location.origin}${sharePath}`;
        try {
          await navigator.clipboard.writeText(absolute);
          setLabel("Copied");
        } catch {
          setLabel("Copy failed");
        }
        window.setTimeout(() => setLabel("Copy link"), 1500);
      }}
      className="rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink-soft disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function readSharePath(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { ok?: unknown; saved?: unknown; sharePath?: unknown };
  if (record.ok !== true || record.saved !== true || typeof record.sharePath !== "string") {
    return null;
  }
  return record.sharePath.startsWith("/brief/") ? record.sharePath : null;
}
