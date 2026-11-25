#!/usr/bin/env node
// `node scripts/generate-icons.mjs`: renders the home-screen icons in public/ from the brand mark
// (src/components/brand.tsx) with Playwright's Chromium (a devDependency; `npx playwright install chromium` once).
// The PNGs are committed: the app serves them as static files, so neither the build nor the Docker image needs an
// image library. Run it again after changing the brand mark, and keep the glyph below in step with brand.tsx.
//
//   public/icons/icon-192.png, icon-512.png  "any": the rounded accent tile with transparent corners, as in the app
//   public/icons/maskable-512.png            "maskable": full-bleed accent (the launcher cuts its own shape); the
//                                              glyph stays well inside the 80% safe zone
//   public/apple-touch-icon.png (180)        full-bleed accent (iOS rounds the corners and fills transparency black)
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");

// Sand's accent and the accent foreground (src/app/globals.css). The glyph is the 24×24 wallet of BrandMark.
const ACCENT = "#bc522c";
const FOREGROUND = "#ffffff";
const GLYPH = `<path d="M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z" />
  <path d="M3 7V6a2 2 0 0 1 2-2h11" />
  <circle cx="16.5" cy="13.5" r="1.25" fill="${FOREGROUND}" stroke="none" />`;

// BrandMark is a 28px tile (size-7, rounded-lg = 8px) holding a 16px glyph (size-4): the same proportions here.
const GLYPH_RATIO = 16 / 28;
const RADIUS_RATIO = 8 / 28;

function svg(size, { rounded }) {
  const glyph = size * GLYPH_RATIO;
  const offset = (size - glyph) / 2;
  const radius = rounded ? size * RADIUS_RATIO : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${ACCENT}" />
  <svg x="${offset}" y="${offset}" width="${glyph}" height="${glyph}" viewBox="0 0 24 24" fill="none"
    stroke="${FOREGROUND}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</svg>
</svg>`;
}

const ICONS = [
  { file: "public/icons/icon-192.png", size: 192, rounded: true },
  { file: "public/icons/icon-512.png", size: 512, rounded: true },
  { file: "public/icons/maskable-512.png", size: 512, rounded: false },
  { file: "public/apple-touch-icon.png", size: 180, rounded: false },
];

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg(icon.size, icon)}</body></html>`,
    );
    const out = path.join(root, icon.file);
    mkdirSync(path.dirname(out), { recursive: true });
    await page.locator("svg").first().screenshot({ path: out, omitBackground: true });
    await page.close();
    console.log(`${icon.file} (${icon.size}×${icon.size})`);
  }
} finally {
  await browser.close();
}
