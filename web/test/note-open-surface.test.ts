// A notification's "Open PR" / "Open card" follows the terminal's
// "Open PR and card links on the bench" setting; anything else goes to its view.
import { describe, expect, test } from "bun:test";
import { noteSurface } from "../src/lib/linkRouter.ts";

describe("noteSurface", () => {
  test("a pull request opens on the bench only with the setting on", () => {
    expect(noteSurface("pr", true)).toBe("bench");
    expect(noteSurface("pr", false)).toBe("view");
  });
  test("a card follows the same setting", () => {
    expect(noteSurface("card", true)).toBe("bench");
    expect(noteSurface("card", false)).toBe("view");
  });
  test("a pane, Git, Settings or a file never goes to the bench", () => {
    for (const k of ["pane", "git", "settings", "file"]) expect(noteSurface(k, true)).toBe("view");
  });
});
