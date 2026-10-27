import { describeKvStore } from "@/lib/cache/runtime";

export const dynamic = "force-dynamic";

export function GET() {
  const stores = describeKvStore();
  return Response.json({ ok: true, ...stores });
}
