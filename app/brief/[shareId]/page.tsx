import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BriefReport } from "@/components/brief/brief-report";
import { readBriefVersion } from "@/lib/storage/brief-repository";

type SavedBriefPageProps = {
  params: Promise<{ shareId: string }>;
};

export async function generateMetadata({
  params,
}: SavedBriefPageProps): Promise<Metadata> {
  const { shareId } = await params;
  const brief = await readBriefVersion(shareId);
  if (!brief) return { title: "Saved brief" };
  return {
    title: `${brief.snapshot.symbol} brief`,
    description: `Saved ${brief.period} brief for ${brief.snapshot.name}.`,
  };
}

export default async function SavedBriefPage({ params }: SavedBriefPageProps) {
  const { shareId } = await params;
  const brief = await readBriefVersion(shareId);
  if (!brief) notFound();
  return <BriefReport brief={brief} frozen />;
}
