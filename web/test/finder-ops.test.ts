/*
 * The finder's file operations, as decisions: which menu Strata shows for what
 * was clicked, which key runs which operation, what Paste does, which names
 * are refused before the round trip.
 */
import { describe, expect, test } from "bun:test";
import { clipPaths, deleteWords, doneNote, dropPlan, jobFraction, jobsShown, menuFor, menuHead, nameProblem, shortPath, pasteOp, stemEnd, type MenuCtx } from "../src/lib/finderOps.ts";
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
  test("an item that is not built says what it is instead of doing nothing", () => {
    expect(menuFor("file", ctx).flat().filter((i) => i.later).map((i) => i.id).sort()).toEqual(["customize"]);
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
      [k("Enter", { alt: true }), "props"], [k("z", { ctrl: true }), "undo"], [k("z", { ctrl: true, shift: true }), "redo"], [k("y", { ctrl: true }), "redo"], [k("y"), "copy"], [k("p"), "pin"],
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
  test("an empty pick is nothing", () => { expect(dropPlan("/h", [], "/x", false)).toBe("nothing"); });
});

describe("the jobs panel", () => {
  test("how far a job has got", () => {
    expect(jobFraction({ state: "running", total: null, done: 5 })).toBeNull();
    expect(jobFraction({ state: "running", total: 200, done: 50 })).toBe(0.25);
    expect(jobFraction({ state: "running", total: 100, done: 900 })).toBe(1);
    expect(jobFraction({ state: "done", total: null, done: 0 })).toBe(1);
  });
  test("a finished job stays a few seconds, a running one stays", () => {
    const js = [{ state: "running", id: 1 }, { state: "done", ended: 9_000, id: 2 }, { state: "done", ended: 1_000, id: 3 }, { state: "error", id: 4 }];
    expect(jobsShown(js, 10_000).map((j) => j.id)).toEqual([1, 2]);
  });
});
