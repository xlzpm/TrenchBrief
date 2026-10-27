import { BRIEF_PERIODS, type BriefPeriod } from "@/lib/dto";

export const PERIOD_LABELS: Record<BriefPeriod, string> = {
  "1h": "1 hour",
  "6h": "6 hours",
  "12h": "12 hours",
  "24h": "24 hours",
};

export function parsePeriod(value: string | null | undefined): BriefPeriod | null {
  if (value == null) return null;
  return BRIEF_PERIODS.find((period) => period === value) ?? null;
}

export function formatUsd(value: number | null): string {
  if (value == null) return "Not reported";
  if (value === 0) return "$0.00";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (abs >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }
  const maximumFractionDigits =
    abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : abs >= 1e-8 ? 8 : 10;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(value);
}

export function formatSignedPct(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : 1;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (value > 0) return `+${body}%`;
  if (value < 0) return `-${body}%`;
  return "0%";
}

const ISO_IN_PROSE =
  /(?<![\w:/])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})(?![\w])/g;

/** Saved briefs may still end with "Source: …". The page does not show that. */
const SOURCE_CLAUSE = /\s+Sources?: [^.]+\.(?=\s*$)/;

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

/** Summary sentences store ISO timestamps so the claim stays checkable. */
export function formatProseTimestamps(text: string): string {
  return text
    .replace(SOURCE_CLAUSE, "")
    .replace(ISO_IN_PROSE, (iso) => formatTimestamp(iso));
}

export function shortenAddress(ca: string): string {
  if (ca.length <= 12) return ca;
  return `${ca.slice(0, 4)}…${ca.slice(-4)}`;
}
