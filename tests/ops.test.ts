/**
 * Operations files: the release script's pure parts (scripts/release.mjs), the two Compose files' backup service
 * staying in step, and the npm scripts that must run on any shell.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, newestTag, releaseChangelog, SEMVER } from "../scripts/release.mjs";
import { DEFAULT_DEMO_DATABASE_URL, demoDatabaseUrl } from "../scripts/with-demo-db.mjs";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("release script", () => {
  it("accepts only X.Y.Z versions", () => {
    for (const ok of ["0.1.0", "1.0.0", "10.20.30"]) expect(SEMVER.test(ok)).toBe(true);
    for (const bad of ["1.0", "v1.0.0", "01.0.0", "1.0.0-rc.1", "1.0.0 ", "x.y.z"]) expect(SEMVER.test(bad)).toBe(false);
  });

  it("compares versions numerically and finds the newest vX.Y.Z tag", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
    expect(newestTag(["v1.9.0", "v1.10.0", "v1.2.0", "nightly", "v2.0.0-rc.1"])).toBe("v1.10.0");
    expect(newestTag([])).toBeNull();
  });

  it("turns Unreleased into the version's section and starts a new empty one", () => {
    const before = "# Changelog\n\nIntro.\n\n## Unreleased\n\n- Added a thing\n\n## 1.0.0 (2026-01-01)\n\n- First\n";
    const { text, entry } = releaseChangelog(before, "1.1.0", "2026-02-01", ["- a commit"]);
    expect(entry).toBe("## 1.1.0 (2026-02-01)\n\n- Added a thing");
    expect(text).toBe(
      "# Changelog\n\nIntro.\n\n## Unreleased\n\n## 1.1.0 (2026-02-01)\n\n- Added a thing\n\n## 1.0.0 (2026-01-01)\n\n- First\n",
    );
  });

  it("uses the commit subjects when Unreleased is empty", () => {
    const { entry } = releaseChangelog("# Changelog\n\n## Unreleased\n", "0.2.0", "2026-03-01", ["- One", "- Two"]);
    expect(entry).toBe("## 0.2.0 (2026-03-01)\n\n- One\n- Two");
    expect(() => releaseChangelog("# Changelog\n", "0.2.0", "2026-03-01", [])).toThrow(/Unreleased/);
  });

  it("the committed CHANGELOG.md has an Unreleased section", () => {
    expect(read("CHANGELOG.md")).toMatch(/^## Unreleased$/m);
  });
});

describe("Compose files", () => {
  const backupService = (file: string) => {
    const text = read(file);
    const start = text.indexOf("\n  backup:\n");
    const end = text.indexOf("\nvolumes:\n", start);
    expect(start).toBeGreaterThan(0);
    return text.slice(start, end);
  };

  it("deploy/compose.yaml and docker-compose.yml define the same on-demand backup service", () => {
    const deployed = backupService("deploy/compose.yaml");
    expect(backupService("docker-compose.yml")).toBe(deployed);
    expect(deployed).toContain('profiles: ["backup"]');
    expect(deployed).toContain("pg_dump -Fc");
    expect(deployed).toContain("./backups:/backups");
    expect(deployed).toContain("BACKUP_INTERVAL_HOURS: ${BACKUP_INTERVAL_HOURS:-}");
    expect(deployed).toContain('restart: "no"'); // a one-shot `up` must not repeat; the loop is opt-in
  });

  it("both Compose files pass TRUST_PROXY to the app, off by default", () => {
    expect(read("deploy/compose.yaml")).toContain("TRUST_PROXY: ${TRUST_PROXY:-false}");
    expect(read("docker-compose.yml")).toContain('TRUST_PROXY: "false"');
  });

  it("the backup service uses the same Postgres image as db", () => {
    for (const file of ["deploy/compose.yaml", "docker-compose.yml"]) {
      const images = [...read(file).matchAll(/image: (postgres:\S+)/g)].map((m) => m[1]);
      expect(images).toHaveLength(2);
      expect(new Set(images).size).toBe(1);
    }
  });
});

describe("npm scripts", () => {
  const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("build and start set NODE_ENV without shell syntax (Windows cmd)", () => {
    expect(scripts.build).toBe("node scripts/next-production.mjs build");
    expect(scripts.start).toBe("node scripts/next-production.mjs start");
  });

  it("no script sets an environment variable inline (VAR=value is not valid in Windows cmd)", () => {
    for (const [name, script] of Object.entries(scripts)) expect(script, name).not.toMatch(/(^|\s|&&)[A-Z_]+=/);
  });

  it("dev:demo and demo:reset run every step through the demo-database wrapper", () => {
    for (const name of ["dev:demo", "demo:reset"]) {
      const steps = scripts[name].split("&&").map((s) => s.trim());
      for (const step of steps) expect(step, name).toMatch(/^node scripts\/with-demo-db\.mjs /);
    }
    expect(scripts["demo:reset"]).toContain("scripts/reset.ts --demo --yes");
  });
});

describe("scripts/with-demo-db.mjs", () => {
  it("uses expenses_demo and ignores an inherited DATABASE_URL", () => {
    expect(demoDatabaseUrl({})).toBe(DEFAULT_DEMO_DATABASE_URL);
    expect(new URL(DEFAULT_DEMO_DATABASE_URL).pathname).toBe("/expenses_demo");
    expect(demoDatabaseUrl({ DATABASE_URL: "postgres://expenses:expenses@localhost:5433/expenses" })).toBe(
      DEFAULT_DEMO_DATABASE_URL,
    );
    expect(demoDatabaseUrl({ DEMO_DATABASE_URL: "postgresql://u:p@db.lan:5432/expenses_demo" })).toBe(
      "postgresql://u:p@db.lan:5432/expenses_demo",
    );
  });

  it("refuses any other database in DEMO_DATABASE_URL", () => {
    for (const url of [
      "postgres://expenses:expenses@localhost:5433/expenses",
      "postgres://expenses:expenses@localhost:5433/",
      "postgres://expenses:expenses@localhost:5433",
      "postgres://expenses:expenses@localhost:5433/expenses_demo2",
      "postgres://expenses:expenses@localhost:5433/expenses_demo/x",
      "mysql://u:p@localhost/expenses_demo",
      "not a url",
    ]) {
      expect(() => demoDatabaseUrl({ DEMO_DATABASE_URL: url }), url).toThrow();
    }
  });

  it("refuses in a real run, before starting the command", () => {
    const run = spawnSync(process.execPath, [path.join(root, "scripts/with-demo-db.mjs"), "node", "-e", "console.log('ran')"], {
      env: { ...process.env, DEMO_DATABASE_URL: "postgres://expenses:expenses@localhost:5433/expenses" },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("ran");
    expect(run.stderr).toContain("Refusing");

    const ok = spawnSync(
      process.execPath,
      [path.join(root, "scripts/with-demo-db.mjs"), process.execPath, "-e", "console.log(process.env.DATABASE_URL)"],
      { env: { ...process.env, DATABASE_URL: "postgres://x@localhost/expenses", DEMO_DATABASE_URL: "" }, encoding: "utf8" },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe(DEFAULT_DEMO_DATABASE_URL);
  });
});
