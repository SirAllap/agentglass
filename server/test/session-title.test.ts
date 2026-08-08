/*
 * The card title that becomes the agent session's name.
 *
 * It is the one value on this socket that comes from ClickUp — a person typed
 * it into a browser, and whatever they typed is what arrives. It ends up as an
 * element of an argv array (never through a shell) and then in a terminal
 * title and a session picker, so the job here is narrow and worth pinning: no
 * control characters, no unbounded length, and an empty answer for anything
 * that is not a usable name — because the caller's rule is "no title, no flag",
 * and `--name ""` is not the same thing as no flag.
 */
import { describe, expect, test } from "bun:test";
import { sessionTitle } from "../src/terminal.ts";

describe("a card title as a session name", () => {
  test("passes an ordinary one through", () => {
    expect(sessionTitle("GC7 - Guest checkout receipt email + resend endpoint"))
      .toBe("GC7 - Guest checkout receipt email + resend endpoint");
  });

  test("flattens what a card title can actually contain", () => {
    // ClickUp titles are typed into a rich editor and paste in from anywhere.
    expect(sessionTitle("Fix   the\tvalidator")).toBe("Fix the validator");
    expect(sessionTitle("  Two lines\nin one title  ")).toBe("Two lines in one title");
  });

  test("strips control characters rather than escaping them", () => {
    /*
     * The one that matters. An escape sequence in an argv element is how a
     * "title" repaints a status line or moves a cursor once the CLI prints it.
     * Removed, not quoted: there is no version of a card title that needs one.
     */
    const out = sessionTitle("Card \u001b[31mred\u001b[0m and \u0007bell");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    // A control becomes a space rather than nothing, so removing one cannot
    // weld two words together. What is left is inert text.
    expect(out).toBe("Card [31mred [0m and bell");
  });

  test("caps a long one, visibly", () => {
    const out = sessionTitle("x".repeat(200));
    expect(out.length).toBeLessThanOrEqual(72);
    // Ends in an ellipsis, so a truncated name reads as truncated rather than
    // as a card whose title happens to stop mid-word.
    expect(out.endsWith("…")).toBe(true);
  });

  test("answers empty for anything that is not a name", () => {
    // The caller passes no flag at all on an empty answer, which is why this
    // must never return a string of spaces.
    for (const bad of ["", "   ", "\n\t ", undefined, null, 42, {}]) {
      expect(sessionTitle(bad), JSON.stringify(bad)).toBe("");
    }
  });
});
