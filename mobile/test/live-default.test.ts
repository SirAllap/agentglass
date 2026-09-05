/*
 * The default is applied once per pane, and never again.
 *
 * The failure this guards is not a crash. It is a mode that "keeps changing
 * back": somebody turns direct input off, the tab list refreshes a second
 * later — which it does constantly, on every poll and every open — and the
 * default puts it back. Nothing is logged, nothing throws, and the toggle gets
 * the blame.
 *
 * The merge is the whole of the difficulty and the screen cannot be rendered
 * on a machine with no phone, so it is checked here instead.
 */
import { describe, expect, test } from "bun:test";
import {
  applyDefault, isLive, NO_MODES, prune, setLive, type LiveModes,
} from "../src/terminal/liveDefault.ts";

const ids = (s: ReadonlySet<string>): string[] => [...s].sort();

describe("the one-shot default", () => {
  test("a pane nobody has seen starts typing straight through", () => {
    const after = applyDefault(NO_MODES, ["%1"]);
    expect(isLive(after, "%1")).toBe(true);
    expect(ids(after.defaulted)).toEqual(["%1"]);
  });

  test("turning it off sticks, even though the pane is still listed", () => {
    /* The bug in one test. The pane is still in every tab snapshot after this,
       so the default runs again — and must do nothing. */
    let state = applyDefault(NO_MODES, ["%1"]);
    state = setLive(state, "%1", false);
    state = applyDefault(state, ["%1"]);
    expect(isLive(state, "%1")).toBe(false);
  });

  test("and it stays off across many refreshes, not just the next one", () => {
    let state = setLive(applyDefault(NO_MODES, ["%1"]), "%1", false);
    for (let i = 0; i < 20; i++) state = applyDefault(state, ["%1"]);
    expect(isLive(state, "%1")).toBe(false);
  });

  test("a pane discovered later still gets the default", () => {
    // The one-shot is per pane, not per app. Opening a second tab must not
    // inherit the first tab's answer.
    let state = setLive(applyDefault(NO_MODES, ["%1"]), "%1", false);
    state = applyDefault(state, ["%1", "%2"]);
    expect(isLive(state, "%1")).toBe(false);
    expect(isLive(state, "%2")).toBe(true);
  });

  test("turning it ON by hand also counts as answered", () => {
    /* Harmless today, because the default is on. It stops being harmless the
       day the default flips, and this is the assertion that would notice. */
    const state = setLive(NO_MODES, "%9", true);
    expect(ids(state.defaulted)).toEqual(["%9"]);
  });

  test("nothing new means the same object, so no render", () => {
    const first = applyDefault(NO_MODES, ["%1"]);
    expect(applyDefault(first, ["%1"])).toBe(first);
  });

  test("an empty list changes nothing", () => {
    expect(applyDefault(NO_MODES, [])).toBe(NO_MODES);
  });

  test("a pane with no id is not a pane", () => {
    const state = applyDefault(NO_MODES, [""]);
    expect(state).toBe(NO_MODES);
    expect(setLive(NO_MODES, "", true)).toBe(NO_MODES);
  });

  test("no pane open is not live", () => {
    // The safe answer: line mode cannot send what nobody pressed Return on.
    const state = applyDefault(NO_MODES, ["%1"]);
    expect(isLive(state, null)).toBe(false);
    expect(isLive(state, undefined)).toBe(false);
  });
});

describe("forgetting closed panes", () => {
  test("a pane that is gone is dropped from both sets", () => {
    let state = applyDefault(NO_MODES, ["%1", "%2"]);
    state = prune(state, ["%2"]);
    expect(ids(state.live)).toEqual(["%2"]);
    expect(ids(state.defaulted)).toEqual(["%2"]);
  });

  test("a pane that is still there keeps the answer it was given", () => {
    let state = setLive(applyDefault(NO_MODES, ["%1", "%2"]), "%1", false);
    state = prune(state, ["%1", "%2"]);
    expect(isLive(state, "%1")).toBe(false);
    expect(isLive(state, "%2")).toBe(true);
  });

  test("dropping and re-seeing a pane defaults it again, which is why the caller must not prune from a lagging list", () => {
    /* Stated as a test because it is the trap: prune from a snapshot that has
       not caught up and the mode comes back as if the pane were new. The rule
       is that only the authoritative list may prune, and this is what the rule
       is protecting. */
    let state = setLive(applyDefault(NO_MODES, ["%1"]), "%1", false);
    state = prune(state, []);
    state = applyDefault(state, ["%1"]);
    expect(isLive(state, "%1")).toBe(true);
  });

  test("nothing to forget means the same object", () => {
    const state = applyDefault(NO_MODES, ["%1"]);
    expect(prune(state, ["%1"])).toBe(state);
  });

  test("the input sets are not mutated underneath the caller", () => {
    const before: LiveModes = applyDefault(NO_MODES, ["%1", "%2"]);
    prune(before, ["%1"]);
    setLive(before, "%1", false);
    expect(ids(before.live)).toEqual(["%1", "%2"]);
  });
});
