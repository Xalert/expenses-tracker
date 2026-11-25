import type { MetadataRoute } from "next";

/**
 * The web app manifest, served at /manifest.webmanifest (a static route: built once, no session needed) and linked
 * from every page's head by Next.js. It makes the app installable on a phone's home screen. The icons are the PNGs
 * in public/ rendered from the brand mark by scripts/generate-icons.mjs. No service worker (docs/DECISIONS.md).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Expenses",
    short_name: "Expenses",
    description: "Track income, expenses and transfers across wallets in any currency.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Sand (src/app/globals.css): --background for the launch screen, --surface (the top bar) for the system bars.
    // The root layout's `themeColor` switches the bar to Graphite in dark mode once a page is loaded.
    background_color: "#f4efe7",
    theme_color: "#fffcf7",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
