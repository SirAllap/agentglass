/*
 * Every web link that would open the machine's browser follows the "Open web
 * links in" setting. Source-level on purpose: the 50 call sites are not worth
 * mounting, and what must never happen is one of them (or the desktop shell's
 * own escapes) skipping the single router.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "../src");
const ELECTRON = join(import.meta.dir, "../../electron");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(n) ? [p] : [];
  });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("web links go through the router", () => {
  const src = files(WEB).filter((f) => !f.endsWith(".gen.ts"));

  it("only externalUrl.ts calls window.open (the same-origin export downloads aside)", () => {
    const bad = src.filter((f) => /window\.open\(/.test(strip(readFileSync(f, "utf8"))))
      .filter((f) => !f.endsWith("lib/externalUrl.ts") && !f.endsWith("components/CommandPalette.tsx"))
      .map((f) => f.slice(WEB.length + 1));
    expect(bad).toEqual([]);
  });

  it("the CommandPalette exception is downloads only, never a web link", () => {
    const body = strip(readFileSync(join(WEB, "components/CommandPalette.tsx"), "utf8"));
    for (const m of body.matchAll(/window\.open\(([^)]*\)?)/g)) expect(m[1]).toContain("api.exportUrl");
  });

  it("nobody else opens a link by hand: no location.assign or an <a target=_blank> built in code", () => {
    const bad = src.filter((f) => /(?:window\.)?location\.(?:assign|replace)\(\s*(?:url|href|[a-z]+\.url)\b/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => f.slice(WEB.length + 1));
    expect(bad).toEqual([]);
  });

  it("every openExternal in the app is the routed one from externalUrl.ts", () => {
    for (const f of src) {
      const code = strip(readFileSync(f, "utf8"));
      if (!/\bopenExternal\(/.test(code) || f.endsWith("lib/externalUrl.ts")) continue;
      const imports = /import\s*\{[^}]*\bopenExternal\b[^}]*\}\s*from\s*"([^"]+)"/.exec(code);
      const own = /(?:function|const)\s+openExternal\b/.test(code);
      expect(own, `${f} defines its own openExternal`).toBe(false);
      // linkRouter keeps a RouteDeps field of that name, fed by the import.
      expect(imports?.[1] ?? "", f).toMatch(/externalUrl\.ts$/);
    }
  });

  it("openExternal consults the router, and only Ctrl/explicit callers skip it", () => {
    const code = strip(readFileSync(join(WEB, "lib/externalUrl.ts"), "utf8"));
    expect(code).toMatch(/opts\.machine\s*&&\s*routeLink\(href\)|!opts\.machine\s*&&\s*routeLink\(href\)/);
    const skippers = src.filter((f) => /openExternal\([^)]*machine:\s*(?:true|wantsExternal)/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => f.slice(WEB.length + 1)).sort();
    expect(skippers).toEqual(["components/BrowserPanel.tsx", "lib/linkRouter.ts", "lib/markdown.tsx"]);
  });

  it("the setting keeps its id and reads Open web links in", () => {
    const reg = readFileSync(join(WEB, "lib/settingsRegistry.ts"), "utf8");
    expect(reg).toMatch(/id: "terminal\.otherLinks"[^\n]*label: "Open web links in"/);
    expect(readFileSync(join(WEB, "components/settings/pages/terminalRows.ts"), "utf8")).toContain('id: "terminal.otherLinks", section: "history", label: "Open web links in"');
  });
});

describe("the desktop shell's escapes", () => {
  const main = strip(readFileSync(join(ELECTRON, "main.js"), "utf8"));
  const start = main.indexOf("function openLinksOutside(");
  const handler = main.slice(start, main.indexOf("\n}\n", start));

  it("target=_blank, window.open and an off-app navigation go to the renderer, not the OS", () => {
    expect(handler).toContain("setWindowOpenHandler");
    expect(handler).toContain('"will-navigate"');
    expect(handler).toContain('webContents.send("ag:open-link"');
    // Only two OS hand-offs: the fallback for a window that cannot be asked, and the flush when the renderer crashed.
    expect(handler.match(/shell\.openExternal/g)?.length).toBe(2);
    expect(handler).toMatch(/else shell\.openExternal/);
  });

  it("still refuses everything but http(s) before anything is sent", () => {
    expect(handler).toMatch(/u\.protocol !== "http:" && u\.protocol !== "https:"\) return false;\s*\/\*[\s\S]*?\*\/|u\.protocol !== "http:" && u\.protocol !== "https:"\) return false;/);
    const ext = handler.indexOf("const external");
    expect(handler.indexOf('u.protocol !== "http:"', ext)).toBeLessThan(handler.indexOf('"ag:open-link"', ext));
  });

  it("the machine door is http(s) only and the preload exposes both ends", () => {
    const door = main.slice(main.indexOf('ipcMain.handle("ag:open-machine"'));
    expect(door.slice(0, 400)).toMatch(/protocol !== "http:" && u\.protocol !== "https:"\) return false/);
    const pre = readFileSync(join(ELECTRON, "preload.js"), "utf8");
    expect(pre).toContain('ipcRenderer.on("ag:open-link"');
    expect(pre).toContain('ipcRenderer.invoke("ag:open-machine"');
  });
});
