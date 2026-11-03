/*
 * The server's note that it asked a container to stop.
 *
 * `Exited (143)` and `Exited (137)` are the signals docker itself sends on a
 * stop, and the same codes are what a container killed from anywhere else
 * looks like. So the note is what lets the row tell "we stopped this" from "it
 * died", and it has a shelf life: an old note, or one belonging to a container
 * that has since been started again, must not excuse a fresh crash.
 */
import { describe, expect, test } from "bun:test";
import { forgetStopAsked, noteStopAsked, STOP_ASKED_MS, stopAskedAt } from "../src/docker.ts";

describe("a stop of ours", () => {
  test("is remembered while it explains an exit", () => {
    noteStopAsked("aaaaaaaaaaaa", 1_000);
    expect(stopAskedAt("aaaaaaaaaaaa", 1_500)).toBe(1_000);
    expect(stopAskedAt("aaaaaaaaaaaa", 1_000 + STOP_ASKED_MS)).toBe(1_000);
  });

  test("stops explaining once the window has passed, and is forgotten", () => {
    noteStopAsked("bbbbbbbbbbbb", 1_000);
    expect(stopAskedAt("bbbbbbbbbbbb", 1_000 + STOP_ASKED_MS + 1)).toBeNull();
    expect(stopAskedAt("bbbbbbbbbbbb", 1_100)).toBeNull();          // not resurrected by a later read
  });

  test("a container asked for something else is no longer explained", () => {
    noteStopAsked("cccccccccccc", 1_000);
    forgetStopAsked("cccccccccccc");
    expect(stopAskedAt("cccccccccccc", 1_100)).toBeNull();
  });

  test("a clock that went backwards is not a reason to explain an exit", () => {
    noteStopAsked("dddddddddddd", 2_000);
    expect(stopAskedAt("dddddddddddd", 1_000)).toBeNull();
  });

  test("a container we never asked is null, not now", () => {
    expect(stopAskedAt("eeeeeeeeeeee")).toBeNull();
  });
});
