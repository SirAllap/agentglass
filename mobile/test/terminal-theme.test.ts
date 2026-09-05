/*
 * Changing theme must not disconnect the pane.
 *
 * The document is built once — `useState(() => terminalDocument(…))` — with the
 * palette baked into it, all sixteen ANSI colours included. So the obvious way
 * to change theme is to build another one, and the obvious way is wrong: the
 * `source` prop changing reloads the WebView, and a tmux pane is only ever
 * painted by tmux redrawing it on attach. The socket survives a reload (it
 * belongs to React Native, not to the page), so what somebody would see is
 * their terminal blank out and re-attach because they tapped a colour.
 *
 * The colours go through the bridge instead, the way AGX.columns already
 * changes the grid live. This file locks the two halves of that: one mapping
 * rather than two, and a view that keeps its document.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paletteFor, type Palette } from "../../shared/palettes.ts";
import { announce, built } from "./generated-artifacts.ts";

announce("terminal-theme.test.ts");

const { terminalDocument, terminalTheme } = built
  ? await import("../src/terminal/terminal-html.ts")
  : {
      terminalDocument: (() => "") as unknown as typeof import("../src/terminal/terminal-html.ts")["terminalDocument"],
      terminalTheme: (() => ({})) as unknown as typeof import("../src/terminal/terminal-html.ts")["terminalTheme"],
    };

const DARK: Palette = paletteFor("dark", "blue");
const LIGHT: Palette = paletteFor("light", "violet");

const view = readFileSync(join(import.meta.dir, "../src/terminal/TerminalView.tsx"), "utf8");
const html = readFileSync(join(import.meta.dir, "../src/terminal/terminal-html.ts"), "utf8");

describe.skipIf(!built)("one mapping from palette to terminal", () => {
  test("the document carries exactly what the bridge would inject", () => {
    // The failure this prevents is quiet: two mappings that agree today, and a
    // theme change that gives you colours the next cold start does not.
    expect(terminalDocument({ palette: DARK, columns: 80 }))
      .toContain(JSON.stringify(terminalTheme(DARK)));
  });

  test("the accent moves the live parts and leaves the pane's own colours", () => {
    /*
     * An accent overrides primary and primaryHover only (see paletteFor), and
     * this is where that rule earns its keep: red, green, yellow and blue in
     * here are somebody's build output. A phone set to amber must not turn a
     * failing test amber.
     */
    const amber = terminalTheme({ ...DARK, primary: "#f59e0b", primaryHover: "#fbbf24" });
    const base = terminalTheme(DARK);
    const moved = Object.keys(base).filter((k) => base[k] !== amber[k]);
    expect(moved.sort()).toEqual(["brightMagenta", "cursor", "magenta", "selectionBackground"]);
    for (const key of ["red", "green", "yellow", "blue", "brightRed", "brightGreen", "background"]) {
      expect(amber[key]).toBe(base[key]!);
    }
  });

  test("light and dark really are different documents", () => {
    // Cheap, and it catches the palette being dropped on the way in — which
    // looks like "the theme does not work" and reads as a UI bug for hours.
    expect(terminalTheme(LIGHT).background).toBe(LIGHT.bg);
    expect(terminalTheme(LIGHT).foreground).toBe(LIGHT.text);
    expect(terminalTheme(DARK).background).not.toBe(terminalTheme(LIGHT).background);
  });
});

describe("the bridge repaints in place", () => {
  test("AGX has a theme() and it assigns the option rather than reloading", () => {
    expect(html).toMatch(/theme: function \(next\)/);
    expect(html).toContain("term.options.theme = next");
    // The page background is a stylesheet rule written from the palette the
    // document was built with, and a stylesheet is not something a theme change
    // can reach. Without these, a dark frame stays around a light terminal.
    expect(html).toContain("document.body.style.background = next.background");
  });

  test("the view keeps its document", () => {
    /*
     * Both halves are structural, so they are checked in the source: a second
     * `terminalDocument(` call, or a `source` that depends on anything but
     * `doc`, is the reload coming back.
     */
    expect(view.match(/terminalDocument\(/g)?.length).toBe(1);
    expect(view).toContain("useState(() => terminalDocument({ palette, columns }))");
    expect(view).toContain('useMemo(() => ({ html: doc, baseUrl: "about:blank" }), [doc])');
  });

  test("the injection is driven by the colours, not by the palette object", () => {
    /*
     * `palette` is the app's mutable singleton: its identity never changes, so
     * an effect depending on it fires once at mount and never again — the
     * theme would change everywhere except on the one screen this is about.
     * Depending on the serialised colours is what makes it fire when a colour
     * moves and only then.
     */
    expect(view).toContain("const themeJson = JSON.stringify(terminalTheme(palette));");
    expect(view).toMatch(/inject\(`window\.AGX && window\.AGX\.theme\(\$\{themeJson\}\)`\);\s*\}, \[themeJson, inject\]\);/);
  });
});
