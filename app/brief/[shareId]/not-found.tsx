import Link from "next/link";

export default function SavedBriefNotFound() {
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <h1 className="font-display text-3xl tracking-tight text-ink">Brief not found</h1>
      <p className="text-sm leading-6 text-ink-soft">
        This public link does not match a saved brief. Check the address, or open
        the token and use Copy link or Open public page.
      </p>
      <Link
        href="/"
        className="mt-1 w-fit rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-paper"
      >
        Look up a token
      </Link>
    </section>
  );
}
