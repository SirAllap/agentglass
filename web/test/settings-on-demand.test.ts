/*
 * Settings is not in the first bundle, and neither is the Finder.
 *
 * It is the largest file the window has and it was imported by the root to be
 * mounted closed on every start. It now arrives the first time it is opened,
 * and from then on stays mounted, so closing it is still `open={false}` and
 * the page it was on is still there the next time.
 */
import { describe, expect, test } from "bun:test";
import { openedOnce } from "../src/lib/openedOnce.ts";

const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const code = app.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("mounted from the first open, for good", () => {
  test("nothing before it is asked for, everything after", () => {
    const seen = openedOnce();
    expect(seen(false)).toBe(false);
    expect(seen(false)).toBe(false);
    expect(seen(true)).toBe(true);
    // Closed again: still mounted, or the dialog would forget its page and lose its way out.
    expect(seen(false)).toBe(true);
  });

  test("two dialogs do not share one answer", () => {
    const a = openedOnce(), b = openedOnce();
    a(true);
    expect(b(false)).toBe(false);
  });
});

describe("how the root brings it in", () => {
  test("by a lazy import, in the house form, and by no other", () => {
    expect(code).toContain('const SettingsModal = lazy(() => import("./components/SettingsModal.tsx").then((m) => ({ default: m.SettingsModal })));');
    expect(code).not.toMatch(/import \{[^}]*\bSettingsModal\b[^}]*\} from/);
  });

  test("it is drawn only once wanted, inside a boundary", () => {
    expect(code).toContain("const settingsWanted = settingsSeen.current(settingsOpen);");
    expect(code).toContain("const settingsModal = settingsWanted ? (");
    const at = code.indexOf("const settingsModal = settingsWanted ? (");
    const el = code.slice(at, code.indexOf(") : null;", at));
    expect(el.indexOf('<ViewBoundary label="Settings">')).toBeGreaterThan(-1);
    expect(el.indexOf("<Suspense fallback={null}>")).toBeGreaterThan(el.indexOf("<ViewBoundary"));
    expect(el.indexOf("<SettingsModal")).toBeGreaterThan(el.indexOf("<Suspense"));
    expect(el).toContain("open={settingsOpen}");
  });

  test("the Finder comes the same way", () => {
    expect(code).toContain('const FilePalette = lazy(() => import("./components/FilePalette.tsx").then((m) => ({ default: m.FilePalette })));');
    expect(code).not.toMatch(/import \{[^}]*\bFilePalette\b[^}]*\} from/);
    const at = code.indexOf("{finderSeen.current(filesOpen) && (");
    expect(at).toBeGreaterThan(-1);
    const el = code.slice(at, code.indexOf("</ViewBoundary>", at));
    expect(el).toContain('<ViewBoundary label="Finder">');
    expect(el.indexOf("<FilePalette")).toBeGreaterThan(el.indexOf("<Suspense fallback={null}>"));
    expect(el).toContain("open={filesOpen}");
  });

  test("no module the first bundle keeps imports either dialog", async () => {
    // A static import anywhere else would pull it straight back into the entry.
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = new URL("../src/", import.meta.url).pathname;
    const importers: string[] = [];
    for await (const f of glob.scan(root)) {
      // The pages cut out of the modal (components/settings/pages/) are part of its chunk: only the modal imports them.
      if (/components\/(SettingsModal|FilePalette)\.tsx$/.test(f) || f.startsWith("components/settings/pages/")) continue;
      const src = await Bun.file(root + f).text();
      if (/from "[^"]*\/(SettingsModal|FilePalette)\.tsx"/.test(src)) importers.push(f);
    }
    expect(importers).toEqual([]);
  });
});
