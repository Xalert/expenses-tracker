#!/usr/bin/env node
/**
 * Reset a user's password from the command line (there is no email-based reset):
 *
 *   docker compose exec expenses-tracker node scripts/reset-password.mjs <user ID or email>          # prints a generated password
 *   printf '%s' 'new password' | docker compose exec -T expenses-tracker node scripts/reset-password.mjs <user ID or email> --stdin
 *
 * Sets the new password and deletes every session of that user (all their devices are signed out). The identifier
 * is looked up like the sign-in field: an email when it contains `@`, otherwise a user ID, ignoring case.
 *
 * Plain ESM JavaScript on purpose: the Docker image has Node.js and the app's `pg`, but no tsx and no TypeScript.
 * The hash format is exactly src/lib/password.ts's (`scrypt$N$r$p$<salt b64>$<key b64>`); tests/reset-password.test.ts
 * checks that a hash written here verifies there.
 *
 * DATABASE_URL is required (the container has it). Outside production it refuses the development default database
 * (`expenses` on localhost:5433, the owner's real data), like `npm run db:reset -- --yes` does.
 */
import { randomBytes, scrypt } from "node:crypto";
import { pathToFileURL } from "node:url";

// Keep in step with src/lib/password.ts and src/lib/constants.ts (tests compare them).
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 8;
// Keep in step with DEFAULT_DEV_DATABASE_URL in src/db/index.ts (tests compare them).
export const DEFAULT_DEV_DATABASE_URL = "postgres://expenses:expenses@localhost:5433/expenses";

const USAGE = `Usage: node scripts/reset-password.mjs <user ID or email> [--stdin]

  (no option)  set a random password and print it
  --stdin      read the new password from standard input instead (at least ${MIN_PASSWORD_LENGTH} characters;
               one trailing newline is dropped)

Every session of the user is deleted. Needs DATABASE_URL.`;

/** scrypt hash in the format of src/lib/password.ts. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$")),
    );
  });
}

/** A random password: 20 characters from an alphabet without look-alikes (about 115 bits). */
export function generatePassword(length = 20) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Rejection sampling keeps every character equally likely.
      if (byte < 256 - (256 % alphabet.length) && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/**
 * Set `password` for the account `identifier` names and delete all its sessions, in one transaction.
 * `client` is anything with `query(text, params) → { rows }` (a pg Client, or PGlite in tests).
 * Returns the user's id and user ID, or null when no account matches.
 */
export async function resetPassword(client, identifier, password) {
  const id = String(identifier ?? "").trim().toLowerCase();
  if (!id) return null;
  const column = id.includes("@") ? "email" : "username";
  const passwordHash = await hashPassword(password); // slow: before the transaction
  await client.query("begin");
  try {
    const { rows } = await client.query(
      `update users set password_hash = $1 where lower(${column}) = $2 returning id, username`,
      [passwordHash, id],
    );
    if (rows.length === 0) {
      await client.query("rollback");
      return null;
    }
    const { rows: deleted } = await client.query("delete from sessions where user_id = $1 returning id", [rows[0].id]);
    await client.query("commit");
    return { id: rows[0].id, username: rows[0].username, sessionsDeleted: deleted.length };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

/** Why this DATABASE_URL must not be used, or null. */
export function databaseUrlProblem(url, nodeEnv) {
  if (!url) return "DATABASE_URL is not set. Pass it on the same command, e.g. DATABASE_URL=postgres://… node scripts/reset-password.mjs demo";
  if (nodeEnv !== "production" && url === DEFAULT_DEV_DATABASE_URL) {
    return "Refusing the default development database (expenses on localhost:5433: real data). Use expenses_demo or a scratch database.";
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  if (flags.includes("--help") || args.length !== 1 || flags.some((f) => f !== "--stdin")) {
    console.error(USAGE);
    return 1;
  }
  const problem = databaseUrlProblem(process.env.DATABASE_URL, process.env.NODE_ENV);
  if (problem) {
    console.error(problem);
    return 1;
  }

  const fromStdin = flags.includes("--stdin");
  const password = fromStdin ? await readStdin() : generatePassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
    return 1;
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const user = await resetPassword(client, args[0], password);
    if (!user) {
      console.error(`No account with the ${args[0].includes("@") ? "email" : "user ID"} "${args[0]}".`);
      return 1;
    }
    const signedOut = `${user.sessionsDeleted} ${user.sessionsDeleted === 1 ? "session" : "sessions"} signed out`;
    if (fromStdin) console.log(`Password changed for ${user.username} (${signedOut}).`);
    else console.log(`New password for ${user.username}: ${password}\n(${signedOut}; ask them to change it on /account.)`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
