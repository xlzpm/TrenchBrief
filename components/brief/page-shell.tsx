import Link from "next/link";
import type { ReactNode } from "react";

import { WatchlistNavLink } from "./watchlist-nav";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link
            href="/"
            className="font-display text-xl tracking-tight text-ink"
          >
            Trench Brief
          </Link>
          <div className="flex items-center gap-4">
            <WatchlistNavLink />
            <p className="hidden text-sm text-ink-soft sm:block">Solana token changes</p>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </>
  );
}
