/*
 * The four places the find bar touches the app, asserted on the source.
 *
 * These are not style checks. Each one is a rule that, broken, produces a bug
 * nobody would trace back here: two find bars opening at once, a search that
 * counts text in a view you cannot see, or a chord stolen from the program
 * running in a terminal. There is no DOM in this runner, so the source is where
 * they can be held — the same shape the rail's suite uses next door.
 */
import { describe, expect, it } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const [app, workspace, portal, pr, mdfind, scope] = await Promise.all([
  read("App.tsx"), read("components/workspace/Workspace.tsx"), read("components/Portal.tsx"),
  read("components/PrPanel.tsx"), read("lib/mdFind.ts"), read("lib/findScope.ts"),
]);

describe("the shell's chord", () => {
  it("declines the two places it does not own", () => {
    // A terminal's keys belong to the program inside it, and a webview has
    // Chromium's own find. Both were decided before this feature existed.
    expect(app).toContain("findChordIsOursToTake(e.target)");
    expect(scope).toContain('el.closest(".xterm, webview")');
  });

  it("takes the key from the browser's own find when it does open", () => {
    /* Served in a tab, the page's find would open on top of ours — over a
       document that holds every mounted view, which is the search this
       replaces. */
    const at = app.indexOf("findChordIsOursToTake(e.target)");
    expect(app.slice(at, at + 200)).toContain("e.preventDefault()");
  });
});

describe("what a search is pointed at", () => {
  it("is the view that is actually on screen", () => {
    // Every visited view stays mounted, hidden with `visibility`. Searching the
    // document would walk all of them.
    expect(workspace).toContain("pushScope(box.current, 0)");
    expect(workspace).toContain('style={{ visibility: active ? "visible" : "hidden" }}');
  });

  it("lets a surface that opens over one take over, and only if it says so", () => {
    /* Opt-in: a context menu, a toast and a tooltip all render through the same
       Portal, and a bar that searched the open menu would be worse than one
       that searched the view behind it. */
    expect(portal).toContain("find?: boolean | number");
    expect(portal).toContain("pushScope(el, typeof find === \"number\" ? find : 1)");
  });
});

describe("the diff's own find, which stays", () => {
  it("only answers while its tab is the thing on screen", () => {
    // It listened on `window` with no such test, so leaving the Files tab open
    // and walking to the board put its bar on a view you could not see.
    const at = pr.indexOf("const onWinKey = (e: KeyboardEvent) => {");
    const body = pr.slice(at, at + 1200);
    expect(body).toContain("checkVisibility");
    expect(body).toContain("frameRef.current");
  });

  it("gets first refusal on the chord, and stops it when it acts", () => {
    /* Both listen on the same window. Capture runs first, so this one decides;
       stopping there is what keeps two bars from opening on one keypress. */
    const at = pr.indexOf("const onWinKey = (e: KeyboardEvent) => {");
    expect(pr.slice(at, at + 1500)).toContain("e.stopPropagation()");
    expect(pr).toContain('window.addEventListener("keydown", onWinKey, true)');
  });
});

describe("the walker", () => {
  it("refuses text nobody can see", () => {
    /* A screen is full of text that is not on it: closed menus, aria-hidden
       blocks, and xterm's accessibility mirror of the whole buffer. Counting
       those sends you to matches you cannot find. */
    expect(mdfind).toContain("acceptNode:");
    expect(mdfind).toContain("checkVisibility");
    expect(mdfind).toContain(".xterm, [aria-hidden='true'], [hidden]");
  });

  it("still finds a match that is merely scrolled away", () => {
    // The visibility test must not become a viewport test — scrolling to a
    // match is the whole point of the bar.
    expect(mdfind).not.toContain("getBoundingClientRect().top > 0");
    expect(mdfind).toContain("Deliberately NOT `getBoundingClientRect`");
  });
});
