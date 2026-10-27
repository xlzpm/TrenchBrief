import { cache } from "react";

import type { BriefPeriod } from "@/lib/dto";

import { productionBriefRuntime } from "./runtime";
import { runBrief, type BriefLoadResult } from "./run-brief";

export type { BriefLoadFailure, BriefLoadResult, BriefRuntime } from "./run-brief";
export { BRIEF_MESSAGES } from "./run-brief";

/**
 * One brief per address and period inside a single render.
 * Metadata and the page share that result, including the rate-limit charge.
 */
export const loadBrief = cache(
  async (ca: string, period: BriefPeriod): Promise<BriefLoadResult> => {
    return runBrief(ca, period, await productionBriefRuntime());
  },
);
