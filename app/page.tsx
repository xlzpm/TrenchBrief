import { HomeSearch } from "@/components/brief/home-search";
import { PageShell } from "@/components/brief/page-shell";
import { WatchlistPanel } from "@/components/brief/watchlist-panel";

export default function HomePage() {
  return (
    <PageShell>
      <header className="flex max-w-2xl flex-col gap-3">
        <p className="text-sm font-medium uppercase tracking-[0.16em] text-signal">
          Solana
        </p>
        <h1 className="font-display text-4xl leading-tight tracking-tight text-ink sm:text-5xl">
          What changed for a token
        </h1>
        <p className="text-lg leading-8 text-ink-soft">
          Look up a contract address. The brief covers price, liquidity, the website,
          and new posts from the linked X account.
        </p>
      </header>
      <HomeSearch />
      <WatchlistPanel />
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Brief contents">
        {[
          ["Snapshot", "Name, image, price, liquidity, and volume for each window."],
          [
            "Summary",
            "Market moves, the website, and new posts from the linked X account.",
          ],
          ["Timeline", "Timestamped events for this token, each with a link to the source."],
        ].map(([title, body]) => (
          <article key={title} className="rounded-2xl border border-line bg-card px-4 py-4">
            <h2 className="text-sm font-medium text-ink">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-ink-soft">{body}</p>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
