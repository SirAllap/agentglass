import { describe, expect, test } from "bun:test";
import { expandHome } from "../src/plugin-sources.ts";

// The install box takes a path pasted as the app shows it (`~/code/…`); it
// failed the git-URL check instead of resolving to the home folder.
describe("expandHome", () => {
  test("~/ becomes the home folder", () => {
    expect(expandHome("~/code/orbit-plugin", "/home/ana")).toBe("/home/ana/code/orbit-plugin");
  });
  test("a bare ~ is the home folder", () => {
    expect(expandHome("~", "/home/ana/")).toBe("/home/ana/");
  });
  test("absolute paths, git URLs and ~user are left alone", () => {
    expect(expandHome("/opt/orbit-plugin", "/home/ana")).toBe("/opt/orbit-plugin");
    expect(expandHome("git@github.com:acme/orbit.git", "/home/ana")).toBe("git@github.com:acme/orbit.git");
    expect(expandHome("~bob/orbit", "/home/ana")).toBe("~bob/orbit");
  });
});
