import type { ReactNode } from "react";

import { PageShell } from "@/components/brief/page-shell";

export const dynamic = "force-dynamic";

export default function SavedBriefLayout({ children }: { children: ReactNode }) {
  return <PageShell>{children}</PageShell>;
}
