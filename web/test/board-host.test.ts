/*
 * One board, two places to show it.
 *
 * The pull-request and task boards can be opened on the rail and in the bench.
 * A copy in each was the build this replaces: each copy kept its own filter,
 * page and open pull request, so opening one in the bench and then going to the
 * view showed a different answer, and both rendered and polled. What is pinned
 * here is the rule that picks which place holds the single board, and the seams
 * that make it single — the DOM move itself needs a document `bun test` does
 * not have, and was measured in the rendered app.
 */
import { describe, expect, it } from "bun:test";
import { LAYER } from "../src/lib/layers.ts";

const load = async () => await import(`../src/lib/boardHost.ts?t=${Math.random()}`) as typeof import("../src/lib/boardHost.ts");
const noEl = {} as HTMLElement;

const workspace = await Bun.file(new URL("../src/components/workspace/Workspace.tsx", import.meta.url)).text();
const portal = await Bun.file(new URL("../src/components/Portal.tsx", import.meta.url)).text();
const bench = await Bun.file(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url)).text();

const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("who holds the board", () => {
  it("the place that came on screen last", async () => {
    const h = await load();
    expect(h.pickHolder([
      { id: "rail", visible: true, seen: 1 },
      { id: "bench", visible: true, seen: 2 },
    ], "rail")).toBe("bench");
  });

  it("a place going off screen keeps it, so flicking bench tabs moves nothing", async () => {
    const h = await load();
    expect(h.pickHolder([
      { id: "rail", visible: false, seen: 1 },
      { id: "bench", visible: false, seen: 2 },
    ], "rail")).toBe("rail");
  });

  it("falls back to a place that still exists when the holder is gone", async () => {
    const h = await load();
    expect(h.pickHolder([{ id: "rail", visible: false, seen: 1 }], "bench")).toBe("rail");
    expect(h.pickHolder([], "bench")).toBeNull();
  });
});

describe("the claims, end to end", () => {
  it("the view, then the bench, then the view again", async () => {
    const h = await load();
    const offRail = h.registerSlot("rail", "pr", "rail", noEl, true);
    expect(h.boardPlace("pr")).toBe("rail");
    expect(h.boardActive("pr")).toBe(true);

    // The bench opens on its pull-request tab over the view: it takes it.
    const offBench = h.registerSlot("bench", "pr", "bench", noEl, true);
    expect(h.boardPlace("pr")).toBe("bench");
    expect(h.benchWants("pr")).toBe(true);

    // "Show it here" in the view takes it back without closing the bench.
    h.claimSlot("rail");
    expect(h.boardPlace("pr")).toBe("rail");

    // Switching the bench to its tab again is a claim of its own.
    h.setSlotVisible("bench", false);
    h.setSlotVisible("bench", true);
    expect(h.boardPlace("pr")).toBe("bench");

    // Closing the bench hands it back to the view, which is on screen.
    offBench();
    expect(h.boardPlace("pr")).toBe("rail");
    expect(h.boardActive("pr")).toBe(true);
    expect(h.benchWants("pr")).toBe(false);
    offRail();
    expect(h.boardHolder("pr")).toBeNull();
  });

  it("is not active while the place holding it is off screen", async () => {
    const h = await load();
    h.registerSlot("rail", "tasks", "rail", noEl, false);
    expect(h.boardHolder("tasks")).toBe("rail");
    expect(h.boardActive("tasks")).toBe(false);
  });

  it("the two boards do not claim each other's places", async () => {
    const h = await load();
    h.registerSlot("rail-pr", "pr", "rail", noEl, true);
    h.registerSlot("bench-tasks", "tasks", "bench", noEl, true);
    expect(h.boardHolder("pr")).toBe("rail-pr");
    expect(h.boardHolder("tasks")).toBe("bench-tasks");
  });
});

describe("the board is rendered once", () => {
  it("each panel appears in exactly one JSX element in the workspace", () => {
    // A second `<PrView` anywhere in here is the second copy coming back.
    expect(code(workspace).match(/<PrView\b/g)).toHaveLength(1);
    expect(code(workspace).match(/<TasksView\b/g)).toHaveLength(1);
  });

  it("the view's own box holds a place, not the panel", () => {
    expect(workspace).toContain('case "pr": return <BoardSlot kind="pr" place="rail" visible={active} />;');
    expect(workspace).toContain('case "tasks": return <BoardSlot kind="tasks" place="rail" visible={active} />;');
    expect(bench).toContain('return <BoardSlot kind={tab.kind} place="bench" visible={active} />;');
  });
});

describe("a board looks the same in both places", () => {
  it("its place paints the ground the board was built on", async () => {
    // Sticky row cells are opaque --bg; on the bench's --bg2 each task row
    // showed a darker box behind its title.
    const slot = await Bun.file(new URL("../src/components/workspace/BoardSlot.tsx", import.meta.url)).text();
    expect(slot).toContain('style={{ background: "var(--bg)" }}');
    expect(await Bun.file(new URL("../src/index.css", import.meta.url)).text()).toMatch(/\.agx-stick \{[^}]*background: var\(--bg\)/);
  });
});

describe("what a board opens, while it is in the bench", () => {
  it("sits above the bench and below the palette", () => {
    expect(LAYER.benchOverlay).toBeGreaterThan(LAYER.bench);
    expect(LAYER.benchOverlay).toBeLessThan(LAYER.palette);
  });

  it("every portal takes the floor its host sets", () => {
    expect(portal).toContain("const floor = useContext(PortalFloor);");
    expect(portal).toContain("const layer = z < 0 ? z : Math.max(z, floor);");
    expect(workspace).toContain("<PortalFloor.Provider value={inBench ? LAYER.benchOverlay : 0}>");
  });
});

describe("the bench's zoom over a board", () => {
  it("asks the DOM whether the pointer and the focus are inside", () => {
    // React routes enter/leave and focus/blur along its own tree, and the
    // board's tree is the workspace's — as JSX handlers, the pointer moving
    // onto a board read as leaving the bench.
    const window = code(bench);
    expect(window).not.toContain("onPointerEnter={take}");
    expect(window).not.toContain("onFocusCapture={take}");
    expect(window).toContain('el.addEventListener("pointerenter", take);');
    expect(window).toContain('el.addEventListener("focusin", take);');
  });
});
