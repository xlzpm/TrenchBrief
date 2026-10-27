import type { Brief } from "@/lib/dto";

export type BriefWriteResult = {
  brief: Brief;
  /** False when this share id was already stored. The stored brief is returned. */
  created: boolean;
};

/**
 * Insert-only store for published briefs.
 * Implementations must not update or delete a version.
 */
export type BriefRepository = {
  insert(brief: Brief): Promise<BriefWriteResult>;
  findByShareId(shareId: string): Promise<Brief | null>;
  /** Release connections when a reloaded module replaces this instance. */
  close?(): Promise<void>;
};
