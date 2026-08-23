/*
 * What reaches somebody's composer when they attach a picture.
 *
 * Every rule here fails quietly rather than loudly: a path pasted without its
 * brackets is forty keystrokes through a composer that opens a menu on one of
 * them, and a missing path is the string "undefined" typed into a prompt that
 * will then be sent to an agent.
 */
import { describe, expect, test } from "bun:test";
import { PASTE_OFF, PASTE_ON, fileFrom, pastePayload } from "../src/terminal/imagePaste.ts";

describe("the payload", () => {
  test("the path arrives inside bracketed paste", () => {
    const out = pastePayload("/tmp/agentglass-image-x/image.png");
    expect(out.startsWith(PASTE_ON)).toBe(true);
    expect(out.endsWith(PASTE_OFF)).toBe(true);
    expect(out).toContain("/tmp/agentglass-image-x/image.png");
  });

  test("the markers are the real escape sequences", () => {
    // Written as `` in the source so they are visible in a diff. If that
    // ever becomes a literal character again, this still holds — but if it
    // becomes the two ASCII letters "^[" it does not, which is the mistake
    // worth catching.
    expect(PASTE_ON.charCodeAt(0)).toBe(27);
    expect(PASTE_OFF.charCodeAt(0)).toBe(27);
  });

  test("a space follows the path, inside the brackets", () => {
    // The next thing typed is a sentence about the picture, and
    // `…image.png what is wrong here` is not what anybody meant.
    expect(pastePayload("/tmp/a/image.png")).toBe(`${PASTE_ON}/tmp/a/image.png ${PASTE_OFF}`);
  });

  test("there is no newline in it", () => {
    // The person sends when they mean to. A payload that submitted itself
    // would ask the agent a question nobody had finished writing.
    const out = pastePayload("/tmp/a/image.png");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
  });

  test("an empty path pastes nothing at all", () => {
    // Two markers with nothing between them render as a stray character in
    // some composers.
    expect(pastePayload("")).toBe("");
    expect(pastePayload("   ")).toBe("");
  });
});

describe("reading the server's answer", () => {
  test("a path comes back as a path", () => {
    expect(fileFrom({ ok: true, file: "/tmp/x/image.png" })).toEqual({ file: "/tmp/x/image.png" });
  });

  test("ok with no file is an error, not a paste", () => {
    // The failure this exists for: reading `ok` alone would put "undefined"
    // in the prompt, and the prompt would then be sent.
    expect("error" in fileFrom({ ok: true })).toBe(true);
  });

  test("ok with a blank file is the same", () => {
    expect("error" in fileFrom({ ok: true, file: "   " })).toBe(true);
  });

  test("the server's own words are kept when it refuses", () => {
    expect(fileFrom({ ok: false, error: "that image is over 8MB" }))
      .toEqual({ error: "that image is over 8MB" });
  });

  test("no answer at all says so", () => {
    expect("error" in fileFrom(null)).toBe(true);
    expect("error" in fileFrom(undefined)).toBe(true);
  });
});
