import type { ReactNode } from "react";

import { PageShell } from "@/components/brief/page-shell";
import { TokenChrome } from "@/components/brief/token-chrome";

export const dynamic = "force-dynamic";

export default async function TokenLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ca: string }>;
}) {
  const { ca } = await params;
  return (
    <PageShell>
      <TokenChrome ca={ca}>{children}</TokenChrome>
    </PageShell>
  );
}
