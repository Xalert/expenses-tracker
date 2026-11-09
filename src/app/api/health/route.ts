import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

/** Public liveness/readiness probe for Docker HEALTHCHECK and reverse proxies. */
export async function GET() {
  try {
    await (await getDb()).execute(sql`select 1`);
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[health] database check failed", err);
    return Response.json({ status: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
