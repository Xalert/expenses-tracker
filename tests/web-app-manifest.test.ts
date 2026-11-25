/**
 * Home-screen install: the web app manifest (src/app/manifest.ts) and the icon files it and the root layout point
 * at (public/, rendered by scripts/generate-icons.mjs).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const root = path.resolve(__dirname, "..");
const publicFile = (url: string) => path.join(root, "public", url);

/** Width, height and whether the PNG has an alpha channel, from its IHDR chunk. */
function png(file: string) {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
  const colorType = bytes[25];
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

/** A colour token's light (Sand) value from globals.css. */
function sandToken(name: string): string {
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`));
  if (!match) throw new Error(`no --${name} in globals.css`);
  return match[1].toLowerCase();
}

describe("web app manifest", () => {
  const m = manifest();

  it("opens the app standalone at /", () => {
    expect(m.name).toBe("Expenses");
    expect(m.short_name).toBe("Expenses");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
  });

  it("takes its colours from the Sand theme", () => {
    expect(m.background_color).toBe(sandToken("background"));
    expect(m.theme_color).toBe(sandToken("surface"));
  });

  it("lists 192 and 512 px icons, one of them maskable, that exist with the stated sizes", () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      const file = publicFile(icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      expect(icon.type).toBe("image/png");
      const { width, height, alpha } = png(file);
      expect(`${width}x${height}`).toBe(icon.sizes);
      // The launcher cuts a maskable icon to its own shape: it must be full-bleed, without transparency.
      if (icon.purpose === "maskable") expect(alpha).toBe(false);
    }
  });
});

describe("apple-touch-icon", () => {
  it("is a 180 px opaque PNG linked from the root layout", () => {
    // iOS fills transparent pixels with black, so the icon must be opaque.
    expect(png(publicFile("/apple-touch-icon.png"))).toEqual({ width: 180, height: 180, alpha: false });
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain('url: "/apple-touch-icon.png", sizes: "180x180"');
  });
});
