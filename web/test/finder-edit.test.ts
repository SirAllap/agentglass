import { describe, expect, test } from "bun:test";
import { EXITS, FINDER_EDIT_SLOT, editability, editorLifecycle, exitDecision } from "../src/lib/finderEdit.ts";

describe("editability", () => {
  test("a text file opens in nvim", () => expect(editability({ kind: "text" }).ok).toBe(true));
  test("a binary, an image and a folder have nothing to edit", () => {
    for (const kind of ["binary", "image", "pdf", "dir", "audio", "video"] as const) expect(editability({ kind }).ok).toBe(false);
  });
});

describe("the editor session lifecycle", () => {
  const a = { path: "/o/a.sh" }, b = { path: "/o/b.sh" };
  test("nothing wanted and nothing running does nothing", () => expect(editorLifecycle(null, null)).toBe("keep"));
  test("choosing Editing starts it", () => expect(editorLifecycle(null, a)).toBe("start"));
  test("leaving Editing (another tab, the Finder closing) ends it", () => expect(editorLifecycle(a, null)).toBe("end"));
  test("another file ends this one and starts the next", () => expect(editorLifecycle(a, b)).toBe("restart"));
  test("the same file keeps the session", () => expect(editorLifecycle(a, { path: a.path })).toBe("keep"));
});

describe("leaving with unsaved changes", () => {
  test("every way out asks when nvim holds unsaved changes and none asks when it does not", () => {
    for (const e of EXITS) { expect(exitDecision(true, e)).toBe("ask"); expect(exitDecision(false, e)).toBe("go"); expect(exitDecision(null, e)).toBe("go"); }
  });
  test("the slot is the server's FINDER_EDIT_SLOT", async () => {
    expect(await Bun.file(new URL("../../server/src/bench.ts", import.meta.url)).text()).toContain(`FINDER_EDIT_SLOT = ${FINDER_EDIT_SLOT};`);
  });
});

describe("every exit is wired to the guard, and nvim keeps its own keys", () => {
  const dir = "../src/components/finder/machine/";
  test("MachineFinder holds each exit behind guarded(...)", async () => {
    const text = await Bun.file(new URL(dir + "MachineFinder.tsx", import.meta.url)).text();
    for (const e of EXITS.filter((x) => x !== "tab-away")) expect(text).toContain(`guarded("${e}"`);
    expect(text).toContain('closest?.("[data-finder-nvim]")');
  });
  test("leaving Editing unmounts the terminal, which ends the editor and its session", async () => {
    const text = await Bun.file(new URL(dir + "FinderNvim.tsx", import.meta.url)).text();
    expect(text).toContain("api.finderEditEnd(root)");
  });
  test("the tab row has no second Open in nvim", async () => {
    const text = await Bun.file(new URL(dir + "PreviewBody.tsx", import.meta.url)).text();
    expect(text).not.toContain("onBench");
  });
});
