import { randomUUID } from "node:crypto";
import { headers } from "next/headers";

import { getKvStore } from "@/lib/cache/runtime";
import { log } from "@/lib/observability/log";
import { clientKeyFromHeaders, requestIdFromHeaders } from "@/lib/observability/request";
import { e2eFixturesEnabled, fixtureMarket } from "@/lib/providers/fixture";
import { readTokenSnapshot } from "@/lib/providers/market";

import type { BriefRuntime } from "./run-brief";

/** Runtime used by the page and the API. Tests pass their own runtime. */
export async function productionBriefRuntime(): Promise<BriefRuntime> {
  const requestHeaders = await readIncomingHeaders();
  return {
    requestId: requestHeaders
      ? requestIdFromHeaders(requestHeaders)
      : randomUUID(),
    clientKey: requestHeaders ? clientKeyFromHeaders(requestHeaders) : "local",
    store: getKvStore(),
    readMarket: (ca) =>
      e2eFixturesEnabled()
        ? Promise.resolve(fixtureMarket(ca))
        : readTokenSnapshot(ca),
    readActivity: e2eFixturesEnabled()
      ? async () => ({ posts: [], websiteChanges: [], listings: [] })
      : undefined,
    log,
  };
}

async function readIncomingHeaders(): Promise<Headers | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}
