import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFT_MAX_AGE_MS, sanitizeDraft, saveEntryDraft, takeEntryDraft } from "@/components/transactions/entry-draft";

const NOW = 1_800_000_000_000;
const ctx = {
  kinds: ["expense", "income", "transfer"] as const,
  walletIds: [1, 2],
  categories: [
    { id: 10, kind: "expense" },
    { id: 20, kind: "income" },
  ],
  now: NOW,
};

describe("sanitizeDraft", () => {
  it("keeps the fields that still fit the form", () => {
    const raw = {
      kind: "expense",
      savedAt: NOW - 1000,
      values: { amount: "12,40", walletId: "2", categoryId: "10", date: "2026-11-07", note: "lunch" },
    };
    expect(sanitizeDraft(raw, ctx)).toEqual({
      kind: "expense",
      values: { amount: "12,40", walletId: "2", categoryId: "10", date: "2026-11-07", note: "lunch" },
    });
  });

  it("drops a gone wallet, a category of another kind, a bad date and non-strings, field by field", () => {
    const raw = {
      kind: "income",
      savedAt: NOW,
      values: { amount: 5, walletId: "9", categoryId: "10", date: "yesterday", note: "ok", toWalletId: "1" },
    };
    expect(sanitizeDraft(raw, ctx)).toEqual({ kind: "income", values: { note: "ok", toWalletId: "1" } });
  });

  it("is null for a kind the form does not offer, junk, or a draft that is too old", () => {
    expect(sanitizeDraft({ kind: "transfer", savedAt: NOW, values: {} }, { ...ctx, kinds: ["expense", "income"] })).toBeNull();
    expect(sanitizeDraft("nope", ctx)).toBeNull();
    expect(sanitizeDraft(null, ctx)).toBeNull();
    expect(sanitizeDraft({ kind: "expense", values: {} }, ctx)).toBeNull();
    expect(sanitizeDraft({ kind: "expense", savedAt: NOW - DRAFT_MAX_AGE_MS - 1, values: {} }, ctx)).toBeNull();
  });
});

describe("saveEntryDraft / takeEntryDraft", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it("round-trips once: the second take finds nothing", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    // A FormData stand-in for the form: saveEntryDraft reads it through `new FormData(form)`.
    const data = new FormData();
    data.set("amount", "7");
    data.set("note", "");
    data.set("returnTo", "/x");
    vi.stubGlobal(
      "FormData",
      class {
        constructor() {
          return data;
        }
      },
    );
    saveEntryDraft("new", "expense", {} as HTMLFormElement, NOW);
    vi.unstubAllGlobals();
    vi.stubGlobal("window", { sessionStorage: storage });
    expect(takeEntryDraft("new")).toEqual({ kind: "expense", values: { amount: "7" }, savedAt: NOW });
    expect(takeEntryDraft("new")).toBeNull();
    expect(takeEntryDraft("other")).toBeNull();
  });

  it("does nothing, without throwing, when storage is blocked", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    vi.stubGlobal("FormData", class {
      get() {
        return "1";
      }
    });
    expect(() => saveEntryDraft("new", "income", {} as HTMLFormElement)).not.toThrow();
    expect(takeEntryDraft("new")).toBeNull();
  });
});
