import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Downloaded at build time and served from /_next/static/media: the browser never contacts Google. The variable
// font covers the 400–800 weights the design uses. latin-ext carries Romanian and other European diacritics.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  title: { default: "Expenses Tracker", template: "%s · Expenses Tracker" },
  description: "Track income, expenses and transfers across wallets in any currency.",
  // Home-screen install (the manifest is src/app/manifest.ts; the PNGs come from scripts/generate-icons.mjs).
  // favicon.ico is still picked up from src/app by the file convention.
  icons: { apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  // iOS standalone mode. statusBarStyle "default" keeps the page below the status bar; "black-translucent" would
  // draw it underneath and need safe-area padding on the top bar (see docs/DECISIONS.md, 2026-11-25).
  appleWebApp: { capable: true, title: "Expenses", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // --surface (the top bar) in each scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fffcf7" },
    { media: "(prefers-color-scheme: dark)", color: "#1d1e22" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} h-full antialiased`}>
      <body className="min-h-full text-sm">{children}</body>
    </html>
  );
}
