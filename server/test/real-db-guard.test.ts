/**
 * Only an installed app opens the default database, and no app opens one a
 * newer build has changed underneath it.
 *
 * A worktree build whose migration rebuilt a table with a new primary key ran
 * against the default database, because nothing had told it where else to go.
 * The installed release then prepared its `ON CONFLICT(pane_id)` upsert against
 * a table keyed by two columns and exited on its first line, every launch. Two
 * holes, and this file closes both: a run from source (or from a binary inside
 * a checkout) has to name its database, and a database records which schema
 * generation last wrote it, so an older build says so instead of crashing.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultDbRefusal, SCHEMA_GENERATION } from "../src/db.ts";

const SRC = resolve(import.meta.dir, "../src");
const DB_TS = join(SRC, "db.ts");
const scratch = mkdtempSync(join(tmpdir(), "agx-realdb-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("defaultDbRefusal", () => {
  const home = "/home/orbit";
  const real = `${home}/.local/share/agentglass/agentglass.db`;

  test("a run from source is refused the default database", () => {
    const why = defaultDbRefusal(real, { compiled: false, execPath: "/usr/bin/bun", tmp: "/tmp" });
    expect(why).not.toBeNull();
    expect(why!).toContain(real);
    expect(why!).toContain("AGENTGLASS_DB");
    expect(why!).toContain("AGENTGLASS_STATE_DIR");
  });

  test("a compiled binary inside a checkout is a build, not an install", () => {
    const repo = join(scratch, "checkout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "electron", "staging"), { recursive: true });
    writeFileSync(join(repo, "electron", "build.mjs"), "");
    const why = defaultDbRefusal(real, { compiled: true, execPath: join(repo, "electron", "staging", "agentglass-server"), tmp: "/tmp" });
    expect(why).not.toBeNull();
  });

  test("a build copied under the temp directory is still a build", () => {
    expect(defaultDbRefusal(real, { compiled: true, execPath: "/tmp/probe/agentglass-server", tmp: "/tmp" })).not.toBeNull();
  });

  test("a home directory kept in git does not make an install a checkout", () => {
    const home2 = join(scratch, "dotfiles-home");
    mkdirSync(join(home2, ".git"), { recursive: true });
    mkdirSync(join(home2, ".local", "share", "agentglass-desktop", "resources"), { recursive: true });
    const exe = join(home2, ".local", "share", "agentglass-desktop", "resources", "agentglass-server");
    expect(defaultDbRefusal(real, { compiled: true, execPath: exe, tmp: "/nonexistent-tmp" })).toBeNull();
  });

  test("an installed binary opens it", () => {
    const install = join(scratch, "installed", "resources");
    mkdirSync(install, { recursive: true });
    expect(defaultDbRefusal(real, { compiled: true, execPath: join(install, "agentglass-server"), tmp: "/nonexistent-tmp" })).toBeNull();
  });

  test("a default that lands in the scratch directory belongs to nobody, and is allowed", () => {
    expect(defaultDbRefusal("/tmp/x/data/agentglass/agentglass.db", { compiled: false, execPath: "/usr/bin/bun", tmp: "/tmp" })).toBeNull();
  });
});

/** Import db.ts in a process that is NOT under `bun test`, the way a dev
 *  server or a `bun -e` in a worktree does. Everything it could touch is
 *  under `root`; its temp directory is a sibling, so the data directory is
 *  outside it and counts as a real one. */
async function importDb(root: string, extra: Record<string, string> = {}) {
  for (const d of ["tmp", "data", "config", "cache", "home"]) mkdirSync(join(root, d), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    ...extra,
  };
  const p = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(DB_TS)})`], {
    cwd: join(root, "home"), env, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe("a run from source, outside bun test", () => {
  test("is refused the default database and does not create it", async () => {
    const root = join(scratch, "refused");
    const r = await importDb(root);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("AGENTGLASS_DB");
    expect(existsSync(join(root, "data", "agentglass", "agentglass.db"))).toBe(false);
  });

  test("opens the same file when it is named explicitly", async () => {
    const root = join(scratch, "named");
    const file = join(root, "data", "agentglass", "agentglass.db");
    mkdirSync(join(root, "data", "agentglass"), { recursive: true });
    const r = await importDb(root, { AGENTGLASS_DB: file });
    expect(r.err).not.toContain("refusing");
    expect(r.code).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  test("opens its own state directory's database", async () => {
    const root = join(scratch, "state");
    const r = await importDb(root, { AGENTGLASS_STATE_DIR: join(root, "state") });
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "state", "agentglass.db"))).toBe(true);
  });
});

describe("schema generation", () => {
  function generation(file: string): number | null {
    const d = new Database(file, { readonly: true });
    try { return d.query<{ generation: number }, []>("SELECT generation FROM schema_generation").get()?.generation ?? null; }
    finally { d.close(); }
  }

  test("a new database records this build's generation", async () => {
    const root = join(scratch, "gen-new");
    const file = join(root, "gen.db");
    mkdirSync(root, { recursive: true });
    const r = await importDb(root, { AGENTGLASS_DB: file });
    expect(r.code).toBe(0);
    expect(generation(file)).toBe(SCHEMA_GENERATION);
  });

  test("a database from a newer generation is refused in words, and left untouched", async () => {
    const root = join(scratch, "gen-newer");
    const file = join(root, "gen.db");
    mkdirSync(root, { recursive: true });
    const d = new Database(file, { create: true });
    d.exec("CREATE TABLE schema_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, written_at INTEGER NOT NULL)");
    d.run("INSERT INTO schema_generation VALUES (1, ?, 0)", [SCHEMA_GENERATION + 1]);
    d.close();
    const before = statSync(file).size;
    const r = await importDb(root, { AGENTGLASS_DB: file });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("database is newer than this app");
    expect(generation(file)).toBe(SCHEMA_GENERATION + 1);
    // Nothing was created in it: no events table from this older build.
    const d2 = new Database(file, { readonly: true });
    const tables = d2.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    d2.close();
    expect(tables).toEqual(["schema_generation"]);
    expect(statSync(file).size).toBe(before);
  });
});

/*
 * What an older build cannot survive: a table dropped, renamed or rebuilt, a
 * column dropped, an index dropped (a unique one is what `ON CONFLICT` names).
 * Each is either not done, or done together with a bump of SCHEMA_GENERATION
 * and a line here saying which generation it belongs to — so an older build
 * stops with a sentence instead of an SQLite error.
 *
 * FROZEN is the generation this list was last closed at: an entry at or below
 * it must already be here, so a new one has to name a later generation, and
 * that only passes once SCHEMA_GENERATION has been bumped to it. Whoever bumps
 * moves FROZEN up with it.
 *
 * Ceilings: uppercase SQL on one line only (lowercase would take in the git
 * diff parser's "rename to"), and a key changed by editing a `CREATE TABLE` or
 * `CREATE UNIQUE INDEX` in place is not a statement this can see.
 */
const FROZEN = 1;
const FROZEN_KEYS = [
  "db.ts: DROP INDEX IF EXISTS idx_events_project",
  "db.ts: DROP INDEX IF EXISTS idx_events_cwd",
  "db.ts: DROP INDEX IF EXISTS idx_events_type_cov",
];
const ALLOWED: Record<string, number> = {
  // Plain lookup indexes, never unique, dropped before generation 1 existed.
  "db.ts: DROP INDEX IF EXISTS idx_events_project": 0,
  "db.ts: DROP INDEX IF EXISTS idx_events_cwd": 0,
  "db.ts: DROP INDEX IF EXISTS idx_events_type_cov": 0,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

describe("backward compatible schema", () => {
  test("no statement drops, renames or rebuilds what an older build reads, unless the generation says so", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        const m = /\b(DROP TABLE|DROP COLUMN|DROP INDEX|RENAME TO|RENAME COLUMN)\b[^"'`]*/.exec(t);
        if (m) found.push(`${rel}: ${m[0].trim()}`);
      }
    }
    const unexplained = found.filter((f) => !(f in ALLOWED) || ALLOWED[f]! > SCHEMA_GENERATION);
    expect(unexplained).toEqual([]);
    const sneaked = Object.keys(ALLOWED).filter((k) => ALLOWED[k]! <= FROZEN && !FROZEN_KEYS.includes(k));
    expect(sneaked).toEqual([]);
  });
});
