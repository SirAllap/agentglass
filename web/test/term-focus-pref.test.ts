// Focus follows mouse: the switch, and the four ways a hover is not a hover.
//
// The guards are the feature. Focus that moves on its own is either the best
// thing in the terminal or unusable, and which one it is comes down entirely to
// whether it fires when you did not mean it — mid-drag, mid-typing, or on a
// pane nobody is looking at.
import { describe, expect, it, beforeEach } from "bun:test";
import {
  focusFollowsMouse, setFocusFollowsMouse, subscribeFocusFollowsMouse, shouldFocusOnHover,
} from "../src/lib/termFocusPref.ts";

/** A hover that should be honoured, so each test can spoil exactly one thing. */
const OK = { enabled: true, buttons: 0, typing: false, visible: true };

// bun's test environment has no DOM; the module only ever touches these three.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

beforeEach(() => store.clear());

describe("the switch", () => {
  it("is off until somebody asks", () => {
    // The default matters: this is the terminal habit people either keep for
    // life or cannot stand, and a machine that was never asked expects a click.
    expect(focusFollowsMouse()).toBe(false);
  });

  it("remembers being turned on, and turned off again", () => {
    setFocusFollowsMouse(true);
    expect(focusFollowsMouse()).toBe(true);
    setFocusFollowsMouse(false);
    expect(focusFollowsMouse()).toBe(false);
  });

  it("stores off as nothing at all", () => {
    // So the default can be revisited later without pinning every machine that
    // merely looked at the switch to the old one.
    setFocusFollowsMouse(true);
    setFocusFollowsMouse(false);
    expect(store.has("agentglass.term.focusFollowsMouse")).toBe(false);
  });

  it("tells the terminal, not just the settings page", () => {
    // Both surfaces read the same store; without this the switch would only
    // take effect on the next reload.
    let beats = 0;
    const off = subscribeFocusFollowsMouse(() => { beats++; });
    setFocusFollowsMouse(true);
    setFocusFollowsMouse(false);
    off();
    setFocusFollowsMouse(true);
    expect(beats).toBe(2);
  });
});

describe("when a hover takes the keyboard", () => {
  it("does, once it has been asked for", () => {
    expect(shouldFocusOnHover(OK)).toBe(true);
  });

  it("does nothing at all while the switch is off", () => {
    expect(shouldFocusOnHover({ ...OK, enabled: false })).toBe(false);
  });

  it("keeps out of a selection being dragged across a split", () => {
    // Entering the neighbouring pane with the button still down is a drag, not
    // a hover — and taking focus there re-mounts the pane, which loses it.
    expect(shouldFocusOnHover({ ...OK, buttons: 1 })).toBe(false);
    expect(shouldFocusOnHover({ ...OK, buttons: 2 })).toBe(false);
  });

  it("does not swallow what is being typed into a menu", () => {
    // The repo picker, the worktree picker and the find bar all borrow the
    // keyboard for an input of their own, and they sit over the panes.
    expect(shouldFocusOnHover({ ...OK, typing: true })).toBe(false);
  });

  it("will not focus a pane that is not on screen", () => {
    expect(shouldFocusOnHover({ ...OK, visible: false })).toBe(false);
  });
});
