/*
 * Findings from the review of the file operations, one test each: what went
 * wrong on a scratch tree, and the guard that now holds. Every test here was
 * run red against the code it fixes before it was made green.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetJournalForTest, compressArgv, fsCopy, fsFolderWith, fsRename, fsRestore, fsTrash, fsUndo, moveNoReplace, trashList, undoState, JOURNAL_TTL_MS } from "../src/fsops.ts";
import { fsGate, fsWantsJson } from "../src/fsroute.ts";

const was = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME, ROOTS: process.env.AGENTGLASS_DISK_ROOTS, CFG: process.env.XDG_CONFIG_HOME };
const base = mkdtempSync(join(tmpdir(), "agx-fsrev-"));
let home = "";
let n = 0;
beforeEach(() => {
  home = join(base, `h${++n}`);
  mkdirSync(home);
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(home, "data-hidden-from-browse");
  process.env.XDG_CONFIG_HOME = join(home, "cfg-hidden");
  process.env.AGENTGLASS_DISK_ROOTS = "";
  __resetJournalForTest();
});
afterAll(() => {
  for (const [k, v] of [["HOME", was.HOME], ["XDG_DATA_HOME", was.XDG], ["AGENTGLASS_DISK_ROOTS", was.ROOTS], ["XDG_CONFIG_HOME", was.CFG]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});
const put = (rel: string, body = "x") => { const p = join(home, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); return p; };
const dir = (rel: string) => { const p = join(home, rel); mkdirSync(p, { recursive: true }); return p; };

describe("H2: what an agent may not do", () => {
  test("permanent delete and empty trash need the desktop app's proof", () => {
    for (const op of ["delete", "empty-trash"]) {
      const g = fsGate(op, false);
      expect(g?.status).toBe(403);
      expect(JSON.stringify(g?.body)).toMatch(/desktop app/);
      expect(fsGate(op, true)).toBeNull();
    }
  });
  test("a reversible op is not held back", () => {
    for (const op of ["trash", "move", "copy", "rename", "mkdir", "undo"]) expect(fsGate(op, false)).toBeNull();
  });
  test("a write must say it is JSON, so a form post from another page is not read", () => {
    expect(fsWantsJson("application/json")).toBe(true);
    expect(fsWantsJson("application/json; charset=utf-8")).toBe(true);
    expect(fsWantsJson("text/plain")).toBe(false);
    expect(fsWantsJson(null)).toBe(false);
  });
});

describe("H1: two operands with one name", () => {
  test("a move of a/f.txt and b/f.txt into one folder keeps both", async () => {
    const a = put("a/f.txt", "A"), b = put("b/f.txt", "B"), dest = dir("dest");
    const r = await fsCopy([a, b], dest, { move: true, conflict: "keep-both" }, true);
    expect(r.ok).toBe(true);
    const got = readdirSync(dest).sort();
    expect(got.length).toBe(2);
    expect(got.map((f) => readFileSync(join(dest, f), "utf8")).sort()).toEqual(["A", "B"]);
  });
  test("with no keep-both the clash is refused before anything moves", async () => {
    const a = put("a/f.txt", "A"), b = put("b/f.txt", "B"), dest = dir("dest");
    const r = await fsCopy([a, b], dest, { move: true, conflict: "fail" }, true);
    expect(r.ok).toBe(false);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });
});

describe("M3: a blocked undo does not jam the stack", () => {
  test("trash two, retake one name: undo restores nothing and says why, and can be retried", () => {
    const a = put("a.txt", "a"), b = put("b.txt", "b");
    expect(fsTrash([a, b], true).ok).toBe(true);
    put("b.txt", "new");
    const r = fsUndo(true);
    expect(r.ok).toBe(false);
    expect(existsSync(a)).toBe(false); // nothing was half-restored
    expect(trashList().length).toBe(2);
    rmSync(b);
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });
});

describe("M9: a name is never a flag", () => {
  test("7z, zip and tar all put the names after --", () => {
    for (const f of ["7z", "zip", "tar", "tar.gz"] as const) {
      const argv = compressArgv(f, "/t/out", ["-sdel", "b"], null);
      const i = argv.indexOf("--");
      expect(i).toBeGreaterThan(0);
      expect(argv.slice(i + 1)).toEqual(["-sdel", "b"]);
    }
  });
});

describe("M2: the undo journal forgets", () => {
  test("an entry older than the ttl is not offered and not run", () => {
    const a = put("a.txt");
    expect(fsTrash([a], true).ok).toBe(true);
    expect(undoState().available).toBe(true);
    const later = Date.now() + JOURNAL_TTL_MS + 1000;
    expect(undoState(later).available).toBe(false);
    const r = fsUndo(true, later);
    expect(r.ok).toBe(false);
    expect(existsSync(a)).toBe(false);
  });
});

describe("M4: a move that stops halfway still can be undone", () => {
  test("the steps that landed are in the journal", async () => {
    const a = put("a/x.txt", "x"), b = put("locked/y.txt", "y"), dest = dir("dest");
    chmodSync(join(home, "locked"), 0o555);
    try {
      if (process.getuid?.() === 0) return; // root ignores the mode
      const r = await fsCopy([a, b], dest, { move: true }, true);
      expect(r.ok).toBe(false);
      expect(existsSync(join(dest, "x.txt"))).toBe(true);
      expect(undoState().available).toBe(true);
      chmodSync(join(home, "locked"), 0o755);
      expect(fsUndo(true).ok).toBe(true);
      expect(existsSync(a)).toBe(true);
    } finally { chmodSync(join(home, "locked"), 0o755); }
  });
});

describe("M5: a rename never replaces", () => {
  test("moveNoReplace refuses a name that is taken", () => {
    const a = put("a.txt", "A"), b = put("b.txt", "B");
    expect(() => moveNoReplace(a, b)).toThrow(/EEXIST|exists/);
    expect(readFileSync(b, "utf8")).toBe("B");
    expect(existsSync(a)).toBe(true);
  });
  test("it moves a file and a folder to a free name", () => {
    const a = put("a.txt", "A"), d = dir("d");
    moveNoReplace(a, join(home, "c.txt"));
    moveNoReplace(d, join(home, "e"));
    expect(existsSync(join(home, "c.txt")) && existsSync(join(home, "e")) && !existsSync(a) && !existsSync(d)).toBe(true);
  });
  test("rename and folder-with go through it", () => {
    const a = put("a.txt");
    expect(fsRename(a, "b.txt", true).ok).toBe(true);
    expect(fsFolderWith([join(home, "b.txt")], "box", true).ok).toBe(true);
    expect(existsSync(join(home, "box", "b.txt"))).toBe(true);
  });
});

describe("M10 and L4: restore", () => {
  test("a folder that went away is made again inside the boundary", () => {
    const a = put("gone/a.txt", "a");
    expect(fsTrash([a], true).ok).toBe(true);
    rmSync(join(home, "gone"), { recursive: true });
    const r = fsRestore([trashList()[0]!.id], true);
    expect(r.ok).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("a");
  });
  test("an error never carries the trash path", () => {
    const a = put("a.txt");
    fsTrash([a], true);
    const id = trashList()[0]!.id;
    put("a.txt");
    const r = fsRestore([id], true);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("Trash");
  });
  test("an info file with a relative Path is refused", () => {
    const a = put("a.txt");
    fsTrash([a], true);
    const row = trashList()[0]!;
    const info = join(home, "data-hidden-from-browse", "Trash", "info", `${row.id}.trashinfo`);
    writeFileSync(info, "[Trash Info]\nPath=relative/a.txt\nDeletionDate=2026-01-01T00:00:00\n");
    expect(fsRestore([row.id], true).ok).toBe(false);
  });
});
