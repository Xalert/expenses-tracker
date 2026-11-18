import { describe, expect, it } from "vitest";
import { USER_AGENT_MAX, deviceLabel, storedUserAgent } from "@/lib/user-agent";
import { formatDateTime } from "@/lib/dates";

const UA = {
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  firefoxIpad:
    "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  operaLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
};

describe("deviceLabel", () => {
  it("names common browsers and systems", () => {
    expect(deviceLabel(UA.firefoxMac)).toBe("Firefox on macOS");
    expect(deviceLabel(UA.safariMac)).toBe("Safari on macOS");
    expect(deviceLabel(UA.safariIphone)).toBe("Safari on iPhone");
    expect(deviceLabel(UA.chromeIos)).toBe("Chrome on iPhone");
    expect(deviceLabel(UA.firefoxIpad)).toBe("Firefox on iPad");
    expect(deviceLabel(UA.chromeWindows)).toBe("Chrome on Windows");
    expect(deviceLabel(UA.edgeWindows)).toBe("Edge on Windows");
    expect(deviceLabel(UA.operaLinux)).toBe("Opera on Linux");
    expect(deviceLabel(UA.chromeAndroid)).toBe("Chrome on Android");
    expect(deviceLabel(UA.samsungAndroid)).toBe("Samsung Internet on Android");
    expect(deviceLabel(UA.chromeOs)).toBe("Chrome on ChromeOS");
    expect(deviceLabel(UA.firefoxLinux)).toBe("Firefox on Linux");
  });

  it("falls back to the browser alone, or Unknown browser", () => {
    expect(deviceLabel("Mozilla/5.0 Firefox/132.0")).toBe("Firefox");
    expect(deviceLabel("curl/8.7.1")).toBe("Unknown browser");
    expect(deviceLabel("")).toBe("Unknown browser");
    expect(deviceLabel(null)).toBe("Unknown browser");
  });
});

describe("storedUserAgent", () => {
  it("trims, truncates to 256 characters, and stores nothing for an empty header", () => {
    expect(storedUserAgent(`  ${UA.firefoxMac}  `)).toBe(UA.firefoxMac);
    expect(storedUserAgent("x".repeat(1000))).toHaveLength(USER_AGENT_MAX);
    expect(USER_AGENT_MAX).toBe(256);
    expect(storedUserAgent("   ")).toBeNull();
    expect(storedUserAgent(null)).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("shows the instant in the given zone, 24-hour", () => {
    const t = new Date(Date.UTC(2026, 10, 5, 13, 3));
    expect(formatDateTime(t, "UTC")).toBe("5 Nov 2026, 13:03");
    expect(formatDateTime(t, "Europe/Bucharest")).toBe("5 Nov 2026, 15:03");
  });
});
