import type { NextConfig } from "next";

import "./lib/env";

const nextConfig: NextConfig = {
  // Lets the e2e server compile beside an already running `next dev`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  serverExternalPackages: ["ws"],
  devIndicators: false,
};

export default nextConfig;
