import "server-only";

/** Headers for a file download that must never be cached (per-user data). */
export function attachmentHeaders(filename: string, contentType: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Route handlers are not covered by the (app) layout's auth: answer 401 ourselves. */
export function unauthorized(): Response {
  return Response.json({ error: "Sign in to export your data." }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
