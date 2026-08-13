/*
 * Where "find on this screen" points, which is the whole of this feature.
 *
 * The searching itself is `mdFind`, already pinned down next door. What is new
 * — and what would break silently — is the answer to WHERE: the workspace keeps
 * every visited view mounted and merely hides the inactive ones, and thirty
 * components render through a portal into `document.body`. Get the scope wrong
 * and the bar counts matches in a view nobody is looking at, which is the exact
 * failure it was built to end.
 *
 * No DOM in this runner, so the scopes are stand-ins and the engine is a fake.
 * That is not a compromise here: the stack and the state machine ARE the logic,
 * and the DOM walk is tested by the suite next to it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  closeFind, findChordIsOursToTake, findState, openFind, pushScope,
  registerEngine, runQuery, stepFind, topScope, type FindEngine,
} from "../src/lib/findScope.ts";

/* A stand-in for an element that is on screen: something in it, and a box.
   Both matter — see the empty-portal case below. */
const el = (name: string, showing = true) => ({
  name,
  childElementCount: showing ? 1 : 0,
  checkVisibility: () => showing,
} as unknown as HTMLElement);

/** An engine that answers with a fixed number of matches and remembers what it
 *  was told to do. */
function fake(total: number, label?: string) {
  const calls: string[] = [];
  let at = total ? 1 : 0;
  const engine: FindEngine = {
    search(q) { calls.push(`search:${q}`); at = total ? 1 : 0; return total; },
    step(dir) { calls.push(`step:${dir}`); at = total ? ((at - 1 + dir + total) % total) + 1 : 0; },
    clear() { calls.push("clear"); at = 0; },
    at: () => at,
    ...(label ? { label } : {}),
  };
  return { engine, calls };
}

const offs: (() => void)[] = [];
const keep = (off: () => void) => { offs.push(off); return off; };
afterEach(() => { closeFind(); while (offs.length) offs.pop()!(); });

describe("which element the bar searches", () => {
  it("is the view when only a view is open", () => {
    const view = el("view");
    keep(pushScope(view, 0));
    expect(topScope()).toBe(view);
  });

  it("is the dialog when one is open over it — whatever order they mounted in", () => {
    /* Effects run in mount order, and a card can mount before or after the
       view it covers depending on how it was opened. Rank decides, not
       arrival. */
    const card = el("card");
    keep(pushScope(card, 1));
    keep(pushScope(el("view"), 0));
    expect(topScope()).toBe(card);
  });

  it("goes back to the view when the dialog closes", () => {
    const view = el("view");
    keep(pushScope(view, 0));
    const offCard = pushScope(el("card"), 1);
    offCard();
    expect(topScope()).toBe(view);
  });

  it("is nothing at all before anything has mounted", () => {
    expect(topScope()).toBeNull();
  });

  it("ignores a dialog that is mounted but empty", () => {
    /*
     * The bug this rule exists for, found in the running app: `Portal` creates
     * its host div when the component MOUNTS, and the dialogs that use one live
     * for the life of the app with their contents behind an `open &&`. Five
     * empty hosts sat on the stack at rank 1, all of them beating the view, and
     * every search answered 0 of 0 over a screen full of the word.
     */
    const view = el("view");
    keep(pushScope(view, 0));
    keep(pushScope(el("closed dialog", false), 1));
    expect(topScope()).toBe(view);
  });

  it("ignores a scope whose box is hidden, even if it has children", () => {
    const view = el("view");
    keep(pushScope(view, 0));
    const hidden = { name: "hidden", childElementCount: 3, checkVisibility: () => false } as unknown as HTMLElement;
    keep(pushScope(hidden, 1));
    expect(topScope()).toBe(view);
  });
});

describe("the bar's state machine", () => {
  it("counts what the engine found and starts on the first match", () => {
    const { engine, calls } = fake(3);
    keep(registerEngine(() => engine));
    openFind("risk");
    expect(calls).toEqual(["search:risk"]);
    expect(findState()).toMatchObject({ open: true, query: "risk", total: 3, at: 1 });
  });

  it("wraps at both ends, so holding Enter walks the screen", () => {
    const { engine } = fake(2);
    keep(registerEngine(() => engine));
    openFind("a");
    stepFind(1); expect(findState().at).toBe(2);
    stepFind(1); expect(findState().at).toBe(1);
    stepFind(-1); expect(findState().at).toBe(2);
  });

  it("says 0 of 0 rather than pretending, and does not step", () => {
    const { engine, calls } = fake(0);
    keep(registerEngine(() => engine));
    openFind("nothing here");
    expect(findState()).toMatchObject({ total: 0, at: 0 });
    stepFind(1);
    expect(calls.filter((c) => c.startsWith("step"))).toEqual([]);
  });

  it("takes its highlights down on close", () => {
    // A highlight registry is global: a bar that forgot would leave its marks
    // on the next screen.
    const { engine, calls } = fake(2);
    keep(registerEngine(() => engine));
    openFind("a");
    closeFind();
    expect(calls).toContain("clear");
    expect(findState().open).toBe(false);
  });

  it("clears the engine when the query is emptied, without closing", () => {
    const { engine, calls } = fake(2);
    keep(registerEngine(() => engine));
    openFind("a");
    runQuery("");
    expect(calls).toContain("clear");
    expect(findState()).toMatchObject({ open: true, total: 0 });
  });

  it("ignores typing when the bar is shut", () => {
    const { engine, calls } = fake(2);
    keep(registerEngine(() => engine));
    runQuery("risk");
    expect(calls).toEqual([]);
    expect(findState().open).toBe(false);
  });
});

describe("a view that searches something other than the page", () => {
  it("is used instead of the DOM, and names itself on the bar", () => {
    const { engine } = fake(4, "terminal");
    keep(registerEngine(() => engine));
    openFind("boot");
    expect(findState()).toMatchObject({ total: 4, label: "terminal" });
  });

  it("stands down by answering null, and the one under it takes over", () => {
    const outer = fake(1, "outer");
    const inner = fake(7, "inner");
    keep(registerEngine(() => outer.engine));
    keep(registerEngine(() => (null as FindEngine | null)));
    keep(registerEngine(() => inner.engine));
    openFind("x");
    expect(findState()).toMatchObject({ total: 7, label: "inner" });
  });

  it("holds the engine while the screen holds still", () => {
    /* Focus moves while you read — clicking a match, scrolling a pane. If the
       engine were resolved per keystroke, Enter could step through a different
       thing from the one being counted. */
    const first = fake(3, "first");
    let live: FindEngine | null = first.engine;
    keep(registerEngine(() => live));
    keep(pushScope(el("view"), 0));
    openFind("a");
    live = fake(9, "second").engine;
    stepFind(1);
    expect(findState()).toMatchObject({ total: 3, label: "first" });
  });

  it("follows the screen when the screen changes, and answers about the new one", () => {
    /*
     * Reported: open the bar on a pull request, walk to the board with it open,
     * and it went on counting the pull request — 1/5 over a screen with none of
     * them, and typing again answered 0/0 because the ranges it held belonged
     * to a view nobody was looking at. Holding the engine was right; holding it
     * across a change of scope was not.
     */
    const pr = fake(5, "pr");
    const board = fake(12, "board");
    let which = pr.engine;
    keep(registerEngine(() => which));
    const offPr = pushScope(el("pr view"), 0);
    openFind("VR");
    expect(findState()).toMatchObject({ total: 5, label: "pr" });

    which = board.engine;
    offPr();
    keep(pushScope(el("board view"), 0));
    expect(findState()).toMatchObject({ total: 12, label: "board" });
    // And the one it left is put away rather than left painted on the document.
    expect(pr.calls).toContain("clear");
  });
});

describe("the chord this app is allowed to take", () => {
  const target = (sel: string | null) => ({ closest: (q: string) => (sel && q.includes(sel.slice(1)) ? {} : null) } as unknown as EventTarget);

  it("is ours over ordinary content", () => {
    expect(findChordIsOursToTake(target(null))).toBe(true);
    expect(findChordIsOursToTake(null)).toBe(true);
  });

  it("is NOT ours inside a terminal — Ctrl+F is readline's forward-char", () => {
    expect(findChordIsOursToTake(target(".xterm"))).toBe(false);
  });

  it("is NOT ours inside the browser's webview — Chromium's find lives there", () => {
    expect(findChordIsOursToTake(target("webview"))).toBe(false);
  });
});
