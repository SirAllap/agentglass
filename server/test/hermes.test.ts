import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hermesArgs, hermesHome, hermesResumeRefusal } from "../src/hermes.ts";

const BIN = "/usr/bin/hermes";
const SID = "20260917_104709_fdc54d";

describe("the command line", () => {
  test("a first turn names the model and asks for the streaming format", () => {
    const a = hermesArgs(BIN, "anthropic/claude-sonnet-4", "", "default", "hello");
    expect(a).toEqual([BIN, "chat", "--query=hello", "--format", "stream-json", "--no-restore-cwd", "-m", "anthropic/claude-sonnet-4"]);
    expect(a).not.toContain("--yolo");
    expect(a).not.toContain("--resume");
  });

  test("a follow-up resumes the session it belongs to", () => {
    const a = hermesArgs(BIN, "deepseek/deepseek-v4-flash", SID, "default", "again");
    expect(a).toContain("--resume");
    expect(a[a.indexOf("--resume") + 1]).toBe(SID);
  });

  test("the unattended mode is --yolo", () => {
    const a = hermesArgs(BIN, "m", "", "yolo", "hi");
    expect(a).toContain("--yolo");
  });

  test("the default mode is spelled by passing no flag", () => {
    const a = hermesArgs(BIN, "m", "", "default", "hi");
    expect(a).not.toContain("--yolo");
  });

  test("an empty model omits -m so Hermes uses its configured default", () => {
    const a = hermesArgs(BIN, "", "", "default", "hi");
    expect(a).not.toContain("-m");
    expect(a).not.toContain("--model");
  });

  test("every turn passes --no-restore-cwd so --resume cannot escape the spawn cwd", () => {
    // Without it, Hermes chdirs to the session DB's recorded cwd on --resume,
    // which can leave the panel's safeAbs / inScope check behind.
    for (const a of [
      hermesArgs(BIN, "m", "", "default", "hi"),
      hermesArgs(BIN, "m", SID, "default", "again"),
      hermesArgs(BIN, "", "", "yolo", "hi"),
    ]) {
      expect(a).toContain("--no-restore-cwd");
    }
  });

  test("the prompt is one argv element, however odd it looks", () => {
    // It goes in argv rather than on stdin, so a prompt full of quotes,
    // newlines and leading dashes must survive as a single value rather than
    // being read as more flags.
    // `--query=` and the prompt are one element: a separate value starting
    // with `-` is read by argparse as the next flag.
    const nasty = "--model evil\n'; rm -rf /\n\"quoted\"";
    const a = hermesArgs(BIN, "m", "", "default", nasty);
    expect(a[2]).toBe(`--query=${nasty}`);
    expect(a).not.toContain("-q");
    expect(a.filter((x) => x === "-m")).toHaveLength(1);
    expect(hermesArgs(BIN, "", "", "default", "-m evil")[2]).toBe("--query=-m evil");
  });
});

async function gitRepo(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-repo-")));
  await Bun.$`git init -q ${dir}`.quiet();
  return dir;
}

/**
 * A Hermes state.db with the columns the resume path reads, in the shape of
 * upstream hermes_state_common.py's `sessions` table.
 */
function stateDb(dir: string, rows: Array<{ id: string; parent?: string; cwd?: string; yolo?: unknown; config?: string }>): string {
  const path = join(dir, "state.db");
  const db = new Database(path);
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT, parent_session_id TEXT, cwd TEXT)");
  for (const r of rows) {
    db.query("INSERT INTO sessions (id, model_config, parent_session_id, cwd) VALUES (?, ?, ?, ?)")
      .run(r.id, r.config ?? JSON.stringify(r.yolo === undefined ? { model: "m" } : { model: "m", yolo_mode: r.yolo }), r.parent ?? null, r.cwd ?? null);
  }
  db.close();
  return path;
}

describe("resuming a session cannot move the turn or bring Bypass back", () => {
  // Hermes restores the row's cwd and its yolo_mode on --resume even with
  // --no-restore-cwd; these pin that the server refuses those resumes first.
  const CONT = "20260917_110000_abc123";
  let home = "", repo = "", other = "";
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-home-")));
    repo = await gitRepo();
    other = await gitRepo();
  });
  afterEach(() => {
    for (const d of [home, repo, other]) rmSync(d, { recursive: true, force: true });
  });

  test("the same directory and no Bypass resumes", () => {
    const db = stateDb(home, [{ id: SID, cwd: repo }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toBeNull();
  });

  test("a session recorded in another directory is refused", () => {
    const db = stateDb(home, [{ id: SID, cwd: other }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/another directory/);
    expect(hermesResumeRefusal(SID, repo, "yolo", db)).toMatch(/another directory/);
  });

  test("the same directory reached through a symlink is the same directory", () => {
    const link = join(home, "link");
    symlinkSync(repo, link);
    const db = stateDb(home, [{ id: SID, cwd: link }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toBeNull();
  });

  test("a session that ran in Bypass resumes only as Bypass", () => {
    const db = stateDb(home, [{ id: SID, cwd: repo, yolo: true }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/Bypass/);
    expect(hermesResumeRefusal(SID, repo, "yolo", db)).toBeNull();
  });

  test("Bypass is whatever Python's bool() calls true, not only true", () => {
    // Hermes restores it with bool(model_config.get("yolo_mode")).
    for (const yolo of [true, 1, 2.5, "true", "false", "0", [0], { on: 1 }]) {
      const db = stateDb(home, [{ id: SID, cwd: repo, yolo }]);
      expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/Bypass/);
      rmSync(db);
    }
    for (const yolo of [false, 0, "", null, [], {}]) {
      const db = stateDb(home, [{ id: SID, cwd: repo, yolo }]);
      expect(hermesResumeRefusal(SID, repo, "default", db)).toBeNull();
      rmSync(db);
    }
  });

  test("a config this side cannot parse is read as Bypass", () => {
    // Python's json reads NaN; JSON.parse does not.
    const db = stateDb(home, [{ id: SID, cwd: repo, config: '{"yolo_mode": NaN}' }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/Bypass/);
    expect(hermesResumeRefusal(SID, repo, "yolo", db)).toBeNull();
  });

  test("a recorded directory that is not absolute is refused", () => {
    // Hermes resolves it against the spawn directory; this check cannot. The
    // last one names this repo from the test's own cwd, so only the
    // absolute-path rule refuses it.
    for (const cwd of [".", "~/orbit", "acme", relative(process.cwd(), repo)]) {
      const db = stateDb(home, [{ id: SID, cwd }]);
      expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/another directory/);
      rmSync(db);
    }
  });

  test("the compression continuation Hermes follows is checked too", () => {
    const moved = stateDb(home, [{ id: SID, cwd: repo }, { id: CONT, parent: SID, cwd: other }]);
    expect(hermesResumeRefusal(SID, repo, "default", moved)).toMatch(/another directory/);
    rmSync(moved);
    const yolo = stateDb(home, [{ id: SID, cwd: repo }, { id: CONT, parent: SID, cwd: repo, yolo: true }]);
    expect(hermesResumeRefusal(SID, repo, "default", yolo)).toMatch(/Bypass/);
  });

  test("an unknown id, or a store it cannot read, is a refusal rather than a pass", () => {
    const db = stateDb(home, [{ id: CONT, cwd: repo }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/no session/);
    expect(hermesResumeRefusal(SID, repo, "default", join(home, "missing.db"))).toMatch(/cannot read/);
  });
});

describe("which Hermes home a turn uses", () => {
  test("follows the sticky profile the way hermes does, and pins a profile dir as given", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-root-")));
    try {
      expect(hermesHome({ HERMES_HOME: root })).toBe(root);
      writeFileSync(join(root, "active_profile"), "default\n");
      expect(hermesHome({ HERMES_HOME: root })).toBe(root);
      writeFileSync(join(root, "active_profile"), "orbit\n");
      expect(hermesHome({ HERMES_HOME: root })).toBe(join(root, "profiles", "orbit"));
      mkdirSync(join(root, "profiles", "acme"), { recursive: true });
      expect(hermesHome({ HERMES_HOME: join(root, "profiles", "acme") })).toBe(join(root, "profiles", "acme"));
      expect(hermesHome({ AGENTGLASS_HERMES_HOME: join(root, "profiles", "acme"), HERMES_HOME: "/elsewhere" })).toBe(join(root, "profiles", "acme"));
      writeFileSync(join(root, "active_profile"), "../escape\n");
      expect(hermesHome({ HERMES_HOME: root })).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a home under ~/.hermes takes the sticky profile of ~/.hermes, as hermes does", () => {
    // hermes_constants.get_default_hermes_root: anything under the native home
    // reads active_profile there, not in itself.
    const user = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-user-")));
    try {
      const native = join(user, ".hermes");
      mkdirSync(join(native, "custom"), { recursive: true });
      writeFileSync(join(native, "active_profile"), "orbit\n");
      writeFileSync(join(native, "custom", "active_profile"), "acme\n");
      expect(hermesHome({ HOME: user, HERMES_HOME: join(native, "custom") })).toBe(join(native, "profiles", "orbit"));
      expect(hermesHome({ HOME: user })).toBe(join(native, "profiles", "orbit"));
      const elsewhere = join(user, "elsewhere");
      mkdirSync(elsewhere);
      expect(hermesHome({ HOME: user, HERMES_HOME: elsewhere })).toBe(elsewhere);
    } finally {
      rmSync(user, { recursive: true, force: true });
    }
  });
});
