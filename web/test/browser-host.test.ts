import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { browserPlaceOf, floatingFrame, insetBottom } from "../src/lib/browserHost.ts";

const slot = (id: string, place: "rail" | "bench", visible: boolean, seen: number) => ({ id, place, visible, seen });
const rect = { x: 10, y: 20, w: 300, h: 200 };

describe("one browser, two places", () => {
  test("the place that came on screen last holds it", () => {
    const slots = [slot("rail", "rail", true, 1), slot("bench", "bench", true, 2)];
    expect(browserPlaceOf(slots, "rail")).toBe("bench");
  });
  test("looking at the view again takes it back", () => {
    const slots = [slot("rail", "rail", true, 3), slot("bench", "bench", true, 2)];
    expect(browserPlaceOf(slots, "bench")).toBe("rail");
  });
  test("a place that goes off screen keeps it", () => {
    const slots = [slot("rail", "rail", false, 1), slot("bench", "bench", false, 2)];
    expect(browserPlaceOf(slots, "bench")).toBe("bench");
  });
  test("the bench going away hands it back to the view", () => {
    expect(browserPlaceOf([slot("rail", "rail", false, 1)], "bench")).toBe("rail");
  });
  test("no place, no holder", () => {
    expect(browserPlaceOf([], null)).toBeNull();
  });
});

describe("the bench's rounded bottom corners", () => {
  test("the rect loses the radius at the bottom only", () => {
    expect(insetBottom(rect, 12)).toEqual({ x: 10, y: 20, w: 300, h: 188 });
  });
  test("never goes negative", () => {
    expect(insetBottom({ ...rect, h: 5 }, 12).h).toBe(0);
  });
});

describe("first bounds come from the settled rect", () => {
  const src = readFileSync(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url), "utf8");
  test("the bench re-measures when its open transition ends, with no timer", () => {
    expect(src).toContain("onAnimationComplete={remeasureBrowser}");
    expect(src).toContain("data-bench-window");
  });
});

describe("where the browser's box goes", () => {
  test("over the bench slot while the bench holds it and shows it", () => {
    expect(floatingFrame("bench", true, rect)).toEqual(rect);
  });
  test("stays in its view otherwise", () => {
    expect(floatingFrame("rail", true, rect)).toBeNull();
    expect(floatingFrame("bench", false, rect)).toBeNull();
    expect(floatingFrame("bench", true, null)).toBeNull();
    expect(floatingFrame("bench", true, { ...rect, w: 0 })).toBeNull();
  });
});

describe("review fixes (source level)", () => {
  const bench = readFileSync(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");
  const pre = readFileSync(new URL("../../electron/preload.js", import.meta.url), "utf8");
  test("a closed bench gives its portals floor 0", () => {
    expect(bench).toContain("value={away || !st.open ? 0 : LAYER.benchOverlay}");
  });
  test("the bottom inset applies only to a slot that reaches the window's bottom edge", () => {
    expect(insetBottom(rect, 12, rect.y + rect.h + 12)).toEqual({ x: 10, y: 20, w: 300, h: 188 });
    expect(insetBottom(rect, 12, rect.y + rect.h + 40)).toEqual(rect);
  });
  test("drag end and resize end remeasure", () => {
    expect(bench).toMatch(/const onBarUp[\s\S]*?remeasureBrowser\(\);/);
    expect(bench).toMatch(/const onEdgeUp[\s\S]*?remeasureBrowser\(\);/);
  });
  test("links queue until the renderer route is ready, then flush; crash goes to the OS", () => {
    expect(main).toContain('ipcMain.on("ag:link-route-ready"');
    expect(main).toContain("pendingLinks.push(u.href)");
    expect(main).toMatch(/render-process-gone", \(\) => \{[\s\S]*?shell\.openExternal\(u\)/);
    expect(pre).toContain('ipcRenderer.send("ag:link-route-ready")');
  });
  test("ag:open-machine refuses any sender but the main window", () => {
    expect(main).toMatch(/"ag:open-machine", \(e, url\) => \{\s*if \(e\.sender !== win\.webContents\) return false;/);
  });
});
