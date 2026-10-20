import type { NextConfig } from "next";

// The browser talks only to Next; /api/* is proxied to the local FastAPI backend.
const API_URL = process.env.RUNOFFLAB_API_URL ?? "http://127.0.0.1:8000";

const config: NextConfig = {
  // End-to-end tests build into their own folder so they never replace the normal build,
  // and type-check with their own tsconfig so test builds don't rewrite tsconfig.json.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Docker builds a self-contained server (see frontend/Dockerfile); `next start` doesn't use this.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  typescript: { tsconfigPath: process.env.NEXT_DIST_DIR ? "tsconfig.e2e.json" : "tsconfig.json" },
  // The route badge overlapped the editor; compile and runtime errors still show.
  devIndicators: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default config;
