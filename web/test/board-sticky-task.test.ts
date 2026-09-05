/*
 * The frozen Task column, and what may pass in front of it.
 *
 * Nothing may. It was `z-index: 1` while an assignee's face is `4` — the faces
 * carry a layer so they overlap each other left to right — so scrolling the
 * board sideways slid somebody's avatar over the titles, which is what he
 * photographed. A column things pass BEHIND has to outrank everything that
 * passes, and the two numbers live in different files, which is exactly how
 * they drifted apart.
 */
import { describe, expect, it } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

const layerOf = (rule: string): number => {
  const body = new RegExp(`\\.${rule}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return Number(/z-index:\s*(\d+)/.exec(body)?.[1] ?? "0");
};

describe("what passes behind the Task column", () => {
  it("the faces are below it", () => {
    // `zIndex: 3 - n` in the row: the first face is the highest of them.
    const face = Number(/zIndex: (\d+) - n/.exec(panel)?.[1] ?? "99");
    expect(face).toBeLessThan(layerOf("agx-stick"));
  });

  it("and its heading is above the column itself", () => {
    expect(layerOf("agx-stick-head")).toBeGreaterThan(layerOf("agx-stick"));
  });

  it("it is opaque, or the columns show through as they pass", () => {
    expect(/\.agx-stick\s*\{[^}]*background:/.test(css)).toBe(true);
  });

  it("and it draws an edge, so the eye knows why the text stopped", () => {
    expect(/\.agx-stick\s*\{[^}]*box-shadow:/.test(css)).toBe(true);
  });

  /*
   * The padding has to be INSIDE the frozen cell.
   *
   * `left: 0` sticks to the scrollport; a row's own `px-4` scrolls away with
   * everything else, so the titles crept left as the board moved and ended up
   * against the edge — reported as "there is scroll in the frozen column",
   * which is what it looked like.
   */
  it("carries the row's left padding, so nothing creeps as the board moves", () => {
    expect(/\.agx-stick\s*\{[^}]*padding-left:/.test(css)).toBe(true);
    expect(panel).toContain('className="agx-row w-full text-left pr-4');
    expect(panel).not.toContain('className="agx-row w-full text-left px-4');
  });

  it("and the status heading holds still with it", () => {
    // It is about the group, not about the columns: watching it slide out of
    // the pane while its own rows stayed read as it having come loose.
    expect(layerOf("agx-stick-group")).toBeGreaterThan(0);
    expect(panel).toContain('className="agx-stick-group');
  });
});
