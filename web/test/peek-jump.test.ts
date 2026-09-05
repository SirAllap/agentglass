/*
 * What the rail sends the editor when you pick a place.
 *
 * The keys ARE the feature — there is no other channel to an editor running in
 * a terminal — so they are pinned here rather than left to be read off a
 * screenshot. Two of the three are what he asked for; the third is what he
 * asked to have taken back out.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/PeekFile.tsx", import.meta.url).pathname, "utf8");

describe("the jump", () => {
  test("escapes first, and clears whatever a previous jump left", () => {
    expect(src).toContain("\\u001b:call clearmatches()");
  });

  /* It painted them for one build. On a place of a hundred and thirty-five
     lines, `DiffChange` is a background: the screen went yellow and the syntax
     colours under it went away. The editor already marks where you are. */
  test("and paints nothing over the code", () => {
    expect(src).not.toContain("matchaddpos");
  });

  test("and puts the line at the top of the window", () => {
    expect(src).toContain("send(`\\u001b:call clearmatches()\\r:${at}\\rzt`)");
  });

  test("the rail asks for the place's first line", () => {
    expect(src).toContain("onGo(groups[n]!.from)");
  });
});

