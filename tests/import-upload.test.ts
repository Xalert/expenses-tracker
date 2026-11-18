// Turning uploads into the importer's input (zips of Spendee's per-wallet CSVs) and the proxy that answers an
// oversized upload with the app's own message. All files here are synthetic.
import { strToU8, zipSync } from "fflate";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { IMPORT_MAX_BYTES, IMPORT_MAX_REQUEST_BYTES, IMPORT_TOO_LARGE_MESSAGE } from "@/lib/constants";
import { previewImport, runImport } from "@/server/import";
import { expandUploads, isZip } from "@/server/import-upload";
import { config, proxy } from "@/proxy";
import { makeUser, useFreshDb } from "./helpers";

const HEADER = "Date,Wallet,Type,Category name,Amount,Currency,Note,Labels,Author";
const SAVINGS = `${HEADER}\n2026-08-17T08:41:32+00:00,Savings,Outgoing Transfer,,-300.00000000,EUR,rent,,"Test Person"\n`;
const JOINT = `${HEADER}\n2026-08-17T08:41:34+00:00,Joint,Incoming Transfer,,300.00000000,EUR,rent,,"Test Person"\n2026-08-20T12:00:00+00:00,Joint,Expense,Groceries,-8.00000000,EUR,,,"Test Person"\n`;

const upload = (name: string, data: string | Uint8Array) => ({ name, bytes: typeof data === "string" ? strToU8(data) : data });

describe("expandUploads", () => {
  it("unpacks a zip into its CSV / JSON files, skipping folders, macOS metadata and other files", () => {
    const zip = zipSync({
      "export/Savings.csv": strToU8(SAVINGS),
      "export/Joint.csv": strToU8(JOINT),
      "export/": new Uint8Array(),
      "__MACOSX/export/._Joint.csv": strToU8("junk"),
      "export/.DS_Store": strToU8("junk"),
      "export/logo.png": new Uint8Array([1, 2, 3]),
      "nested.zip": zipSync({ "x.csv": strToU8("a") }),
    });
    expect(isZip(zip)).toBe(true);
    const r = expandUploads([upload("spendee.zip", zip), upload("plain.csv", "date,type\n")]);
    expect(r).toEqual({
      ok: true,
      files: [
        { name: "spendee.zip › export/Joint.csv", text: JOINT },
        { name: "spendee.zip › export/Savings.csv", text: SAVINGS },
        { name: "plain.csv", text: "date,type\n" },
      ],
    });
  });

  it("recognises zips by content, not by name, and leaves other files as text", () => {
    expect(isZip(strToU8("PK but not a zip"))).toBe(false);
    expect(expandUploads([upload("data.zip", "date,type\n")])).toEqual({ ok: true, files: [{ name: "data.zip", text: "date,type\n" }] });
    const renamed = zipSync({ "a.csv": strToU8("x") });
    expect(expandUploads([upload("export.bin", renamed)])).toMatchObject({ ok: true, files: [{ name: "export.bin › a.csv" }] });
  });

  it("refuses zips that unpack to more than the limit, are broken, or hold nothing importable", () => {
    // Highly compressible: tiny as a zip, over the limit unpacked.
    const bomb = zipSync({ "big.csv": new Uint8Array(IMPORT_MAX_BYTES + 1).fill(65) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    expect(expandUploads([upload("bomb.zip", bomb)])).toEqual({
      ok: false,
      error: "The files in “bomb.zip” are larger than 5 MB in total once unpacked. Import them in smaller groups.",
    });
    // The limit counts plain files and unpacked files together.
    const half = zipSync({ "half.csv": new Uint8Array(IMPORT_MAX_BYTES / 2 + 1).fill(65) });
    expect(expandUploads([upload("a.csv", "x".repeat(IMPORT_MAX_BYTES / 2)), upload("half.zip", half)])).toMatchObject({ ok: false });
    const broken = zipSync({ "a.csv": strToU8("hello") }).slice(0, 30);
    expect(expandUploads([upload("broken.zip", broken)])).toMatchObject({ ok: false, error: expect.stringMatching(/^“broken\.zip” could not be read as a zip file/) });
    expect(expandUploads([upload("pics.zip", zipSync({ "a.png": new Uint8Array([1]) }))])).toEqual({
      ok: false,
      error: "“pics.zip” contains no CSV or JSON files to import.",
    });
    const many = zipSync(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}.csv`, strToU8(`file ${i}`)])));
    expect(expandUploads([upload("many.zip", many)])).toEqual({
      ok: false,
      error: "51 files were selected (counting the files inside zips); the limit is 50 per import.",
    });
  });

  it("imports Spendee's per-wallet files from one zip as one import, pairing the transfer", async () => {
    const db = await useFreshDb();
    const alice = await makeUser(db, "alice@example.com");
    const r = expandUploads([upload("spendee.zip", zipSync({ "Savings.csv": strToU8(SAVINGS), "Joint.csv": strToU8(JOINT) }))]);
    if (!r.ok) throw new Error(r.error);
    const p = await previewImport(alice.id, r.files);
    expect(p).toMatchObject({ ok: true, format: "spendee", transactionsToAdd: 1, transfersToAdd: 1 });
    expect(p.files.map((f) => f.name)).toEqual(["spendee.zip › Joint.csv", "spendee.zip › Savings.csv"]);
    expect((await runImport(alice.id, r.files)).imported).toBe(true);
  });
});

describe("proxy: oversized uploads get the app's message", () => {
  beforeEach(() => {});
  const request = (length: number, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost/data", {
      method: "POST",
      headers: { "content-length": String(length), "next-action": "abc", ...headers },
    });

  it("answers a POST over the Server Action limit with a text/plain 413 carrying the message", async () => {
    const res = proxy(request(IMPORT_MAX_REQUEST_BYTES + 1));
    expect(res.status).toBe(413);
    // Exactly "text/plain": the Next.js client only turns that content type into an Error with the body as message.
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe(IMPORT_TOO_LARGE_MESSAGE);
  });

  it("lets everything else through", () => {
    expect(proxy(request(IMPORT_MAX_REQUEST_BYTES)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(new NextRequest("http://localhost/data", { method: "POST", headers: { "next-action": "abc" } })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(new NextRequest("http://localhost/data")).headers.get("x-middleware-next")).toBe("1");
  });

  it("answers only Server Actions posted to /data, and matches the configured body limit", async () => {
    // The proxy runs for every page (the host check); only an over-limit Server Action post to /data gets the 413.
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|api/|favicon.ico).*)"]);
    const elsewhere = new NextRequest("http://localhost/transactions", {
      method: "POST",
      headers: { "content-length": String(IMPORT_MAX_REQUEST_BYTES + 1), "next-action": "abc" },
    });
    expect(proxy(elsewhere).headers.get("x-middleware-next")).toBe("1");
    const nextConfig = (await import("../next.config")).default;
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe(`${IMPORT_MAX_REQUEST_BYTES / 1024 / 1024}mb`);
  });
});
