#!/usr/bin/env node
// Cut a release: `make release VERSION=x.y.z [PUSH=1] [DRY_RUN=1]`, or `node scripts/release.mjs x.y.z [--push] [--dry-run]`.
//
// Refuses unless: the version is X.Y.Z and newer than the newest vX.Y.Z tag; the branch is `main`; the working tree
// is clean; `main` is exactly `origin/main` (after a fetch); typecheck, lint and the tests pass (what `make check`
// runs). Then it sets the version in package.json / package-lock.json, turns the CHANGELOG.md "Unreleased" section
// into this version's section (when that section is empty, the commit subjects since the last tag are used), commits
// "Release vX.Y.Z", and adds the annotated tag vX.Y.Z. Nothing leaves the machine without --push, which pushes main
// and the tag together (the tag makes GitHub Actions publish the X.Y.Z, X.Y and X images).
// --dry-run runs every check and prints the changelog entry, but changes and pushes nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = path.join(root, "CHANGELOG.md");
const UNRELEASED = "## Unreleased";

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** -1 / 0 / 1 for two X.Y.Z strings. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The newest vX.Y.Z tag name among `tags`, or null. Other tags are ignored. */
export function newestTag(tags) {
  const versions = tags.map((t) => t.trim()).filter((t) => /^v/.test(t) && SEMVER.test(t.slice(1)));
  versions.sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  return versions[0] ?? null;
}

/**
 * The changelog with "Unreleased" turned into `## version (date)` and a new empty "Unreleased" above it.
 * `fallback` (lines) is used when the Unreleased section has no text of its own. Returns { text, entry }.
 */
export function releaseChangelog(changelog, version, date, fallback) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === UNRELEASED);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  let body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) body = fallback.length ? fallback.join("\n") : "- No notable changes.";
  const entry = `## ${version} (${date})\n\n${body}`;
  const text = [...lines.slice(0, start), UNRELEASED, "", entry, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
  return { text: text.endsWith("\n") ? text : `${text}\n`, entry };
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const r = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) fail(`\`${command} ${args.join(" ")}\` failed`);
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  for (const f of flags) if (!["--push", "--dry-run"].includes(f)) fail(`unknown option ${f}`);
  const push = flags.has("--push");
  const dryRun = flags.has("--dry-run");
  if (push && dryRun) fail("--push and --dry-run exclude each other");
  if (positional.length !== 1) fail("usage: make release VERSION=x.y.z [PUSH=1] [DRY_RUN=1]");
  const version = positional[0].replace(/^v/, "");
  if (!SEMVER.test(version)) fail(`"${positional[0]}" is not a version of the form X.Y.Z (e.g. 1.2.3)`);
  const tag = `v${version}`;

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") fail(`releases are cut from main; this is ${branch}`);
  if (git("status", "--porcelain")) fail("the working tree has uncommitted changes (git status)");

  console.log("Fetching origin ...");
  git("fetch", "--quiet", "--tags", "origin", "main");
  const head = git("rev-parse", "HEAD");
  const upstream = git("rev-parse", "origin/main");
  if (head !== upstream) {
    const [behind, ahead] = git("rev-list", "--left-right", "--count", "origin/main...HEAD").split(/\s+/);
    fail(`main is not origin/main (${ahead} ahead, ${behind} behind); pull or push first`);
  }

  const last = newestTag(git("tag", "--list", "v*").split("\n").filter(Boolean));
  if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);
  if (last && compareVersions(version, last.slice(1)) <= 0) fail(`${version} is not newer than the last release ${last}`);

  run("npm", ["run", "-s", "typecheck"]);
  run("npm", ["run", "-s", "lint"]);
  run("npm", ["test"]);

  const subjects = git("log", "--no-merges", "--format=%s", ...(last ? [`${last}..HEAD`] : []))
    .split("\n")
    .filter((s) => s && !/^Release v\d/.test(s))
    .map((s) => `- ${s}`);
  const date = new Date().toISOString().slice(0, 10);
  const { text, entry } = releaseChangelog(readFileSync(CHANGELOG, "utf8"), version, date, subjects);

  console.log(`\nRelease ${tag} (last release: ${last ?? "none"}). Changelog entry:\n\n${entry}\n`);
  if (dryRun) {
    console.log("Dry run: nothing was changed. Without DRY_RUN=1 this commits and tags; PUSH=1 also pushes.");
    return;
  }

  writeFileSync(CHANGELOG, text);
  run("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"]);
  git("add", "CHANGELOG.md", "package.json", "package-lock.json");
  git("commit", "--quiet", "-m", `Release ${tag}`);
  git("tag", "-a", tag, "-m", `${tag}\n\n${entry.split("\n").slice(2).join("\n")}`);
  console.log(`Committed "Release ${tag}" and tagged ${tag}.`);

  if (push) {
    run("git", ["push", "--atomic", "origin", "main", `refs/tags/${tag}`]);
    console.log(`Pushed. GitHub Actions publishes the ${version} image from the tag.`);
  } else {
    console.log(`Not pushed. To publish: git push --atomic origin main ${tag}`);
    console.log(`To undo instead: git tag -d ${tag} && git reset --hard HEAD~1`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
