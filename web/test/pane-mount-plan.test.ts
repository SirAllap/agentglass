/*
 * A tab or focus change must move only the holders that really change slot.
 * Today's effect (deps [open, paneIds, focusIdx]) moves every holder on every
 * run; the count below is what the user sees as flicker.
 */
import { describe, expect, test } from "bun:test";
import { mountOps, planPaneMount } from "../src/lib/paneMount.ts";

const panel = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();

describe("holder moves per change", () => {
  test("focus change in a split: 0 moves", () => {
    expect(mountOps(planPaneMount(["a", "b"], ["a", "b"]))).toBe(0);
  });
  test("tab switch in one slot: 1 leave, 1 enter, nothing else", () => {
    const p = planPaneMount(["a"], ["b"]);
    expect(p).toEqual({ keep: [], leave: ["a"], enter: ["b"] });
  });
  test("tab switch in a split keeps the other pane", () => {
    const p = planPaneMount(["a", "c"], ["a", "b"]);
    expect(p.keep).toEqual(["a"]);
    expect(mountOps(p)).toBe(2);
  });
});

describe("the real mount effect", () => {
  const i = panel.indexOf("el.appendChild(s.holder);\n      if (!s.opened)");
  const end = panel.indexOf("}, [open, paneIds", i);
  const deps = panel.slice(end, panel.indexOf("\n", end));
  test("does not re-run on focusIdx alone", () => {
    expect(deps).not.toContain("focusIdx");
  });
  test("the effect calls the plan and only detaches holders whose pane left", () => {
    const start = panel.indexOf("const plan = planPaneMount(");
    expect(start).toBeGreaterThan(0);
    const run = panel.slice(start, end);
    expect(run).toContain("plan.leave");
    expect(run).toContain("if (mounted.has(id)) return;");
  });
  test("the effect's own cleanup detaches nothing; only the [open] effect does", () => {
    const cleanup = panel.slice(panel.indexOf("      panelClose = () => {};\n      paneRootNow"), end);
    expect(cleanup).not.toContain("removeChild");
    expect(cleanup).not.toContain("parkRenderer");
    expect(panel).toContain("unmountAllRef.current();");
  });
  test("a holder that already showed frames is never hidden again", () => {
    const f = panel.slice(panel.indexOf("function hideUntilFirstFrame"));
    expect(f.slice(0, 200)).toContain("s.painted");
  });
});
