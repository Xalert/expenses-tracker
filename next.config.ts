import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components is intentionally OFF: every page in this app renders per-user data from
  // the session cookie, so classic dynamic rendering keeps pages and Server Actions simple
  // (no mandatory <Suspense> around cookie reads). See docs/SPEC.md "Stack".
  // Self-hosting: `next build` emits .next/standalone/server.js (see docs/SPEC.md "Deployment").
  output: "standalone",
  // Migrations are read from disk at runtime; ship them inside the standalone output too.
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*"] },
  serverExternalPackages: ["better-sqlite3"],
  // The app serves no optimised images; this keeps `sharp` out of the standalone output (~20 MB smaller image).
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
