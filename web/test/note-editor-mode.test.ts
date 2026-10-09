import { describe, expect, test } from "bun:test";
import { noteMode } from "../src/lib/termPrefs.ts";

describe("noteMode", () => {
  test("built-in is the default and never waits on the server", () => {
    expect(noteMode("builtin", null)).toEqual({ mode: "builtin", fellBack: false });
    expect(noteMode("builtin", true)).toEqual({ mode: "builtin", fellBack: false });
  });
  test("neovim holds the tab until the server has said whether nvim exists", () => {
    expect(noteMode("nvim", null).mode).toBe("wait");
  });
  test("neovim with nvim on the PATH runs it", () => {
    expect(noteMode("nvim", true)).toEqual({ mode: "nvim", fellBack: false });
  });
  test("neovim without nvim falls back to the textarea and says so", () => {
    expect(noteMode("nvim", false)).toEqual({ mode: "builtin", fellBack: true });
  });
});
