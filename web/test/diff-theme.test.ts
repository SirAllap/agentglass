// The contract between the diff's theme picker and shiki.
//
// Worth testing on its own because breaking it is invisible. A theme that
// cannot be registered used to leave `codeToTokens` throwing once per line,
// which the renderer catches and answers with plain text — so the diff came out
// as unstyled monochrome, looking exactly like a file whose language has no
// grammar. Nothing was logged and nothing was shown, so the only way to notice
// was to compare two themes side by side.
import { expect, test } from "bun:test";
import { bundledThemes } from "shiki";
import { getHighlighter, ensureTheme, langFromPath, THEMES, themeLabel } from "../src/lib/highlight.ts";

const CODE = 'const greeting = "hello"; // note';

// Stand in for the desktop shell's CSP for this whole file.
//
// The regression: shiki's default Oniguruma engine is WebAssembly, and a
// packaged desktop shell can serve the bundle under `script-src 'self'` with no
// `'wasm-unsafe-eval'`, so the webview refuses to instantiate it and
// `createHighlighter` rejects before a theme or grammar is ever asked for —
// every diff in the app came out monochrome while browsers were fine. The
// guard is installed at import time rather than inside one test because the
// highlighter is memoized: by the time any single test ran, an earlier one
// would already have built it, wasm and all, and the check would pass
// vacuously. With it here, *any* test in this file that reaches for wasm
// fails.
const usedWasm: string[] = [];
for (const k of ["instantiate", "compile", "instantiateStreaming", "compileStreaming"] as const) {
  const refuse = () => { usedWasm.push(k); throw new Error(`WebAssembly.${k} is blocked, as it is under the desktop CSP`); };
  (WebAssembly as unknown as Record<string, unknown>)[k] = refuse;
}
for (const k of ["Instance", "Module"] as const) {
  (WebAssembly as unknown as Record<string, unknown>)[k] = function () {
    usedWasm.push(k);
    throw new Error(`new WebAssembly.${k} is blocked, as it is under the desktop CSP`);
  };
}

test("every theme the picker offers is a real shiki bundled id", () => {
  // A typo, or an id shiki renames or drops in a future major, would otherwise
  // only ever show up as one entry in the menu quietly doing nothing.
  const unknown = THEMES.filter((t) => !(t.id in bundledThemes)).map((t) => t.id);
  expect(unknown).toEqual([]);
});

test("the picker's light/dark grouping matches the theme's own type", async () => {
  // The fallback picks a replacement from the same family, so a mislabelled
  // theme would swap a dark diff onto a light background.
  for (const t of THEMES) {
    const raw = (await bundledThemes[t.id as keyof typeof bundledThemes]()).default;
    expect(`${t.id}:${raw.type}`).toBe(`${t.id}:${t.dark ? "dark" : "light"}`);
  }
});

test("every offered theme tokenizes, in both plain and bold mode", async () => {
  const hl = await getHighlighter();
  await hl.loadLanguage("typescript" as never);
  for (const bold of [false, true]) {
    for (const t of THEMES) {
      const { name, failed } = await ensureTheme(hl, t.id, bold);
      expect(`${t.id} bold=${bold} failed=${failed ?? "-"}`).toBe(`${t.id} bold=${bold} failed=-`);
      // The real assertion: the name we hand back is registered, so this call
      // does not throw and every token comes out with a colour.
      const tokens = hl.codeToTokens(CODE, { lang: "typescript" as never, theme: name! }).tokens.flat();
      expect(tokens.every((x) => !!x.color)).toBe(true);
      expect(new Set(tokens.map((x) => x.color)).size).toBeGreaterThan(1);
    }
  }
});

test("bold mode bolds keywords the theme itself leaves plain", async () => {
  const hl = await getHighlighter();
  await hl.loadLanguage("typescript" as never);
  const count = async (bold: boolean) => {
    const { name } = await ensureTheme(hl, "github-dark", bold);
    return hl.codeToTokens(CODE, { lang: "typescript" as never, theme: name! })
      .tokens.flat().filter((x) => ((x.fontStyle ?? 0) & 2) > 0).length;
  };
  expect(await count(true)).toBeGreaterThan(await count(false));
});

test("a theme that cannot load falls back to one that is actually registered", async () => {
  const hl = await getHighlighter();
  await hl.loadLanguage("typescript" as never);
  // An id shiki does not bundle stands in for the runtime failure we cannot
  // stage here — a theme chunk that 404s or never arrives.
  const { name, failed } = await ensureTheme(hl, "no-such-theme", true);
  expect(failed).toBe("no-such-theme");
  expect(name).toBe("github-dark-bold");
  expect(() => hl.codeToTokens(CODE, { lang: "typescript" as never, theme: name! })).not.toThrow();
});

test("the highlighter tokenizes without instantiating any WebAssembly", async () => {
  const hl = await getHighlighter();
  await hl.loadLanguage("typescript" as never);
  const { name, failed } = await ensureTheme(hl, "gruvbox-dark-medium", true);
  expect(failed).toBeUndefined();
  const tokens = hl.codeToTokens(CODE, { lang: "typescript" as never, theme: name! }).tokens.flat();
  expect(new Set(tokens.map((x) => x.color)).size).toBeGreaterThan(1);
  expect(usedWasm).toEqual([]);
});

test("every language the diff maps a file to actually has a grammar", async () => {
  // A grammar that will not load leaves the file as plain text, which looks
  // identical to a theme failure — so the extension table is checked against
  // shiki directly rather than trusted.
  const hl = await getHighlighter();
  const langs = [...new Set(["a.ts", "a.tsx", "a.js", "a.jsx", "a.json", "a.py", "a.rb", "a.go", "a.rs",
    "a.java", "a.kt", "a.swift", "a.scala", "a.dart", "a.c", "a.cpp", "a.cs", "a.php", "a.css", "a.scss",
    "a.html", "a.xml", "a.vue", "a.svelte", "a.astro", "a.md", "a.mdx", "a.sh", "a.fish", "a.yml",
    "a.toml", "a.ini", "a.sql", "a.graphql", "a.proto", "a.lua", "a.r", "a.ex", "a.clj", "a.hs",
    "a.elm", "a.ml", "a.nim", "a.zig", "Dockerfile", "Makefile"].map((f) => langFromPath(f)!))];
  const failed: string[] = [];
  for (const l of langs) {
    try { await hl.loadLanguage(l as never); } catch { failed.push(l); }
  }
  expect(failed).toEqual([]);
});

test("the failure is reported with the name the user chose, not the internal one", () => {
  // The message goes on the picker button, where "-bold" would be noise.
  expect(themeLabel("kanagawa-dragon-bold")).toBe("Kanagawa Dragon");
  expect(themeLabel("kanagawa-dragon")).toBe("Kanagawa Dragon");
});
