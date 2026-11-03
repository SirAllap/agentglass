import { describe, expect, test } from "bun:test";

// Opening the side panel (or zooming the whole app) shrinks the canvas stage.
// A layout that followed the stage's width re-wrapped unplaced blocks into new
// rows under the person's hands: six blocks in one row became two rows of three.
const src = await Bun.file(new URL("../src/components/orchestration/flow/FlowCanvas.tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("the canvas world does not follow the stage", () => {
  test("layoutBlocks is called with the fixed world size, not stage.w or the window", () => {
    const call = code.match(/layoutBlocks\(([^)]*)\)/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain("WORLD_W");
    expect(call![1]).not.toContain("stage");
    expect(call![1]).not.toContain("innerHeight");
  });
  test("the layout memo depends on the flow only", () => {
    expect(code).toContain("[flow]);");
    expect(code).not.toMatch(/layoutBlocks[^\n]*\[flow, stage/);
  });
  test("a resize after the first measured size never refits the view", () => {
    const eff = code.match(/useLayoutEffect\(\(\) => \{ if \(\+\+sizeFits\.current <= 2[^\n]*\[sizeShape\]\);/);
    expect(eff).not.toBeNull();
    expect(code).not.toMatch(/useLayoutEffect\(\(\) => \{ if \(!touched\.current\) setView\(fitView\(bounds, stage\)\); \}, \[sizeShape\]\)/);
  });
});
