import type { Metadata } from "next";

import { BriefError } from "@/components/brief/brief-error";
import { BriefReport } from "@/components/brief/brief-report";
import { parsePeriod } from "@/components/brief/format";
import { loadBrief } from "@/lib/brief/load-brief";
import { solanaAddressSchema } from "@/lib/dto";
import { ensureLiveSocket } from "@/lib/live/hub";

type TokenPageProps = {
  params: Promise<{ ca: string }>;
  searchParams: Promise<{ period?: string | string[] }>;
};

export async function generateMetadata({
  params,
  searchParams,
}: TokenPageProps): Promise<Metadata> {
  const [{ ca }, query] = await Promise.all([params, searchParams]);
  const request = readRequest(ca, query.period);
  if (!request) return { title: "Token brief" };
  const result = await loadBrief(request.ca, request.period);
  if (!result.ok) return { title: "Token brief" };
  return {
    title: `${result.brief.snapshot.symbol} brief`,
    description: `What changed for ${result.brief.snapshot.name} over the last ${request.period}.`,
  };
}

export default async function TokenPage({ params, searchParams }: TokenPageProps) {
  const [{ ca }, query] = await Promise.all([params, searchParams]);
  const request = readRequest(ca, query.period);
  if (!request) {
    const address = solanaAddressSchema.safeParse(ca);
    return (
      <BriefError
        title={address.success ? "Unknown time window" : "That address is not valid"}
        message={
          address.success
            ? "Choose a window of 1h, 6h, 12h, or 24h."
            : "Enter a Solana contract address, then choose 1h, 6h, 12h, or 24h."
        }
      />
    );
  }

  const result = await loadBrief(request.ca, request.period);
  if (!result.ok) {
    const title =
      result.code === "rate_limited"
        ? "Too many lookups"
        : result.code === "not_found"
          ? "Token not found"
          : "Brief unavailable";
    return <BriefError title={title} message={result.message} />;
  }

  await ensureLiveSocket();
  return <BriefReport brief={result.brief} />;
}

function readRequest(ca: string, periodValue: string | string[] | undefined) {
  const raw = Array.isArray(periodValue) ? periodValue[0] : periodValue;
  const period = raw == null || raw === "" ? "1h" : parsePeriod(raw);
  const address = solanaAddressSchema.safeParse(ca);
  if (!address.success || !period) return null;
  return { ca: address.data, period };
}
