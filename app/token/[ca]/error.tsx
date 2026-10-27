"use client";

import { BriefError } from "@/components/brief/brief-error";

export default function TokenError({
  retry,
}: {
  error: unknown;
  reset: () => void;
  retry: () => void;
}) {
  return (
    <BriefError
      title="Something went wrong"
      message="The brief could not be loaded. Try again."
      onRetry={retry}
    />
  );
}
