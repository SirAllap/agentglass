/*
 * An endless CSS loop that nothing pauses repaints every frame in a window nobody
 * is looking at (the desktop webview composites in software). One backstop rule in
 * index.css pauses every animation under data-idle; this pins it, and fails if a
 * stylesheet or inline style later forces a loop to keep running.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(css|tsx?)$/.test(n)) out.push(f);
  }
  return out;
}

/** The body of the rule whose selector list contains `sel`, cut at its own closing brace. */
function ruleBody(css: string, sel: string): string | null {
  const at = css.indexOf(sel);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("idle animations", () => {
  const css = strip(readFileSync(join(root, "src/index.css"), "utf8"));
  const cover = strip(readFileSync(join(root, "index.html"), "utf8"));

  test("one rule pauses every element, pseudo-elements included, except the launch cover", () => {
    for (const pseudo of ["", "::before", "::after"]) {
      const body = ruleBody(css, `:root[data-idle="1"] :not(#ag-cover, #ag-cover *)${pseudo}`);
      expect(body).not.toBeNull();
    }
    const body = ruleBody(css, ':root[data-idle="1"] :not(#ag-cover, #ag-cover *)::after');
    expect(body).toContain("animation-play-state: paused !important");
  });

  test("nothing forces a loop to run with !important", () => {
    const bad = walk(join(root, "src")).filter((f) => /animation-play-state:\s*running\s*!important|animationPlayState:\s*["']running["']/.test(strip(readFileSync(f, "utf8"))));
    expect(bad).toEqual([]);
  });

  test("an endless loop in the page shell stays inside the launch cover", () => {
    const infinite = [...cover.matchAll(/([^{}]+)\{[^{}]*infinite[^{}]*\}/g)].map((m) => m[1].trim());
    expect(infinite.length).toBeGreaterThan(0);
    for (const sel of infinite) expect(/#ag-cover|\.ag-lm|\.agc-/.test(sel)).toBe(true);
  });
});
