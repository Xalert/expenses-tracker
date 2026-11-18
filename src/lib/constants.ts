// Client-safe constants shared by forms and services.
export const MIN_PASSWORD_LENGTH = 8;

/** Import upload cap (/data), for the whole selection: checked in the browser before uploading and again on the server. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Max CSV data rows / backup transactions + transfers per import (whole selection). */
export const IMPORT_MAX_ROWS = 50_000;
/** Max files selected for one import (/data). */
export const IMPORT_MAX_FILES = 50;
/**
 * The largest import request accepted: the 5 MB of files plus room for the multipart overhead. Must equal
 * `serverActions.bodySizeLimit` in next.config.ts; `src/proxy.ts` answers anything larger with
 * `IMPORT_TOO_LARGE_MESSAGE` before Next.js would refuse it with its own, generic error.
 */
export const IMPORT_MAX_REQUEST_BYTES = 6 * 1024 * 1024;
/** What the import panel shows when the server refuses an upload as too large (sent as text/plain by the proxy). */
export const IMPORT_TOO_LARGE_MESSAGE =
  "The upload is too large: the selected files can be at most 5 MB in total. Import them in smaller groups, or split a large file.";
