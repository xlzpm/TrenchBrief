import type { NextRequest } from "next/server";

import { handleEventsGet } from "@/lib/brief/http";

export const dynamic = "force-dynamic";

type EventsContext = {
  params: Promise<{ ca: string }>;
};

export async function GET(request: NextRequest, context: EventsContext) {
  const { ca } = await context.params;
  return handleEventsGet(request, ca);
}
