/*
 * The letterbox between a pull request and the terminal's socket.
 *
 * Everything here is about one failure: a frame that opens a window on
 * somebody's computer being delivered twice. There is no undo for that — the
 * window exists, an agent is running in it, and the second one looks exactly
 * like the first.
 *
 * The two orders that produce it are both real. Press the button with the
 * terminal already attached and the request lands after the socket exists;
 * press it having never opened that tab and the socket comes up second. The
 * terminal listens for both, so the slot has to be what guarantees one
 * delivery — which is why taking is destructive rather than peeking.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearHandoff, onHandoff, pendingHandoff, requestHandoff, takeHandoff, type Handoff,
} from "../src/terminal/handoff.ts";

const review = (number: number, recipe = "understand"): Handoff => ({
  t: "tmux", cmd: "review", number, root: "/home/me/code/app", recipe,
});

const issue = (cwd: string): Handoff => ({
  t: "tmux", cmd: "issue", cwd, name: "i219", prompt: "fix the prefix key", agent: true,
});

// A slot is module state, so a test that left something in it would hand it to
// the next one — which is the exact bug this module exists to prevent, in the
// test file for it.
afterEach(() => { clearHandoff(); });

describe("the slot", () => {
  test("it starts empty and taking an empty one is not an error", () => {
    expect(pendingHandoff()).toBeNull();
    expect(takeHandoff()).toBeNull();
  });

  test("what goes in comes out", () => {
    requestHandoff(review(482));
    expect(takeHandoff()).toEqual(review(482));
  });

  test("taking it empties it — the whole delivery guarantee", () => {
    requestHandoff(review(482));
    expect(takeHandoff()).not.toBeNull();
    // The terminal has two paths that both call take. The second must find
    // nothing, or a double tap becomes two windows.
    expect(takeHandoff()).toBeNull();
  });

  test("peeking does not", () => {
    // A screen may want to say "one is waiting" without consuming it.
    requestHandoff(review(482));
    expect(pendingHandoff()).toEqual(review(482));
    expect(pendingHandoff()).toEqual(review(482));
    expect(takeHandoff()).toEqual(review(482));
  });

  test("the last request wins and the first is dropped", () => {
    // Deliberately not a queue: two frames in flight is two windows opening on
    // another computer from one trip to the phone, and the second is never the
    // one that was wanted.
    requestHandoff(review(482));
    requestHandoff(review(14101, "unblock"));
    expect(takeHandoff()).toEqual(review(14101, "unblock"));
    expect(takeHandoff()).toBeNull();
  });

  test("it carries either shape", () => {
    requestHandoff(issue("/home/me/code/app"));
    const taken = takeHandoff();
    expect(taken?.cmd).toBe("issue");
    expect(taken).toEqual(issue("/home/me/code/app"));
  });
});

describe("being told", () => {
  test("a listener hears an arrival", () => {
    let heard = 0;
    onHandoff(() => { heard += 1; });
    requestHandoff(review(482));
    expect(heard).toBe(1);
  });

  test("it hears every arrival, including one that replaces another", () => {
    let heard = 0;
    onHandoff(() => { heard += 1; });
    requestHandoff(review(482));
    requestHandoff(review(14101));
    expect(heard).toBe(2);
  });

  test("the slot is already full when the listener runs", () => {
    // The terminal's listener takes it immediately, so an event that fired
    // before the value landed would deliver nothing at all.
    //
    // Collected into an array rather than a `let`: the assignment happens
    // inside a callback, which TypeScript's control flow cannot follow, so it
    // holds the variable at its initial `null` and the comparison below stops
    // compiling.
    const seen: (Handoff | null)[] = [];
    onHandoff(() => { seen.push(takeHandoff()); });
    requestHandoff(review(482));
    expect(seen).toEqual([review(482)]);
  });

  test("unsubscribing stops it", () => {
    let heard = 0;
    const off = onHandoff(() => { heard += 1; });
    off();
    requestHandoff(review(482));
    expect(heard).toBe(0);
  });

  test("a listener that unsubscribes during the call does not break the rest", () => {
    // `useFocusEffect` tears its subscription down while events may be in
    // flight, so the set is iterated over a copy. Without that this throws.
    const heard: string[] = [];
    let off2 = (): void => {};
    onHandoff(() => { heard.push("one"); off2(); });
    off2 = onHandoff(() => { heard.push("two"); });
    expect(() => requestHandoff(review(482))).not.toThrow();
    expect(heard).toContain("one");
  });

  test("taking in one listener leaves nothing for the next", () => {
    // Both of the terminal's paths may be live at once. Whichever runs first
    // delivers, and the other finds an empty slot — one window, not two.
    const got: (Handoff | null)[] = [];
    onHandoff(() => { got.push(takeHandoff()); });
    onHandoff(() => { got.push(takeHandoff()); });
    requestHandoff(review(482));
    expect(got.filter(Boolean)).toHaveLength(1);
  });
});
