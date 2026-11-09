import { getCurrentUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { buildBackup } from "@/server/export";
import { attachmentHeaders, unauthorized } from "../_shared";

export const dynamic = "force-dynamic";

/** GET /api/export/backup — the signed-in user's whole account as a versioned JSON backup. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const body = JSON.stringify(await buildBackup(user.id), null, 2) + "\n";
  return new Response(body, {
    headers: attachmentHeaders(`expenses-tracker-backup-${todayISO()}.json`, "application/json; charset=utf-8"),
  });
}
