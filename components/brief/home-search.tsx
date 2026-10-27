"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { solanaAddressSchema, type BriefPeriod } from "@/lib/dto";

import { SearchForm } from "./search-form";

export function HomeSearch() {
  const router = useRouter();
  const [ca, setCa] = useState("");
  const [period, setPeriod] = useState<BriefPeriod>("1h");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function lookup() {
    const parsed = solanaAddressSchema.safeParse(ca.trim());
    if (!parsed.success) {
      setFieldError("Enter a Solana contract address.");
      return;
    }
    setFieldError(null);
    startTransition(() => {
      router.push(`/token/${parsed.data}?period=${period}`);
    });
  }

  return (
    <SearchForm
      ca={ca}
      period={period}
      error={fieldError}
      pending={pending}
      onCaChange={(value) => {
        setCa(value);
        if (fieldError) setFieldError(null);
      }}
      onPeriodChange={setPeriod}
      onSubmit={lookup}
    />
  );
}
