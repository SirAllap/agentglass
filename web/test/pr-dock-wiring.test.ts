import { describe, expect, test } from "bun:test";

/* The decisions are in pr-dock.test.ts; this holds the screen to them (there is no renderer here, so a rule about source is asserted against source). */
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const kit = await Bun.file(new URL("../src/components/workspace/Chrome.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const p = code(panel);

describe("the detail beside the board", () => {
  test("the list stays drawn while the detail is docked, and is replaced only by full screen", () => {
    expect(p).toContain("{layout.list && (");
    expect(p).toContain('{layout.detail !== "none" && (');
    expect(p).not.toMatch(/\{selected == null \? \(\s*<div className="flex flex-col min-h-0 flex-1 min-w-0">/);
  });
  test("docked it is a column of the chosen width (620 unless dragged) with a hairline and the lift, full screen it takes the rest", () => {
    expect(p).toContain('layout.detail === "full" ? "flex-1" : "flex-none"');
    expect(p).toContain("flexBasis: dockLive.current ?? dockPx ?? DOCK_PX");
    expect(p).toContain("borderLeft: LINE");
  });
  test("the one top bar, the deck and the views belong to every layout but full screen", () => {
    expect(p).toContain("{layout.listBar && repo && bar === \"board\"");
    expect(p).toContain("{!layout.listBar && (");
  });
  test("the click docks, the double-click and the header button maximize, the same button restores", () => {
    expect(board).toContain('onOpen(p.number, undefined, "dblclick")');
    expect(p).toContain("toggleMaximized(dockState, panelPx)");
    expect(p).toContain('title="Full screen (double-click a card)"');
    expect(p).toContain('title="Back to the side dock"');
    expect(p).toContain("<Masthead dockControls={dockControls}");
  });
  test("a detail that has not loaded still has its controls", () => {
    expect(p).toContain("{!d && <div className=\"flex justify-end px-3 pt-2\">{dockControls}</div>}");
  });
  test("Esc walks the ladder through the pure step and leaves menus, dialogs and fields their own", () => {
    const at = p.indexOf(`if (e.key !== "Escape" || e.defaultPrevented) return;`);
    expect(at).toBeGreaterThan(-1);
    const effect = p.slice(at, p.indexOf("window.removeEventListener(\"keydown\", onKey)", at));
    expect(effect).toContain("e.defaultPrevented");
    expect(effect).toContain('[role="dialog"], [role="menu"]');
    expect(effect).toContain('step === "clear-search"');
    expect(effect).toContain("afterEsc(");
  });
  test("what is chosen is not kept between visits", () => {
    expect(p).not.toMatch(/localStorage[^\n]*maximi[sz]ed|maximi[sz]ed[^\n]*localStorage/i);
  });
  test("the board writes its last scroll when it leaves the screen inside the debounce", () => {
    const at = board.indexOf("Leaving the board (full screen)");
    expect(at).toBeGreaterThan(-1);
    expect(board.slice(at, at + 400)).toContain("setBoardScroll(scrollKey, latest.current)");
  });
  test("Refresh with the board beside the detail reads both, keeping the other rows' caches", () => {
    expect(p).toContain("if (!plan.list) { settled(); return; }");
    expect(p).toContain("} else forgetBehind();");
  });
});

describe("the kit's icon button", () => {
  test("can name itself apart from its tooltip", () => {
    expect(kit).toContain("aria-label={label ?? title}");
  });
});
