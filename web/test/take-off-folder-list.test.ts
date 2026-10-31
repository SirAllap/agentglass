/*
 * "Take off this bar" on a list that comes with a folder removed nothing (the
 * list is not stored on the bar) yet toasted "off this bar". Only the folder
 * can leave, so the item is not offered for such a list. Read as source.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("Take off this bar", () => {
  it("is not offered for a list that belongs to a folder", () => {
    const i = src.indexOf("Take off this bar</MenuItem>");
    expect(i).not.toBe(-1);
    expect(src.slice(src.lastIndexOf("{!menu.v.builtin", i), i)).toContain("!menu.v.folderId");
  });
});
