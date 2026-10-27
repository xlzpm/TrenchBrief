"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useState,
  useTransition,
  type ReactNode,
  type TransitionStartFunction,
} from "react";

import { solanaAddressSchema, type BriefPeriod } from "@/lib/dto";

import { BriefLoading } from "./brief-loading";
import { parsePeriod } from "./format";
import { SearchForm } from "./search-form";

export function TokenChrome({
  ca,
  children,
}: {
  ca: string;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-8">
      <Suspense
        fallback={
          <div className="h-40 animate-pulse rounded-2xl border border-line bg-card" />
        }
      >
        <TokenSearch ca={ca} pending={pending} startTransition={startTransition} />
      </Suspense>
      {pending ? <BriefLoading /> : null}
      <div hidden={pending}>{children}</div>
    </div>
  );
}

function TokenSearch({
  ca,
  pending,
  startTransition,
}: {
  ca: string;
  pending: boolean;
  startTransition: TransitionStartFunction;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = parsePeriod(searchParams.get("period")) ?? "1h";
  const [draft, setDraft] = useState(ca);
  const [syncedCa, setSyncedCa] = useState(ca);
  const [fieldError, setFieldError] = useState<string | null>(null);
  if (ca !== syncedCa) {
    setSyncedCa(ca);
    setDraft(ca);
  }

  function navigate(nextCa: string, nextPeriod: BriefPeriod) {
    const parsed = solanaAddressSchema.safeParse(nextCa.trim());
    if (!parsed.success) {
      setFieldError("Enter a Solana contract address.");
      return;
    }
    setFieldError(null);
    const href = `/token/${parsed.data}?period=${nextPeriod}`;
    const sameToken = pathname === `/token/${parsed.data}`;
    const samePeriod = (searchParams.get("period") ?? "1h") === nextPeriod;
    startTransition(() => {
      if (sameToken && samePeriod) router.refresh();
      else if (sameToken) router.replace(href);
      else router.push(href);
    });
  }

  return (
    <SearchForm
      ca={draft}
      period={period}
      error={fieldError}
      pending={pending}
      onCaChange={(value) => {
        setDraft(value);
        if (fieldError) setFieldError(null);
      }}
      onPeriodChange={(next) => navigate(draft, next)}
      onSubmit={() => navigate(draft, period)}
    />
  );
}
