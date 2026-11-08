"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES } from "@/lib/constants";
import {
  previewImport,
  runImport,
  type ImportFileInput,
  type ImportOptions,
  type ImportPreview,
  type ImportResult,
} from "@/server/import";

/**
 * What the /data import panel shows. `error` is a request-level failure (no file, too large, too many); problems
 * inside the files are in `preview.problems`.
 */
export type ImportActionState = {
  error?: string;
  fileNames?: string[];
  preview?: ImportPreview;
  result?: ImportResult;
};

const MB = IMPORT_MAX_BYTES / 1024 / 1024;

async function readUpload(
  formData: FormData,
): Promise<{ ok: true; files: ImportFileInput[]; opts: ImportOptions } | { ok: false; error: string }> {
  const uploads = formData.getAll("file").filter((f): f is File => f instanceof File && !(f.name === "" && f.size === 0));
  if (uploads.length === 0) return { ok: false, error: "Choose a file to import." };
  if (uploads.length > IMPORT_MAX_FILES) {
    return { ok: false, error: `${uploads.length} files were selected; the limit is ${IMPORT_MAX_FILES} per import.` };
  }
  const total = uploads.reduce((n, f) => n + f.size, 0);
  if (total > IMPORT_MAX_BYTES) {
    return {
      ok: false,
      error:
        uploads.length === 1
          ? `The file is larger than ${MB} MB. Split it into smaller files and import them one by one.`
          : `The selected files are larger than ${MB} MB in total. Import them in smaller groups.`,
    };
  }
  if (uploads.length === 1 && uploads[0].size === 0) return { ok: false, error: "The file is empty." };
  const timeZone = formData.get("timeZone");
  return {
    ok: true,
    files: await Promise.all(uploads.map(async (f) => ({ name: f.name, text: await f.text() }))),
    opts: {
      // Checkbox semantics: on unless explicitly turned off.
      skipDuplicates: formData.get("skipDuplicates") !== "off",
      // Validated (and replaced by UTC when invalid) in the service.
      timeZone: typeof timeZone === "string" ? timeZone : undefined,
      // Off unless explicitly turned on.
      unpairedTransfersAsEntries: formData.get("unpairedTransfers") === "on",
    },
  };
}

/** Step 1: parse + validate + plan. Writes nothing. Called with a FormData built by the import panel. */
export async function previewImportAction(formData: FormData): Promise<ImportActionState> {
  const user = await requireUser();
  const upload = await readUpload(formData);
  if (!upload.ok) return { error: upload.error };
  return {
    fileNames: upload.files.map((f) => f.name),
    preview: previewImport(user.id, upload.files, upload.opts),
  };
}

/** Step 2: the same validation again (the preview is never trusted), then one all-or-nothing DB transaction. */
export async function runImportAction(formData: FormData): Promise<ImportActionState> {
  const user = await requireUser();
  const upload = await readUpload(formData);
  if (!upload.ok) return { error: upload.error };
  const fileNames = upload.files.map((f) => f.name);
  let result: ImportResult;
  try {
    result = runImport(user.id, upload.files, upload.opts);
  } catch (err) {
    // Validation should make this unreachable; the DB transaction has rolled back either way.
    console.error("[import] unexpected failure", err);
    return { fileNames, error: "The import failed unexpectedly and nothing was saved. Please try again." };
  }
  if (result.imported) revalidatePath("/", "layout");
  return { fileNames, result };
}
