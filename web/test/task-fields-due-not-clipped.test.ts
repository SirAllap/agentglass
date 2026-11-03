/*
 * The Due value in a Local task's fields clipped "no date" to "no d…" when its box
 * was sized to the button around it less that button's negative margins. The date
 * is now a plain input of the house size inside a row that wraps its own words,
 * so the box owns its width and the words beside it truncate instead. Read as source.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("Local task fields: Due", () => {
  it("gives the date input a fixed width of its own, so the words beside it are what truncates", () => {
    const i = src.indexOf('aria-label="Due date"');
    expect(i).not.toBe(-1);
    const tag = src.slice(src.lastIndexOf("<input", i), src.indexOf("/>", i));
    expect(tag).toContain("w-[150px]");
    expect(src.slice(i, src.indexOf("</div>", i))).toContain("truncate");
  });
});
