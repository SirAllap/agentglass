import { afterEach, describe, expect, test } from "bun:test";
import { EDIT_CAP, EXITS, clearDraft, dirtyPaths, editability, exitDecision, fromEditor, getDraft, saveDrafts, setDraft, toEditor } from "../src/lib/finderEdit.ts";

const text = (over: object = {}) => ({ kind: "text" as const, bytes: 10, text: "echo hi\n", textTruncated: false, ...over });

describe("editability", () => {
  test("a small text file is editable", () => expect(editability(text()).ok).toBe(true));
  test("a binary, an image and a folder are not", () => {
    for (const kind of ["binary", "image", "pdf", "dir"] as const) expect(editability(text({ kind })).ok).toBe(false);
  });
  test("over the cap, or cut short by the preview, is read-only", () => {
    expect(editability(text({ bytes: EDIT_CAP + 1 })).ok).toBe(false);
    expect(editability(text({ textTruncated: true })).ok).toBe(false);
    expect(editability(text({ bytes: EDIT_CAP })).ok).toBe(true);
  });
  test("text that is not valid UTF-8 (a replacement character) is read-only", () => {
    expect(editability(text({ text: "caf�" })).ok).toBe(false);
  });
  test("a file whose text never arrived is not editable", () => expect(editability(text({ text: undefined })).ok).toBe(false));
});

describe("line endings", () => {
  test("CRLF survives a round trip through the text box", () => {
    const e = toEditor("a\r\nb\r\n");
    expect(e).toEqual({ text: "a\nb\n", eol: "\r\n" });
    expect(fromEditor(e.text + "c", e.eol)).toBe("a\r\nb\r\nc");
  });
  test("LF stays LF", () => {
    const e = toEditor("a\nb\n");
    expect(fromEditor(e.text, e.eol)).toBe("a\nb\n");
  });
});

describe("drafts and closing", () => {
  afterEach(() => { for (const p of dirtyPaths()) clearDraft(p); });
  test("a draft equal to the saved text is not dirty", () => {
    setDraft("/a", { text: "x", saved: "x", eol: "\n", mtime: 1 });
    expect(dirtyPaths()).toEqual([]);
  });
  test("a changed draft is dirty until it is cleared", () => {
    setDraft("/a", { text: "y", saved: "x", eol: "\n", mtime: 1 });
    expect(dirtyPaths()).toEqual(["/a"]);
    expect(getDraft("/a")?.text).toBe("y");
    clearDraft("/a");
    expect(dirtyPaths()).toEqual([]);
  });
  test("every way out asks when something is unsaved and none asks when nothing is", () => {
    expect(EXITS).toEqual(["row", "folder", "up", "history", "search-hit", "search-open", "finder-close", "preview-close", "done"]);
    for (const e of EXITS) { expect(exitDecision(1, e)).toBe("ask"); expect(exitDecision(3, e)).toBe("ask"); expect(exitDecision(0, e)).toBe("go"); }
  });
  test("saveDrafts saves each draft in the file's own line endings and clears it", async () => {
    setDraft("/a", { text: "x\ny", saved: "x", eol: "\r\n", mtime: 7 });
    const seen: unknown[] = [];
    const r = await saveDrafts(async (p, t, m) => { seen.push([p, t, m]); return { ok: true, mtime: 8 }; });
    expect(r).toEqual({ ok: true });
    expect(seen).toEqual([["/a", "x\r\ny", 7]]);
    expect(dirtyPaths()).toEqual([]);
  });
  test("saveDrafts stops at a refusal and keeps that draft", async () => {
    setDraft("/a", { text: "1", saved: "0", eol: "\n", mtime: 1 });
    setDraft("/b", { text: "2", saved: "0", eol: "\n", mtime: 1 });
    const r = await saveDrafts(async (p) => (p === "/a" ? { ok: true } : { ok: false, error: "changed on disk" }));
    expect(r).toEqual({ ok: false, path: "/b", error: "changed on disk" });
    expect(dirtyPaths()).toEqual(["/b"]);
  });
  test("saveDrafts treats a server that throws as a refusal", async () => {
    setDraft("/a", { text: "1", saved: "0", eol: "\n", mtime: 1 });
    expect((await saveDrafts(async () => { throw new Error("down"); })).ok).toBe(false);
    expect(dirtyPaths()).toEqual(["/a"]);
  });
});

describe("every exit is wired to the guard", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url));
  test("MachineFinder holds each exit behind guarded(...)", async () => {
    const text = await src.text();
    for (const e of EXITS.filter((x) => x !== "done")) expect(text).toContain(`guarded("${e}"`);
  });
  test("the editor's own Done asks through the same decision", async () => {
    expect(await Bun.file(new URL("../src/components/finder/machine/FileEditor.tsx", import.meta.url)).text()).toContain('exitDecision(dirty ? 1 : 0, "done")');
  });
});
