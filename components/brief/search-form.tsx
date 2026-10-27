import { BRIEF_PERIODS, type BriefPeriod } from "@/lib/dto";

import { PERIOD_LABELS } from "./format";

type SearchFormProps = {
  ca: string;
  period: BriefPeriod;
  error: string | null;
  pending: boolean;
  onCaChange: (value: string) => void;
  onPeriodChange: (period: BriefPeriod) => void;
  onSubmit: () => void;
};

export function SearchForm({
  ca,
  period,
  error,
  pending,
  onCaChange,
  onPeriodChange,
  onSubmit,
}: SearchFormProps) {
  return (
    <form
      className="flex flex-col gap-4 rounded-2xl border border-line bg-card p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="contract-address" className="text-sm font-medium text-ink">
          Contract address
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="contract-address"
            name="ca"
            value={ca}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste a Solana contract address"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "contract-address-error" : undefined}
            onChange={(event) => onCaChange(event.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-line bg-paper px-3 py-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-soft/70"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-60"
          >
            {pending ? "Looking up…" : "Look up"}
          </button>
        </div>
        {error ? (
          <p id="contract-address-error" role="alert" className="text-sm text-down">
            {error}
          </p>
        ) : (
          <p className="text-sm text-ink-soft">
            Base58 mint address, 32 to 44 characters.
          </p>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">Window</legend>
        <div className="flex flex-wrap gap-2">
          {BRIEF_PERIODS.map((item) => {
            const selected = item === period;
            return (
              <label key={item} className="cursor-pointer">
                <input
                  type="radio"
                  name="period"
                  value={item}
                  checked={selected}
                  aria-label={PERIOD_LABELS[item]}
                  onChange={() => onPeriodChange(item)}
                  className="peer sr-only"
                />
                <span
                  className={`inline-flex min-w-14 items-center justify-center rounded-full border px-3 py-1.5 text-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal ${
                    selected
                      ? "border-ink bg-ink text-paper"
                      : "border-line bg-paper text-ink"
                  }`}
                >
                  {item}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </form>
  );
}
