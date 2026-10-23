import { describe, expect, test } from "bun:test";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const main = strip(await Bun.file(new URL("../../electron/main.js", import.meta.url)).text());
const panel = strip(await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text());

describe("the mouse's side buttons over a page", () => {
  // On Linux the press reaches neither the window (no app-command) nor the renderer
  // (the guest is its own process): only the page's own mouseup sees it.
  test("the shell listens in every document and reports under a per-process token", () => {
    expect(main).toContain('guest.on("dom-ready"');
    expect(main).toContain("e.button === 3 || e.button === 4");
    expect(main).toMatch(/const SIDE_BUTTON_TOKEN = `agx-side:\$\{require\("crypto"\)\.randomBytes\(8\)/);
    expect(main).toContain("m.startsWith(SIDE_BUTTON_TOKEN)");
    expect(main).toContain('m.endsWith("3") ? "<" : ">"');
  });
  // The glass blocks the person while an agent drives; a side button must not walk the agent's page.
  test("the panel navigates the active tab, and not under the glass", () => {
    expect(panel).toContain('if (k === "<" || k === ">") { sideNavRef.current(k === "<"); return; }');
    expect(panel).toMatch(/sideNavRef\.current = \(back\) => \{\s*if \(document\.querySelector\("\.agx-presence-glass"\)\) return;\s*if \(back\) el\(\)\?\.goBack\(\); else el\(\)\?\.goForward\(\);/);
  });
});
