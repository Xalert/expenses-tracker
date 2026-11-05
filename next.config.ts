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
  // The app serves no optimised images, so the image optimiser is switched off.
  images: { unoptimized: true },
  experimental: {
    serverActions: {
      // Import uploads (/data) are capped at 5 MB by the app itself (src/server/import.ts); this leaves room for
      // the multipart overhead. Next's default is 1 MB. A reverse proxy in front needs a matching limit.
      bodySizeLimit: "6mb",
    },
  },
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
