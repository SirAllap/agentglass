/*
 * The Jira rail's filter box only ever matched a saved board or filter's NAME, so typing a card's key or its bare
 * number ("851") said "Nothing matches" even for a real card. Enter now tries the same jump the palette's search
 * gives a bare number: `looksLikeCardId`, then `reveal`, whatever board the card is on.
 *
 * No renderer in this project for TasksPanel.tsx (web/test/tasks-rail-tree.test.ts says why): the wiring is asserted
 * against the source, the way that file already does for the rail.
 */
import { describe, expect, test } from "bun:test";
import { looksLikeCardId } from "../src/lib/boardGroups.ts";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("looksLikeCardId: a key or a bare number, not a name", () => {
  test("ORBIT-851 and a bare 851 both read as a card id; a board's plain name does not", () => {
    expect(looksLikeCardId("ORBIT-851", true, false)).toBe(true);
    expect(looksLikeCardId("851", true, false)).toBe(true);
    expect(looksLikeCardId("Sprint board", true, false)).toBe(false);
  });
});

describe("the rail's filter box", () => {
  test("Enter on a card key or number jumps to it with reveal, for Jira", () => {
    const at = src.indexOf("onKeyDown={(e) => {\n                    if (e.key === \"Escape\" && railQ)");
    expect(at, "the rail filter box's onKeyDown is gone or changed shape").toBeGreaterThan(-1);
    const block = src.slice(at, at + 900);
    expect(block).toContain('e.key === "Enter" && isJira && looksLikeCardId(railQ, true, source.shortKeys)');
    expect(block).toContain("void reveal(railQ)");
  });
});
