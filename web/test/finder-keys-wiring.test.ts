/*
 * The wiring of the key dispatch, asserted against source: the window's chords swallowed while a name is
 * typed or a dialog is up, the preview marked as a document, Ctrl+Enter and Esc on the cursor row, and
 * where Ctrl+V and a new folder land.
 */
import { describe, expect, test } from "bun:test";

const fm = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
const ops = await Bun.file(new URL("../src/components/finder/machine/useFinderOps.tsx", import.meta.url)).text();
const ql = await Bun.file(new URL("../src/components/finder/machine/QuickLook.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");

describe("the wiring", () => {
  test("the window handler swallows the window's chords before it looks at a dialog or a rename, and Ctrl+K opens the search only after", () => {
    const h = code(fm);
    const swallow = h.indexOf("windowChord(win)");
    expect(swallow).toBeGreaterThan(0);
    expect(swallow).toBeLessThan(h.indexOf("if (opsOpen.current) return;"));
    expect(swallow).toBeLessThan(h.indexOf("openSearch(); return;"));
    expect(h).toContain("root.current?.querySelector('[role=\"dialog\"], [role=\"alertdialog\"]')");
  });
  test("the preview is marked, and the handler tells the finder when the focus is in its document", () => {
    expect((code(ql).match(/data-finder-preview/g) ?? []).length).toBe(2);
    expect(code(fm)).toContain("inPreview,");
    expect(code(fm)).toContain("inFilter:");
  });
  test("Ctrl+Enter takes the cursor row whatever else is chosen, and Esc on several rows keeps cursor and anchor", () => {
    expect(code(fm)).toContain('if (a.t === "opentab" && deepest) {');
    expect(code(fm)).toContain("dismissChoice(m.choice)");
  });
  test("Ctrl+V pastes into the column under the pointer, else the focused one; a new folder is made at once", () => {
    const key = code(ops).slice(code(ops).indexOf("const key = useCallback("));
    expect(key).toContain('if (t === "paste") { const dir = e.pasteDir() ?? e.here();');
    expect(code(fm)).toContain("pasteDir: () => (pointerNav.current ? pointerDir.current : null)");
    expect(code(ops)).toContain('freeName("new folder"');
    expect(code(ops)).toContain('op: "mkdir", parent: into, name }');
    expect(code(ops)).toContain('if (!c || !c.rows.length) { doItem("new-folder", null, into); return; }');
  });
});
