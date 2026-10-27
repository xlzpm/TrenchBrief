"use client";

import { BriefError } from "@/components/brief/brief-error";

export default function SavedBriefError({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <BriefError
      title="Something went wrong"
      message="The saved brief could not be loaded. Try again."
      onRetry={retry}
    />
  );
}
