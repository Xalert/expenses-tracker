import "server-only";
import { unzipSync } from "fflate";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES } from "@/lib/constants";
import type { ImportFileInput } from "./import";

// Turning uploaded files into the importer's input: text files as they are, and a .zip (e.g. Spendee's per-wallet
// CSVs packed together) unpacked into its importable files. Zips are recognised by their content (the `PK` header),
// like every other format, not by the file name.

export type UploadedFile = { name: string; bytes: Uint8Array };

/** File types taken from inside a zip (what the file picker accepts); everything else in it is skipped. */
const IMPORTABLE = /\.(csv|tsv|txt|json)$/i;
const MB = IMPORT_MAX_BYTES / 1024 / 1024;

/** A local file header (`PK\x03\x04`) or the end record of an empty zip (`PK\x05\x06`). */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
  );
}

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/**
 * Text of every upload, with zips unpacked (their files named `archive.zip › Joint.csv`). The unpacked size counts
 * towards the same 5 MB limit as plain files; it is checked against the sizes the zip declares before anything is
 * inflated (so a zip bomb is refused cheaply) and again on the inflated data. Folders, macOS metadata
 * (`__MACOSX/`, dot files) and other file types inside a zip are skipped; nested zips are not opened.
 */
export function expandUploads(uploads: UploadedFile[]): { ok: true; files: ImportFileInput[] } | { ok: false; error: string } {
  const files: ImportFileInput[] = [];
  let total = uploads.reduce((n, u) => n + (isZip(u.bytes) ? 0 : u.bytes.length), 0);
  const tooLarge = (zip: string) =>
    `The files in “${zip}” are larger than ${MB} MB in total once unpacked. Import them in smaller groups.`;

  for (const upload of uploads) {
    if (!isZip(upload.bytes)) {
      files.push({ name: upload.name, text: decode(upload.bytes) });
      continue;
    }
    let declaredTooLarge = false;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(upload.bytes, {
        filter: (f) => {
          const base = f.name.split("/").pop() ?? "";
          if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || base.startsWith(".") || !IMPORTABLE.test(base)) {
            return false;
          }
          total += f.originalSize;
          if (total > IMPORT_MAX_BYTES) declaredTooLarge = true;
          return !declaredTooLarge;
        },
      });
    } catch (err) {
      return {
        ok: false,
        error: `“${upload.name}” could not be read as a zip file (${err instanceof Error ? err.message : "unreadable"}). Unpack it and select the files instead.`,
      };
    }
    if (declaredTooLarge) return { ok: false, error: tooLarge(upload.name) };
    const names = Object.keys(entries).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      return { ok: false, error: `“${upload.name}” contains no CSV or JSON files to import.` };
    }
    // The declared sizes were already counted; correct them by what was actually inflated.
    let inflated = 0;
    for (const name of names) {
      inflated += entries[name].length;
      files.push({ name: `${upload.name} › ${name}`, text: decode(entries[name]) });
    }
    if (inflated > IMPORT_MAX_BYTES) return { ok: false, error: tooLarge(upload.name) };
  }
  if (files.length > IMPORT_MAX_FILES) {
    const zipped = uploads.some((u) => isZip(u.bytes)) ? " (counting the files inside zips)" : "";
    return { ok: false, error: `${files.length} files were selected${zipped}; the limit is ${IMPORT_MAX_FILES} per import.` };
  }
  return { ok: true, files };
}
