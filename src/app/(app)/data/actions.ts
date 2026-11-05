"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { IMPORT_MAX_BYTES } from "@/lib/constants";
import { previewImport, runImport, type ImportPreview, type ImportResult } from "@/server/import";

/**
 * What the /data import panel shows. `error` is a request-level failure (no file, too large); problems inside
 * the file are in `preview.problems`.
 */
export type ImportActionState = {
  error?: string;
  fileName?: string;
  preview?: ImportPreview;
  result?: ImportResult;
};

const TOO_LARGE = `The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it into smaller files and import them one by one.`;

async function readUpload(
  formData: FormData,
): Promise<{ ok: true; text: string; fileName: string; skipDuplicates: boolean } | { ok: false; error: string }> {
  const file = formData.get("file");
  if (!(file instanceof File) || (file.name === "" && file.size === 0)) return { ok: false, error: "Choose a file to import." };
  if (file.size === 0) return { ok: false, error: "The file is empty." };
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, error: TOO_LARGE };
  return {
    ok: true,
    text: await file.text(),
    fileName: file.name,
    // Checkbox semantics: on unless explicitly turned off.
    skipDuplicates: formData.get("skipDuplicates") !== "off",
  };
}

/** Step 1: parse + validate + plan. Writes nothing. Called with a FormData built by the import panel. */
export async function previewImportAction(formData: FormData): Promise<ImportActionState> {
  const user = await requireUser();
  const upload = await readUpload(formData);
  if (!upload.ok) return { error: upload.error };
  return {
    fileName: upload.fileName,
    preview: previewImport(user.id, upload.text, { skipDuplicates: upload.skipDuplicates }),
  };
}

/** Step 2: the same validation again (the preview is never trusted), then one all-or-nothing DB transaction. */
export async function runImportAction(formData: FormData): Promise<ImportActionState> {
  const user = await requireUser();
  const upload = await readUpload(formData);
  if (!upload.ok) return { error: upload.error };
  let result: ImportResult;
  try {
    result = runImport(user.id, upload.text, { skipDuplicates: upload.skipDuplicates });
  } catch (err) {
    // Validation should make this unreachable; the DB transaction has rolled back either way.
    console.error("[import] unexpected failure", err);
    return { fileName: upload.fileName, error: "The import failed unexpectedly and nothing was saved. Please try again." };
  }
  if (result.imported) revalidatePath("/", "layout");
  return { fileName: upload.fileName, result };
}
