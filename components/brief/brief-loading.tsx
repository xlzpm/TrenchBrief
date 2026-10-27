export function BriefLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-6">
      <p className="text-sm font-medium text-ink-soft">Loading brief</p>
      <div className="flex items-center gap-4">
        <div className="size-14 animate-pulse rounded-2xl bg-line" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-6 w-40 animate-pulse rounded-md bg-line" />
          <div className="h-4 w-64 animate-pulse rounded-md bg-line" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {["Price", "Liquidity", "Volume"].map((label) => (
          <div key={label} className="rounded-2xl border border-line bg-card p-4">
            <div className="h-3 w-16 animate-pulse rounded bg-line" />
            <div className="mt-3 h-7 w-24 animate-pulse rounded bg-line" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-5">
        <div className="h-4 w-32 animate-pulse rounded bg-line" />
        <div className="h-4 w-full animate-pulse rounded bg-line" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-line" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-line" />
      </div>
    </div>
  );
}
