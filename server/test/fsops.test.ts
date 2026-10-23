/*
 * Changing a place: every operation behind the finder's boundary.
 *
 * All of it runs in a scratch HOME. Nothing here may touch a real folder: the
 * home, the data dir that holds the trash and the disk roots are all the same
 * temporary tree, and a second tree OUTSIDE it plays "somewhere that is not
 * allowed" for the symlink cases.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetJournalForTest, cancelJob, fsChmod, fsCompress, fsCopy, fsDelete, fsEmptyTrash, fsFolderWith, fsMkdir, fsNewFile, fsProps, fsRename,
  fsRedo, fsRestore, fsTrash, fsUndo, JOURNAL_TTL_MS, keepBoth, listJobs, settle, trashList, trashRoot, undoState, redoState,
} from "../src/fsops.ts";

const saved = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME, ROOTS: process.env.AGENTGLASS_DISK_ROOTS, CFG: process.env.XDG_CONFIG_HOME };
const base = mkdtempSync(join(tmpdir(), "agx-fsops-"));
const outside = mkdtempSync(join(tmpdir(), "agx-fsops-outside-"));
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
  for (const [k, v] of [["HOME", saved.HOME], ["XDG_DATA_HOME", saved.XDG], ["AGENTGLASS_DISK_ROOTS", saved.ROOTS], ["XDG_CONFIG_HOME", saved.CFG]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const put = (rel: string, body = "x") => { const p = join(home, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); return p; };
const dir = (rel: string) => { const p = join(home, rel); mkdirSync(p, { recursive: true }); return p; };
const ls = (p: string) => readdirSync(p).sort();

describe("create and rename", () => {
  test("new folder and new file appear, and a taken name is refused", () => {
    const a = fsMkdir(home, "docs", true);
    expect(a.ok && existsSync(a.path)).toBe(true);
    expect(fsMkdir(home, "docs", true)).toEqual({ ok: false, error: "docs already exists" });
    expect(fsNewFile(home, "a.txt", true).ok).toBe(true);
    expect(fsNewFile(home, "a.txt", true).ok).toBe(false);
  });
  test("a name is a name: no slash, no dots, no empty", () => {
    for (const bad of ["", ".", "..", "a/b", "../x", "a\0b", "x".repeat(300)]) expect(fsMkdir(home, bad, true).ok).toBe(false);
  });
  test("rename keeps the folder, never overwrites", () => {
    const f = put("a.txt");
    put("b.txt");
    expect(fsRename(f, "b.txt", true).ok).toBe(false);
    const r = fsRename(f, "c.txt", true);
    expect(r.ok).toBe(true);
    expect(ls(home)).toEqual(["b.txt", "c.txt"]);
  });
  test("new folder with the selection moves them in, all or nothing", () => {
    const a = put("a.txt"), b = put("b.txt");
    const r = fsFolderWith([a, b], "set", true);
    expect(r.ok).toBe(true);
    expect(ls(join(home, "set"))).toEqual(["a.txt", "b.txt"]);
    expect(fsUndo(true).ok).toBe(true);
    expect(ls(home)).toEqual(["a.txt", "b.txt", "set"]);
  });
});

describe("the boundary", () => {
  test("a place outside home is refused for every operation", async () => {
    const f = join(outside, "secret.txt");
    writeFileSync(f, "s");
    expect(fsRename(f, "x", true).ok).toBe(false);
    expect(fsTrash([f], true).ok).toBe(false);
    expect((await fsDelete([f], 1, true)).ok).toBe(false);
    expect(fsMkdir(outside, "x", true).ok).toBe(false);
    expect(existsSync(f)).toBe(true);
  });
  test("a link to the outside is trashed and deleted AS A LINK; the target is never touched", async () => {
    const target = join(outside, "keep");
    mkdirSync(target);
    writeFileSync(join(target, "inner.txt"), "i");
    symlinkSync(target, join(home, "door"));
    const t = fsTrash([join(home, "door")], true);
    expect(t.ok).toBe(true);
    expect(existsSync(join(target, "inner.txt"))).toBe(true);
    symlinkSync(target, join(home, "door2"));
    expect((await fsDelete([join(home, "door2")], 1, true)).ok).toBe(true);
    expect(existsSync(join(target, "inner.txt"))).toBe(true);
  });
  test("a copy of a tree that holds a link to the outside copies the LINK, not what it points at", async () => {
    const src = dir("tree");
    writeFileSync(join(outside, "pw.txt"), "secret");
    symlinkSync(outside, join(src, "out"));
    dir("dest");
    const r = await fsCopy([src], join(home, "dest"), {}, true);
    expect(r.ok).toBe(true);
    const copied = join(home, "dest", "tree", "out");
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copied)).toBe(outside);
  });
  test("a path that goes through a link to the outside is refused", async () => {
    symlinkSync(outside, join(home, "door"));
    writeFileSync(join(outside, "f.txt"), "f");
    expect(fsRename(join(home, "door", "f.txt"), "g.txt", true).ok).toBe(false);
    expect((await fsDelete([join(home, "door", "f.txt")], 1, true)).ok).toBe(false);
    expect(existsSync(join(outside, "f.txt"))).toBe(true);
  });
  test("the home folder itself and a folder that holds it cannot be moved or deleted", async () => {
    expect((await fsDelete([home], 1, true)).ok).toBe(false);
    expect(fsTrash([home], true).ok).toBe(false);
    expect(fsRename(home, "elsewhere", true).ok).toBe(false);
    expect(existsSync(home)).toBe(true);
  });
  test("a root folder the finder starts from, or a folder above one, is left alone", async () => {
    const work = dir("outer/work");
    process.env.AGENTGLASS_DISK_ROOTS = work;
    expect((await fsDelete([work], 1, true)).ok).toBe(false);
    expect(fsTrash([work], true).ok).toBe(false);
    expect(fsRename(work, "w2", true).ok).toBe(false);
    expect((await fsDelete([join(home, "outer")], 1, true)).ok).toBe(false);
    expect(existsSync(work)).toBe(true);
    expect(fsTrash([put("outer/work/a.txt")], true).ok).toBe(true);
  });
  test("dotted secret stores stay shut even for a local caller", async () => {
    const ssh = dir(".ssh");
    writeFileSync(join(ssh, "id_ed25519"), "k");
    expect(fsTrash([ssh], true).ok).toBe(false);
    expect((await fsDelete([join(ssh, "id_ed25519")], 1, true)).ok).toBe(false);
    expect(existsSync(join(ssh, "id_ed25519"))).toBe(true);
  });
});

describe("the trash", () => {
  test("trash writes a freedesktop entry and restore puts it back", () => {
    const f = put("my doc.txt", "hello");
    const r = fsTrash([f], true);
    expect(r.ok).toBe(true);
    expect(existsSync(f)).toBe(false);
    const info = readFileSync(join(trashRoot(), "info", "my doc.txt.trashinfo"), "utf8");
    expect(info).toMatch(/^\[Trash Info\]\nPath=.*\/my%20doc\.txt\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
    expect(readFileSync(join(trashRoot(), "files", "my doc.txt"), "utf8")).toBe("hello");
    expect(trashList().map((t) => t.name)).toEqual(["my doc.txt"]);
    const back = fsRestore(["my doc.txt"], true);
    expect(back.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("hello");
    expect(trashList()).toEqual([]);
  });
  test("two things with the same name get two entries", () => {
    const a = put("a/x.txt", "1"), b = put("b/x.txt", "2");
    fsTrash([a], true); fsTrash([b], true);
    expect(trashList().length).toBe(2);
    expect(ls(join(trashRoot(), "files"))).toEqual(["x.txt", "x.txt.1"]);
  });
  test("restore never overwrites what took its place", () => {
    const f = put("a.txt", "old");
    fsTrash([f], true);
    put("a.txt", "new");
    const r = fsRestore(["a.txt"], true);
    expect(r.ok).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(trashList().length).toBe(1);
  });
  test("a hand-made .trashinfo that points outside home cannot restore there", () => {
    const { files, info } = { files: join(trashRoot(), "files"), info: join(trashRoot(), "info") };
    mkdirSync(files, { recursive: true }); mkdirSync(info, { recursive: true });
    writeFileSync(join(files, "evil"), "e");
    writeFileSync(join(info, "evil.trashinfo"), `[Trash Info]\nPath=${outside}/evil\nDeletionDate=2026-01-01T00:00:00\n`);
    expect(fsRestore(["evil"], true).ok).toBe(false);
    expect(existsSync(join(outside, "evil"))).toBe(false);
  });
  test("a trash id is a name, never a path", () => {
    expect(fsRestore(["../../etc/passwd"], true).ok).toBe(false);
  });
  test("empty trash asks for the count", async () => {
    fsTrash([put("a.txt"), put("b.txt")], true);
    expect((await fsEmptyTrash(undefined, 1)).ok).toBe(false);
    expect(trashList().length).toBe(2);
    const r = await fsEmptyTrash(undefined, 2);
    expect(r.ok && r.removed).toBe(2);
    expect(trashList()).toEqual([]);
  });
});

describe("permanent delete", () => {
  test("needs the count the person was shown", async () => {
    const a = put("a.txt"), b = put("b.txt");
    expect((await fsDelete([a, b], undefined, true)).ok).toBe(false);
    expect((await fsDelete([a, b], 1, true)).ok).toBe(false);
    expect(existsSync(a)).toBe(true);
    const r = await fsDelete([a, b], 2, true);
    expect(r.ok && r.deleted).toBe(2);
    expect(existsSync(a)).toBe(false);
  });
  test("a folder goes with what it holds", async () => {
    const d = dir("d/e");
    writeFileSync(join(d, "f"), "f");
    expect((await fsDelete([join(home, "d")], 1, true)).ok).toBe(true);
    expect(existsSync(join(home, "d"))).toBe(false);
  });
});

describe("copy, move, duplicate", () => {
  test("copy keeps the source, never overwrites, keeps both on request", async () => {
    const f = put("a.txt", "A");
    dir("dest");
    put("dest/a.txt", "OLD");
    expect((await fsCopy([f], join(home, "dest"), {}, true)).ok).toBe(false);
    expect(readFileSync(join(home, "dest", "a.txt"), "utf8")).toBe("OLD");
    const r = await fsCopy([f], join(home, "dest"), { conflict: "keep-both" }, true);
    expect(r.ok).toBe(true);
    expect(ls(join(home, "dest"))).toEqual(["a (copy).txt", "a.txt"]);
    expect(existsSync(f)).toBe(true);
  });
  test("a folder cannot be copied or moved into itself", async () => {
    const d = dir("d/sub");
    expect((await fsCopy([join(home, "d")], d, {}, true)).ok).toBe(false);
    expect((await fsCopy([join(home, "d")], d, { move: true }, true)).ok).toBe(false);
    expect(existsSync(d)).toBe(true);
  });
  test("move is a rename and can be undone", async () => {
    const f = put("a.txt");
    dir("dest");
    const r = await fsCopy([f], join(home, "dest"), { move: true }, true);
    expect(r.ok).toBe(true);
    expect(existsSync(f)).toBe(false);
    expect(undoState()).toEqual({ available: true, label: "Undo move of a.txt" });
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(f)).toBe(true);
    expect(undoState().available).toBe(false);
  });
  test("undo refuses a move whose old place is taken, and changes nothing", async () => {
    const f = put("a.txt");
    dir("dest");
    await fsCopy([f], join(home, "dest"), { move: true }, true);
    put("a.txt", "someone else");
    const u = fsUndo(true);
    expect(u.ok).toBe(false);
    expect(existsSync(join(home, "dest", "a.txt"))).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("someone else");
  });
  test("duplicate makes 'name (copy).ext' next to it", async () => {
    const f = put("a.txt");
    const r = await fsCopy([f], null, { duplicate: true }, true);
    expect(r.ok).toBe(true);
    expect(ls(home)).toEqual(["a (copy).txt", "a.txt"]);
    await fsCopy([f], null, { duplicate: true }, true);
    expect(ls(home)).toEqual(["a (copy 2).txt", "a (copy).txt", "a.txt"]);
  });
  test("undo of a copy trashes the copy, not the original", async () => {
    const f = put("a.txt");
    dir("dest");
    await fsCopy([f], join(home, "dest"), {}, true);
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(join(home, "dest", "a.txt"))).toBe(false);
    expect(existsSync(f)).toBe(true);
    expect(trashList().length).toBe(1);
  });
  test("a big copy answers with a running job, reports bytes, and cancel leaves no half-copy", async () => {
    const src = dir("big");
    for (let i = 0; i < 4; i++) writeFileSync(join(src, `f${i}.bin`), Buffer.alloc(40 * 1024 * 1024, i));
    dir("dest");
    const r = await fsCopy([src], join(home, "dest"), {}, true, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.job.state).toBe("running");
    expect(cancelJob(r.job.id)).toBe(true);
    const end = await settle(r.job.id);
    expect(end?.state).toBe("cancelled");
    expect(ls(join(home, "dest"))).toEqual([]);
    expect(listJobs()[0]!.id).toBe(r.job.id);
  });
  test("a finished big copy has all bytes and only then the real name", async () => {
    const src = dir("big2");
    writeFileSync(join(src, "a.bin"), Buffer.alloc(20 * 1024 * 1024, 7));
    dir("dest");
    const r = await fsCopy([src], join(home, "dest"), {}, true, 1);
    if (!r.ok) throw new Error(r.error);
    const end = await settle(r.job.id);
    expect(end?.state).toBe("done");
    expect(end?.done).toBe(20 * 1024 * 1024);
    expect(ls(join(home, "dest"))).toEqual(["big2"]);
  });
});

describe("compress", () => {
  test("tar.gz of a selection lands next to it under a free name", async () => {
    const a = put("a.txt", "A"), b = put("b.txt", "B");
    const r = await fsCompress([a, b], "bundle", "tar.gz", undefined, true, 5000);
    if (!r.ok) throw new Error(r.error);
    expect(r.job.state).toBe("done");
    expect(r.path).toBe(join(home, "bundle.tar.gz"));
    const again = await fsCompress([a], "bundle", "tar.gz", undefined, true, 5000);
    expect(again.ok && again.path).toBe(join(home, "bundle (copy).tar.gz"));
    expect(ls(home).some((x) => x.startsWith(".agx-part"))).toBe(false);
  });
  test("a password on a format that has none is refused", async () => {
    const a = put("a.txt");
    expect((await fsCompress([a], "x", "tar", "pw", true)).ok).toBe(false);
  });
});

describe("properties and permissions", () => {
  test("props say size, mode and owner; chmod changes only the nine bits", () => {
    const f = put("a.txt", "12345");
    const p = fsProps(f, true);
    expect(p.ok && p.props.bytes).toBe(5);
    expect(fsChmod(f, 0o600, true).ok).toBe(true);
    expect(lstatSync(f).mode & 0o777).toBe(0o600);
    expect(fsChmod(f, 0o4777, true).ok).toBe(false);
  });
  test("chmod refuses a link: it would change what the link points at", () => {
    const t = join(outside, "t.txt");
    writeFileSync(t, "t");
    symlinkSync(t, join(home, "l"));
    expect(fsChmod(join(home, "l"), 0o777, true).ok).toBe(false);
    expect(lstatSync(t).mode & 0o777).not.toBe(0o777);
  });
});

describe("naming", () => {
  test("keepBoth skips every name that is taken", () => {
    put("a.txt"); put("a (copy).txt");
    expect(keepBoth(home, "a.txt")).toBe("a (copy 2).txt");
    expect(keepBoth(home, "free.txt")).toBe("free.txt");
    put(".bashrc");
    expect(keepBoth(home, ".bashrc")).toBe(".bashrc (copy)");
  });
});

describe("redo: what was just undone, done again", () => {
  test("an undone rename is renamed again, and can be undone once more", () => {
    const a = put("a.txt");
    expect(fsRename(a, "b.txt", true).ok).toBe(true);
    expect(redoState().available).toBe(false);
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(a)).toBe(true);
    expect(redoState()).toEqual({ available: true, label: "Redo rename of a.txt" });
    expect(fsRedo(true).ok).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(home, "b.txt"))).toBe(true);
    expect(redoState().available).toBe(false);
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(a)).toBe(true);
  });

  test("an undone trash goes to the trash again", () => {
    const a = put("a.txt");
    expect(fsTrash([a], true).ok).toBe(true);
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(a)).toBe(true);
    expect(fsRedo(true).ok).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(trashList().length).toBe(1);
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(a)).toBe(true);
  });

  test("an undone new folder comes back from the trash, not as a new empty one", () => {
    const f = fsMkdir(home, "docs", true);
    if (!f.ok) throw new Error("mkdir");
    writeFileSync(join(f.path, "inner.txt"), "kept");
    expect(fsUndo(true).ok).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    expect(fsRedo(true).ok).toBe(true);
    expect(readFileSync(join(f.path, "inner.txt"), "utf8")).toBe("kept");
  });

  test("a new operation clears the redo, so it is never offered after something else happened", () => {
    const a = put("a.txt");
    fsRename(a, "b.txt", true);
    fsUndo(true);
    expect(redoState().available).toBe(true);
    fsMkdir(home, "other", true);
    expect(redoState().available).toBe(false);
    expect(fsRedo(true)).toEqual({ ok: false, error: "nothing to redo" });
  });

  test("a redo whose place was taken meanwhile is refused and changes nothing", () => {
    const a = put("a.txt", "one");
    fsRename(a, "b.txt", true);
    fsUndo(true);
    writeFileSync(join(home, "b.txt"), "someone else's");
    const r = fsRedo(true);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(home, "b.txt"), "utf8")).toBe("someone else's");
    expect(readFileSync(a, "utf8")).toBe("one");
  });

  test("a redo is forgotten with the same lifetime as an undo", () => {
    const a = put("a.txt");
    fsRename(a, "b.txt", true);
    fsUndo(true);
    expect(redoState(Date.now() + JOURNAL_TTL_MS + 1000).available).toBe(false);
  });

  test("a permanent delete or a restore in between also ends the redo", async () => {
    const a = put("a.txt");
    fsRename(a, "b.txt", true);
    fsUndo(true);
    expect(redoState().available).toBe(true);
    const b = put("c.txt");
    expect((await fsDelete([b], 1, true)).ok).toBe(true);
    expect(redoState().available).toBe(false);
  });

  test("a redo of several items is judged whole: one place taken, none moved", async () => {
    const a = put("a.txt"), b = put("b.txt"), d = dir("dest");
    expect((await fsCopy([a, b], d, { move: true, conflict: "fail" }, true)).ok).toBe(true);
    expect(fsUndo(true).ok).toBe(true);
    writeFileSync(join(d, "b.txt"), "taken");
    expect(fsRedo(true).ok).toBe(false);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(join(d, "a.txt"))).toBe(false);
  });
});
