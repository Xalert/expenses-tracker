// Client-safe constants shared by forms and services.
export const MIN_PASSWORD_LENGTH = 8;

/** Import upload cap (/data), for the whole selection: checked in the browser before uploading and again on the server. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Max CSV data rows / backup transactions + transfers per import (whole selection). */
export const IMPORT_MAX_ROWS = 50_000;
/** Max files selected for one import (/data). */
export const IMPORT_MAX_FILES = 50;
