/*
 * The finder's file operations, as decisions: which menu Strata shows for what
 * was clicked, which key runs which operation, what Paste does, which names
 * are refused before the round trip.
 */
import { describe, expect, test } from "bun:test";
import { clipPaths, deleteWords, doneNote, dropPlan, volumeOf, jobFraction, nothingTo, cantHere, jobsLabel, jobStatus, elapsedText, menuFor, menuHead, nameProblem, shortPath, pasteOp, stemEnd, type MenuCtx } from "../src/lib/finderOps.ts";
import { finderKey, type KeyIn } from "../src/lib/finderKeys.ts";

const k = (key: string, o: Partial<KeyIn> = {}): KeyIn => ({ key, ctrl: false, meta: false, shift: false, alt: false, ...o });
const free = { inField: false, hasSelection: false };
const ctx: MenuCtx = { count: 1, canPaste: false, hidden: false, previewable: true };
const labels = (g: ReturnType<typeof menuFor>) => g.map((x) => x.map((i) => i.label));

describe("the menus are Strata's", () => {
  test("a file: the groups, the order and the wording of its reference", () => {
    expect(labels(menuFor("file", ctx))).toEqual([
      ["New Folder with Selection"],
      ["Open", "Open With…", "Quick preview", "Print"],
      ["Cut", "Copy", "Duplicate", "Rename"],
      ["Move to…", "Copy to…"],
      ["Compress…"],
      ["Customize…", "Copy path", "Copy name", "Properties"],
      ["Move to Trash", "Permanently delete"],
    ]);
  });
  test("a folder swaps Quick preview and Print for Terminal and Open in New Tab, and adds Pin", () => {
    const g = labels(menuFor("folder", ctx));
    expect(g[1]).toEqual(["Open", "Open With…", "Open in Terminal", "Open in New Tab"]);
    expect(g[5]![0]).toBe("Pin to sidebar");
    expect(labels(menuFor("folder", { ...ctx, pinned: true }))[5]![0]).toBe("Unpin from sidebar");
  });
  test("empty space: New Folder, New File, Paste (off until something is cut or copied), Hidden toggle", () => {
    const g = menuFor("empty", ctx);
    expect(labels(g)[0]).toEqual(["New Folder", "New File", "Paste"]);
    expect(g[0]![2]!.disabled).toBe(true);
    expect(menuFor("empty", { ...ctx, canPaste: true })[0]![2]!.disabled).toBe(false);
    expect(labels(menuFor("empty", { ...ctx, hidden: true }))[2]![2]).toBe("Hide Hidden Files");
  });
  test("the permanent delete is the only danger item, and the shortcuts are Strata's", () => {
    const all = menuFor("file", ctx).flat();
    expect(all.filter((i) => i.danger).map((i) => i.id)).toEqual(["delete"]);
    expect(all.find((i) => i.id === "rename")!.keys).toBe("F2 / Ctrl+R");
    expect(all.find((i) => i.id === "props")!.keys).toBe("Alt+Enter");
    expect(all.find((i) => i.id === "trash")!.keys).toBe("Delete");
    expect(all.find((i) => i.id === "delete")!.keys).toBe("Shift+Delete");
  });
  test("with several chosen, Rename and Properties step aside", () => {
    const all = menuFor("file", { ...ctx, count: 3 }).flat();
    expect(all.find((i) => i.id === "rename")!.disabled).toBe(true);
    expect(all.find((i) => i.id === "props")!.disabled).toBe(true);
    expect(all.find((i) => i.id === "trash")!.disabled).toBeUndefined();
  });
  test("every item of the menus is built: none is left saying it is not", () => {
    for (const t of ["file", "folder", "empty"] as const) expect(menuFor(t, ctx).flat().filter((i) => i.later)).toEqual([]);
  });
  test("the header names one entry with its path, several by count", () => {
    expect(menuHead(["a.md"], "/home/x/")).toEqual({ title: "a.md", sub: "/home/x/a.md" });
    expect(menuHead(["a.md"], "/home/x/", "/home/x")).toEqual({ title: "a.md", sub: "~/a.md" });
    expect(menuHead(["a", "b"], "/home/x")).toEqual({ title: "2 items", sub: "/home/x" });
  });
  test("a long path keeps its start and its end, with the middle given up", () => {
    const s = shortPath("/home/x/.cache/claude-tmp/claude-1000/deep/er/than/the/menu/acme-notes.md", "/home/x");
    expect(s.length).toBeLessThanOrEqual(36);
    expect(s.startsWith("~/.cache")).toBe(true);
    expect(s.endsWith("acme-notes.md")).toBe(true);
    expect(s).toContain("…");
  });
});

describe("the keys", () => {
  test("Strata's operation keys", () => {
    const want: [KeyIn, string][] = [
      [k("x", { ctrl: true }), "cut"], [k("v", { ctrl: true }), "paste"], [k("d", { ctrl: true }), "duplicate"], [k("c", { ctrl: true }), "copyfiles"],
      [k("F2"), "rename"], [k("r", { ctrl: true }), "rename"], [k("Delete"), "trash"], [k("Delete", { shift: true }), "delete"],
      [k("N", { ctrl: true, shift: true }), "newfolder"], [k("n", { ctrl: true, alt: true }), "folderwith"],
      [k("Enter", { alt: true }), "props"], [k("z", { ctrl: true }), "undo"], [k("z", { ctrl: true, shift: true }), "redo"], [k("y", { ctrl: true }), "redo"],
    ];
    for (const [key, t] of want) expect(finderKey(key, free)).toEqual({ t } as never);
  });
  test("typing in a field is never a file operation", () => {
    for (const key of [k("Delete"), k("y"), k("x", { ctrl: true }), k("F2")]) {
      const a = finderKey(key, { inField: true, hasSelection: false });
      expect(a === null || a.t === "help" || a.t === "refresh").toBe(true);
    }
  });
  test("Ctrl+C with text selected on the page stays the browser's", () => {
    expect(finderKey(k("c", { ctrl: true }), { inField: false, hasSelection: true })).toBeNull();
  });
});

describe("paste", () => {
  const clip = (mode: "cut" | "copy", dir = "/a") => ({ mode, dir, names: ["x", "y"] });
  test("a cut moves, a copy copies, both keep both names on a clash", () => {
    expect(pasteOp(clip("cut"), "/b")).toEqual({ op: "move", conflict: "keep-both" });
    expect(pasteOp(clip("copy"), "/b")).toEqual({ op: "copy", conflict: "keep-both" });
  });
  test("a cut pasted where it was does nothing; an empty clipboard says so", () => {
    expect(pasteOp(clip("cut"), "/a")).toBe("nothing");
    expect(pasteOp(clip("copy"), "/a")).toEqual({ op: "copy", conflict: "keep-both" });
    expect(pasteOp(null, "/a")).toBe("empty");
  });
  test("the clip's paths are joined without a double slash", () => {
    expect(clipPaths({ mode: "copy", dir: "/a/", names: ["x"] })).toEqual(["/a/x"]);
  });
});

describe("names", () => {
  test("refused before the round trip: empty, dots, slash, taken, too long", () => {
    expect(nameProblem("", [])).toBe("A name is needed");
    expect(nameProblem("  ", [])).toBe("A name is needed");
    expect(nameProblem("..", [])).toBe("That is not a name");
    expect(nameProblem("a/b", [])).toBe("A name cannot contain /");
    expect(nameProblem("a", ["a"])).toBe("a already exists");
    expect(nameProblem("a", ["a"], "a")).toBeNull();
    expect(nameProblem("é".repeat(200), [])).toBe("That name is too long");
    expect(nameProblem("fine.txt", ["other"])).toBeNull();
  });
  test("a rename selects the stem, not the extension; a dotfile selects all", () => {
    expect(stemEnd("report.final.md")).toBe(12);
    expect(stemEnd(".bashrc")).toBe(7);
    expect(stemEnd("Makefile")).toBe(8);
  });
});

describe("words", () => {
  test("the permanent delete names what goes and says it cannot be undone", () => {
    expect(deleteWords(["a.txt"])).toEqual({ title: "Permanently delete “a.txt”?", body: "“a.txt” will be deleted for good. This cannot be undone." });
    const many = deleteWords(["1", "2", "3", "4", "5", "6", "7"]);
    expect(many.title).toBe("Permanently delete 7 items?");
    expect(many.body).toContain("and 2 more");
  });
  test("the footer line after an operation", () => {
    expect(doneNote("trash", 1, "a.txt")).toBe("Moved a.txt to the trash");
    expect(doneNote("delete", 3, "")).toBe("Deleted 3 items");
  });
});

describe("dropping rows on a folder", () => {
  test("moves, and copies with Ctrl", () => {
    expect(dropPlan("/h/a", ["x.txt"], "/h/b", false)).toEqual({ op: "move", conflict: "keep-both" });
    expect(dropPlan("/h/a", ["x.txt"], "/h/b", true)).toEqual({ op: "copy", conflict: "keep-both" });
  });
  test("into the folder they are in is nothing for a move and a copy with Ctrl", () => {
    expect(dropPlan("/h/a", ["x.txt"], "/h/a", false)).toBe("nothing");
    expect(dropPlan("/h/a", ["x.txt"], "/h/a", true)).toEqual({ op: "copy", conflict: "keep-both" });
  });
  test("never into itself or inside itself, but a sibling that shares a prefix is fine", () => {
    expect(dropPlan("/h", ["a"], "/h/a", false)).toBe("inside");
    expect(dropPlan("/h", ["a"], "/h/a/deep/er", true)).toBe("inside");
    expect(dropPlan("/h", ["a"], "/h/ab", false)).toEqual({ op: "move", conflict: "keep-both" });
    expect(dropPlan("/", ["a"], "/a/b", false)).toBe("inside");
  });
  test("Strata's modifiers and volumes: Shift moves, Ctrl copies, and with neither a drop across volumes copies", () => {
    const mounts = ["/media/ada/orbit", "/run/media/ada/acme"];
    expect(dropPlan("/home/ada/a", ["x"], "/media/ada/orbit/in", false, { mounts })).toEqual({ op: "copy", conflict: "keep-both" });
    expect(dropPlan("/home/ada/a", ["x"], "/media/ada/orbit/in", false, { shift: true, mounts })).toEqual({ op: "move", conflict: "keep-both" });
    expect(dropPlan("/media/ada/orbit/a", ["x"], "/media/ada/orbit/b", false, { mounts })).toEqual({ op: "move", conflict: "keep-both" });
    expect(dropPlan("/home/ada/a", ["x"], "/home/ada/b", false, { mounts })).toEqual({ op: "move", conflict: "keep-both" });
    expect(dropPlan("/home/ada/a", ["x"], "/home/ada/b", true, { shift: true, mounts })).toEqual({ op: "copy", conflict: "keep-both" });
    expect(volumeOf("/media/ada/orbitx/a", mounts)).toBe("/");
    expect(volumeOf("/media/ada/orbit", mounts)).toBe("/media/ada/orbit");
  });
  test("an empty pick is nothing", () => { expect(dropPlan("/h", [], "/x", false)).toBe("nothing"); });
});

describe("the jobs panel", () => {
  test("how far a job has got", () => {
    expect(jobFraction({ state: "running", total: null, done: 5 })).toBeNull();
    expect(jobFraction({ state: "running", total: 200, done: 50 })).toBe(0.25);
    expect(jobFraction({ state: "running", total: 100, done: 900 })).toBe(1);
    expect(jobFraction({ state: "done", total: null, done: 0 })).toBe(1);
  });
  test("the footer button counts what runs, then what finished, and says so when one failed", () => {
    expect(jobsLabel([])).toBe("");
    expect(jobsLabel([{ state: "running" }, { state: "done" }, { state: "running" }])).toBe("2 running");
    expect(jobsLabel([{ state: "done" }, { state: "cancelled" }])).toBe("2 finished");
    expect(jobsLabel([{ state: "done" }, { state: "error" }])).toBe("2 finished \u00b7 failures");
  });
  test("a job's status line is Strata's wording and its time", () => {
    expect(elapsedText(42_000)).toBe("42 s");
    expect(elapsedText(185_000)).toBe("3 min 05 s");
    expect(elapsedText(3_720_000)).toBe("1 h 02 min");
    expect(jobStatus({ state: "running", started: 1_000 }, 5_000)).toBe("Running for 4 s");
    expect(jobStatus({ state: "done", started: 1_000, ended: 3_000 }, 99_000)).toBe("Done in 2 s");
    expect(jobStatus({ state: "error", started: 0, ended: 1_000 }, 9_000)).toBe("Failed after 1 s");
    expect(jobStatus({ state: "cancelled", started: 0, ended: 3_000 }, 9_000)).toBe("Cancelled after 3 s");
  });
});

describe("the footer's one-line answers", () => {
  test("a command with nothing to act on names the verb, as Strata does", () => {
    expect(nothingTo("copy")).toBe("Nothing to copy");
    expect(nothingTo("trash")).toBe("Nothing to delete");
    expect(nothingTo("move-to")).toBe("Nothing to move");
    expect(nothingTo("rename")).toBe("Nothing to rename");
    expect(nothingTo("preview")).toBe("Nothing to preview");
  });
  test("Recent refuses to make, paste or rename, and says so", () => {
    expect(cantHere("new-folder", true)).toBe("Can\u2019t create items here");
    expect(cantHere("paste", true)).toBe("Can\u2019t create items here");
    expect(cantHere("rename", true)).toBe("Can\u2019t rename items here");
    expect(cantHere("copy", true)).toBeNull();
    expect(cantHere("rename", false)).toBeNull();
  });
});

describe("Ctrl+Alt+T", () => {
  test("opens a terminal in the folder, and is left alone in a text field", () => {
    expect(finderKey(k("t", { ctrl: true, alt: true }), free)).toEqual({ t: "terminal" });
    expect(finderKey(k("t", { ctrl: true, alt: true }), { inField: true, hasSelection: false })).toBeNull();
    expect(finderKey(k("t", { ctrl: true }), free)).not.toEqual({ t: "terminal" });
  });
});
