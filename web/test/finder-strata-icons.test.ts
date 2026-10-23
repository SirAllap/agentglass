import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { CTP_DARK, CTP_LIGHT, iconSvg, strataIconFor } from "../src/lib/strataIcons.ts";

// The rules are Strata's (src/ui/browser/entry.rs and entry/catppuccin.rs): an exact name first,
// then the affix patterns, then the longest dotted suffix, then the extension groups, then a text file.
describe("strataIconFor", () => {
  const f = (name: string) => strataIconFor(name, false);
  test("a folder and a broken link", () => {
    expect(strataIconFor("docs", true)).toEqual({ set: "act", name: "folder" });
    expect(strataIconFor("dangling", false, true)).toEqual({ set: "act", name: "x" });
  });
  test("a name beats an extension", () => {
    expect(f("Dockerfile")).toEqual({ set: "ctp", name: "docker" });
    expect(f(".bashrc")).toEqual({ set: "ctp", name: "bash" });
    expect(f("id_rsa")).toEqual({ set: "act", name: "key-round" });
  });
  test("an affix pattern", () => {
    expect(f("tsconfig.build.json")).toEqual({ set: "ctp", name: "typescript-config" });
    expect(f("zsh_history")).toEqual({ set: "act", name: "file-terminal" });
  });
  test("the longest suffix wins: d.ts over ts", () => {
    expect(f("api.d.ts").name).not.toBe(f("api.ts").name);
  });
  test("extension groups and the plain-text fallback", () => {
    expect(f("photo.PNG")).toEqual({ set: "act", name: "image" });
    expect(f("clip.mp4")).toEqual({ set: "act", name: "video" });
    expect(f("song.mp3")).toEqual({ set: "act", name: "audio-lines" });
    expect(f("bundle.zip")).toEqual({ set: "act", name: "file-archive" });
    expect(f("report.py")).toEqual({ set: "ctp", name: "python" });
    expect(f("data.json")).toEqual({ set: "ctp", name: "json" });
    expect(f("page.html")).toEqual({ set: "ctp", name: "html" });
    expect(f("notes.txt")).toEqual({ set: "act", name: "file-text" });
    expect(f("README")).toEqual({ set: "ctp", name: "readme" });
    expect(f("zzz.unknownext")).toEqual({ set: "act", name: "file-text" });
  });
  test("every icon the rules can name is a vendored file", () => {
    const dir = new URL("../src/assets/strata/", import.meta.url);
    const have = { ctp: new Set(readdirSync(new URL("ctp/", dir)).map((x) => x.replace(/\.svg$/, ""))), act: new Set(readdirSync(new URL("actions/", dir)).map((x) => x.replace(/\.svg$/, ""))) };
    const map = JSON.parse(readFileSync(new URL("map.json", dir), "utf8")) as { names: Record<string, string>; exts: Record<string, string>; fileNames: Record<string, string>; affix: string[][]; arms: [string[], string][] };
    const refs = [...Object.values(map.names), ...Object.values(map.exts), ...Object.values(map.fileNames), ...map.affix.map((a) => a[2]!), ...map.arms.map((a) => a[1])];
    expect(refs.length).toBeGreaterThan(1000);
    for (const r of refs) { const [set, name] = r.split(":") as ["ctp" | "act", string]; expect(have[set].has(name), r).toBe(true); }
  });
});

describe("iconSvg", () => {
  test("a Catppuccin icon takes the palette of the flavour, and none of its variables survive", () => {
    const src = readFileSync(new URL("../src/assets/strata/ctp/python.svg", import.meta.url), "utf8");
    expect(src).toContain("var(--vscode-ctp-blue)");
    const dark = iconSvg("ctp", src, 16), light = iconSvg("ctp", src, 16, false);
    expect(dark).toContain(CTP_DARK.blue); expect(light).toContain(CTP_LIGHT.blue);
    expect(dark).not.toContain("--vscode-ctp"); expect(dark).toContain('width="16"');
  });
  test("a chrome icon is drawn in the colour of the text around it", () => {
    const src = readFileSync(new URL("../src/assets/strata/actions/folder.svg", import.meta.url), "utf8");
    expect(src).toContain("#8bc9eb");
    const out = iconSvg("act", src, 17);
    expect(out).toContain('stroke="currentColor"'); expect(out).not.toContain("#8bc9eb"); expect(out).toContain('height="17"');
  });
});
