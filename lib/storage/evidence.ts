import type { Brief, EvidenceLink } from "@/lib/dto";

/** Unique source links cited by a brief's summary and timeline. */
export function collectEvidenceLinks(brief: Brief): EvidenceLink[] {
  const seen = new Set<string>();
  const links: EvidenceLink[] = [];

  const add = (link: EvidenceLink) => {
    const key = `${link.id}\0${link.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const point of brief.summary) {
    for (const link of point.evidence) add(link);
  }
  for (const event of brief.events) {
    for (const link of event.evidence) add(link);
  }

  return links;
}
