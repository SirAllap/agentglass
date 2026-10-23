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
    expect(main).toContain('win.webContents.send("ag:browser-key", m.endsWith("3") ? "<" : ">", guest.id)');
  });
  // In the page's own world a page could hook addEventListener, read the token off the
  // listener and print it at will; it could also test the flag to tell it is inside agentglass.
  test("the listener runs in an isolated world, never in the page's", () => {
    const inject = main.slice(main.indexOf('guest.on("dom-ready"'), main.indexOf('guest.on("console-message"'));
    expect(inject).toContain("guest.executeJavaScriptInIsolatedWorld(SIDE_BUTTON_WORLD, [{ code:");
    expect(inject).not.toContain("guest.executeJavaScript(");
    expect(main).toMatch(/const SIDE_BUTTON_WORLD = (\d+);/);
    const world = Number(main.match(/const SIDE_BUTTON_WORLD = (\d+);/)![1]);
    expect(world).not.toBe(0);
    expect(world).not.toBe(999);
    for (const m of main.matchAll(/executeJavaScript\(/g)) {
      const call = main.slice(m.index!, main.indexOf("\n", m.index!));
      expect(call).not.toContain("SIDE_BUTTON_TOKEN");
      expect(call).not.toContain("__agxSide");
    }
  });
  // The glass blocks the person while an agent drives; a side button must not walk the agent's page.
  // A press names its guest: a token printed in a background tab must not move the tab in front.
  test("the panel navigates only the tab the press came from, and not under the glass", () => {
    expect(panel).toContain('if (k === "<" || k === ">") { sideNavRef.current(k === "<", guest); return; }');
    const nav = panel.slice(panel.indexOf("sideNavRef.current = (back, guest) => {"), panel.indexOf("useEffect(() => onBrowserKey("));
    expect(nav).toMatch(/^sideNavRef\.current = \(back, guest\) => \{\s*if \(document\.querySelector\("\.agx-presence-glass"\)\) return;/);
    expect(nav).toContain("if (!w || guest === undefined || id !== guest) return;");
    expect(nav.indexOf("id !== guest")).toBeLessThan(nav.indexOf("w.goBack()"));
    expect(nav).not.toContain("el()?.go");
  });
});
