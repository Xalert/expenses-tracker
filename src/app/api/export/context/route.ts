import { getCurrentUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { buildContext } from "@/server/export";
import { attachmentHeaders, unauthorized } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/context — the signed-in user's wallets and categories only (no transactions), as JSON for companion
 * tools such as the Statement Importer artifact. "Copy" on /data fetches the same response.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const body = JSON.stringify(await buildContext(user.id), null, 2) + "\n";
  return new Response(body, {
    headers: attachmentHeaders(`expenses-tracker-context-${todayISO()}.json`, "application/json; charset=utf-8"),
  });
}
