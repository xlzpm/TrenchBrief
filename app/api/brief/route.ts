import type { NextRequest } from "next/server";

import { handleBriefGet, handleBriefPost } from "@/lib/brief/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleBriefGet(request);
}

export function POST(request: NextRequest) {
  return handleBriefPost(request);
}
