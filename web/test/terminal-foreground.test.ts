// A one-click command must not be typed into vim (#4).
//
// The panel injects `cmd + "\r"` into the live shell, which is right at a
// prompt and wrong while a full-screen program owns the screen: the keystrokes
// land in the editor. The tell is the alternate screen buffer, which every such
// program switches to on entry and away from on exit.
import { describe, expect, test } from "bun:test";
import { typingWouldLandInApp } from "../src/lib/termForeground.ts";

describe("what counts as a full-screen program", () => {
  test("the alternate buffer is one: vim, htop, lazygit, less", () => {
    expect(typingWouldLandInApp({ type: "alternate" })).toBe(true);
  });

  test("the normal buffer is a prompt, or something that shares stdin with one", () => {
    expect(typingWouldLandInApp({ type: "normal" })).toBe(false);
  });

  test("no terminal yet is not a full-screen program", () => {
    // A shell that has not connected still accepts a command: it queues, and
    // runs when the socket comes up. Refusing there would break the ordinary
    // path of clicking a chip on a cold panel.
    expect(typingWouldLandInApp(undefined)).toBe(false);
    expect(typingWouldLandInApp(null)).toBe(false);
    expect(typingWouldLandInApp({})).toBe(false);
  });
});
