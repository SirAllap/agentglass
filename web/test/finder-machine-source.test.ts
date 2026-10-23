/*
 * Rules about the Machine finder that live in its source.
 *
 * There is no renderer here, so what cannot be asserted on a function is
 * asserted on the text: the finder never writes, takes its sizes and layers from
 * the house tokens, only ever replaces the Machine tab's body, and every comment
 * and string stays clear of real names.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const dir = new URL("../src/components/finder/machine/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
const texts = await Promise.all(files.map(async (f) => [f, await Bun.file(new URL(f, dir)).text()] as const));
const palette = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
const server = await Bun.file(new URL("../../server/src/index.ts", import.meta.url)).text();
const strip = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");

describe("the finder only looks", () => {
  test("nothing under finder/machine writes, moves or deletes", () => {
    expect(texts.length).toBeGreaterThan(5);
    for (const [f, t] of texts) {
      const code = strip(t);
      expect(code).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
      expect(code).not.toMatch(/\bapi\.(write|delete|rename|move|trash|mkdir|post)\w*/i);
      expect(code, f).not.toMatch(/\b(unlink|rmSync|writeFile)\b/);
    }
  });
});

describe("house tokens", () => {
  test("icons take a rung of ICON, never a bare number", () => {
    for (const [f, t] of texts) expect(strip(t), f).not.toMatch(/Icon size=\{\d/);
  });
  test("a menu sits on the menu layer and nothing here invents a z-index above the page", () => {
    const pop = texts.find(([f]) => f === "Popover.tsx")![1];
    expect(pop).toContain("LAYER.menu");
    for (const [f, t] of texts) expect(strip(t), f).not.toMatch(/zIndex:\s*\d{3,}/);
  });
  test("colours are theme variables, not hex", () => {
    for (const [f, t] of texts) expect(strip(t), f).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe("only the Machine tab changes", () => {
  test("the palette swaps its body for the finder when the tab is Machine", () => {
    expect(palette).toContain('const finderOn = tab === "machine" && !!homeDir && !placeErr');
    expect(palette).toContain("{finderOn ? (");
    expect(palette).toContain("<MachineFinder");
  });
  test("words no longer hand the tab back: there is no box on Machine, so a leftover query is cleared", () => {
    expect(palette).toContain('if (tab === "machine" && q && !looksLikePath(q)) setQ("")');
  });
  test("the search box is marked so the finder may share its arrow keys", () => {
    expect(palette).toContain("data-finder-box");
  });
});

describe("the door on the engine", () => {
  test("/browse/list is behind the same switch and the same gate as /browse", () => {
    const start = server.indexOf('pathname === "/browse" || pathname === "/browse/list"');
    expect(start).toBeGreaterThan(0);
    const gate = server.slice(start, server.indexOf('if (pathname === "/browse/list")', start));
    expect(gate).toContain("FS_BROWSE_ENABLED");
    expect(gate).toContain("heldBackFrom");
  });
  test("/preview/file sits inside that gate, reads through previewSlice, and never serves a script", () => {
    const gateAt = server.indexOf('pathname === "/browse" || pathname === "/browse/list"');
    const at = server.indexOf('if (pathname === "/preview/file") {');
    expect(at).toBeGreaterThan(gateAt);
    // Still inside the same `if` as FS_BROWSE_ENABLED: nothing closes it in between.
    expect(server.indexOf("FS_BROWSE_ENABLED", gateAt)).toBeLessThan(at);
    const body = server.slice(at, server.indexOf('if (pathname === "/preview/raw"', at));
    expect(body).toContain("previewSlice(");
    expect(body).toContain("localBrowse");
    expect(body).toMatch(/content-security-policy"?:\s*"sandbox;/);
    expect(body).toContain("nosniff");
    expect(body).not.toContain("readFile");
  });
});

describe("a request is one shot", () => {
  // The palette keeps the path it was asked for in its query; left there, every later mount replayed it and reopened the finder in that folder instead of where it was closed.
  const finder = texts.find(([f]) => f === "MachineFinder.tsx")![1];
  test("the palette forgets the path once the finder has acted on it", () => {
    const el = palette.slice(palette.indexOf("<MachineFinder "), palette.indexOf("/>", palette.indexOf("<MachineFinder ")));
    expect(el).toMatch(/onTargetDone=\{\(\) => setQ\(""\)\}/);
  });
  test("the finder says so whether it moved or was already there", () => {
    const at = finder.indexOf("void api.previewFacts(target)");
    expect(at).toBeGreaterThan(0);
    const body = finder.slice(at, finder.indexOf("}).catch(", at));
    expect(body.match(/targetDone\.current\?\.\(\)/g)?.length).toBe(1);
    expect(body.indexOf("targetDone.current?.()")).toBeLessThan(body.indexOf('move === "stay"'));
  });
  test("where it opens is decided by openingOf, not inline", () => {
    expect(finder).toMatch(/openingOf\(/);
    expect(finder).not.toMatch(/snapApplies\(s, start/);
  });
});
