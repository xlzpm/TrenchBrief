import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { withRequestId } from "@/lib/observability/request";

/**
 * Assigns a request id before the page or API route runs.
 * Rate limiting stays in the Node route, where the cache and the counter
 * share one process. Proxy isolates do not share that memory.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const requestId = withRequestId(requestHeaders);
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
