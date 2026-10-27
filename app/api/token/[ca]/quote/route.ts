import type { NextRequest } from "next/server";

import { handleQuoteGet } from "@/lib/brief/http";

export const dynamic = "force-dynamic";

type QuoteContext = {
  params: Promise<{ ca: string }>;
};

export async function GET(request: NextRequest, context: QuoteContext) {
  const { ca } = await context.params;
  return handleQuoteGet(request, ca);
}
