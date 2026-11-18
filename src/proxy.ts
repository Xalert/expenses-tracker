import { NextResponse, type NextRequest } from "next/server";
import { HOST_MISMATCH_MESSAGE, hostMismatch, hostMismatchLogLine } from "@/lib/origin-check";

/**
 * Explains the one failure a misconfigured reverse proxy causes: Next.js refuses every Server Action whose Origin
 * does not match the Host / X-Forwarded-Host it received, with a bare 500 (see src/lib/origin-check.ts). The same
 * check runs here first, so the request is refused with a log line that names the fix and a readable answer:
 *
 * - a fetch action from a hydrated page (`Next-Action` header): 403 `text/plain` with HOST_MISMATCH_MESSAGE, which
 *   the Next.js client throws as the error's message; `src/app/error.tsx` shows it;
 * - a plain form post (no JavaScript yet): 403 with a small HTML page saying the same.
 *
 * Nothing else is touched: other methods and requests that pass the check go on unchanged (Next.js still runs its
 * own check). Not an auth layer — every action still calls requireUser().
 */
export function proxy(request: NextRequest) {
  if (request.method !== "POST") return NextResponse.next();
  const isFetchAction = request.headers.has("next-action");
  const type = request.headers.get("content-type") ?? "";
  const isFormPost = type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded");
  if (!isFetchAction && !isFormPost) return NextResponse.next();

  const mismatch = hostMismatch(request.headers);
  if (!mismatch) return NextResponse.next();

  console.error(hostMismatchLogLine(mismatch, request.nextUrl.pathname));
  if (isFetchAction) {
    return new NextResponse(HOST_MISMATCH_MESSAGE, { status: 403, headers: { "content-type": "text/plain" } });
  }
  return new NextResponse(errorPage(), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A self-contained page (no app CSS reaches a proxy response): the Sand / Graphite background and text colours. */
function errorPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Request refused</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#2b241f;background:#f4efe7}@media (prefers-color-scheme:dark){body{color:#ededef;background:#141518}}</style></head>
<body><h1>Request refused</h1><p>${HOST_MISMATCH_MESSAGE}</p></body></html>`;
}

export const config = {
  // Pages only: static files, images and the GET-only API routes never carry a Server Action.
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico).*)"],
};
