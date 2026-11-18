import { NextResponse, type NextRequest } from "next/server";
import { IMPORT_MAX_REQUEST_BYTES, IMPORT_TOO_LARGE_MESSAGE } from "@/lib/constants";

/**
 * Only for the Server Actions posted to /data (the import upload). A request larger than the Server Action body
 * limit would be refused by Next.js with an error the browser only sees as "An unexpected response was received
 * from the server"; answering it here with a 413 and a `text/plain` body (exactly that content type) makes the
 * client throw an Error carrying our message, which the import panel shows. Requests without a Content-Length fall
 * through to Next.js's own limit. Authentication stays in the action (`requireUser`).
 */
export function proxy(request: NextRequest) {
  const length = Number(request.headers.get("content-length") ?? "");
  if (request.method === "POST" && Number.isFinite(length) && length > IMPORT_MAX_REQUEST_BYTES) {
    return new NextResponse(IMPORT_TOO_LARGE_MESSAGE, {
      status: 413,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [{ source: "/data", has: [{ type: "header", key: "next-action" }] }],
};
