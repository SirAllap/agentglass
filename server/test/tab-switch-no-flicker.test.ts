import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderersToPark } from "../../web/src/lib/termRenderer.ts";

const src = readFileSync(new URL("../../web/src/components/TerminalPanel.tsx", import.meta.url), "utf8");
/* Code only: a guard that sits in a comment must not satisfy an assertion. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const body = (name: string) => {
  const i = code.indexOf(name);
  return code.slice(i, code.indexOf("\n}\n", i));
};

describe("tab switch paints once", () => {
  test("renderersToPark keeps the shells just left, releases the oldest", () => {
    let keep: string[] = [];
    const released: string[] = [];
    for (const t of ["a", "b", "c", "d", "e"]) {
      const r = renderersToPark(keep, t, 4);
      keep = r.keep;
      released.push(...r.release);
    }
    expect(keep).toEqual(["b", "c", "d", "e"]);
    expect(released).toEqual(["a"]);
  });

  test("going back to a recent tab finds its renderer: no new context", () => {
    const attach = body("export function attachRenderer");
    expect(attach).toContain("recentlyParked = recentlyParked.filter");
    expect(attach).toContain("!s.webglAddon"); // only builds when none is held
  });

  test("a switch with unchanged size sends no resize and clears nothing", () => {
    const fit = body("function fitTerm");
    const same = fit.indexOf("if (cols === s.term.cols && rows === s.term.rows) return;");
    expect(same).toBeGreaterThan(0);
    expect(fit.indexOf("_renderService?.clear")).toBeGreaterThan(same);
    expect(fit.indexOf("s.term.resize(")).toBeGreaterThan(same);
  });

  test("a WebGL context lost while parked does not re-attach: attachRenderer would cancel the park", () => {
    expect(body("export function attachRenderer")).toContain("if (s.holder.parentElement) attachRenderer(s);");
  });

  test("parking never disposes a renderer of a shell that is on screen", () => {
    expect(body("function disposeRenderer")).toContain("if (s.holder.parentElement) return;");
  });

  test("12 recent shells keep their renderer, under the ~16 WebGL cap", () => {
    expect(src).toMatch(/RECENT_RENDERERS_KEPT = 12;/);
    expect(src).toContain("~16 WebGL contexts");
    let keep: number[] = [];
    let released = 0;
    for (let i = 0; i < 14; i++) { const r = renderersToPark(keep, i, 12); keep = r.keep; released += r.release.length; }
    expect(keep.length).toBe(12);
    expect(released).toBe(2);
  });

  test("a rebuilt renderer stays invisible (opacity, not display) until its first frame", () => {
    const attach = body("export function attachRenderer");
    expect(attach.indexOf("hideUntilFirstFrame(s)")).toBeLessThan(attach.indexOf("s.term.loadAddon(gl)"));
    const hide = body("function hideUntilFirstFrame");
    expect(hide).toContain('style.opacity = "0"');
    expect(hide).not.toContain("display");
    expect(hide).toContain("onRender");
    expect(hide).toContain('style.opacity = ""');
  });
});

describe("tmux redraw lands as one frame", () => {
  test("the generated base config turns on synchronized output", () => {
    const conf = readFileSync(new URL("../src/tmuxconf.ts", import.meta.url), "utf8");
    expect(conf).toContain('set -as terminal-features ",*:sync"');
    // Re-sourcing must not append a second entry: guarded by if-shell on the feature already present.
    expect(conf).toMatch(/if-shell '[^\n]*show -sv terminal-features[^\n]*:sync[^\n]*' "" '/);
  });
});
