import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * Hosts allowed to load the dev server's own scripts (development only; ignored by `next build` / `next start`).
 * Next.js blocks them for any host other than `localhost`, and a page opened as http://<LAN address>:3000 then
 * renders but never hydrates: buttons and forms stay dead. Allow this machine's own addresses — the "Network"
 * URL `next dev` prints — plus anything listed in ALLOWED_DEV_ORIGINS (comma-separated hostnames, e.g. a tunnel
 * or `*.lan`; see .env.example).
 */
function devOrigins(): string[] {
  const own = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
  const extra = (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...own, ...extra])];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
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
