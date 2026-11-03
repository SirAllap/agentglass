import { describe, expect, test } from "bun:test";

/*
 * The 300 px list cut a file name to "us…" or to nothing beside badges, and a
 * section's branch to "m…" beside a long commit subject: every sibling shrank
 * at the same rate as the thing the row is for. There is no renderer in this
 * project, so the rule is asserted against source. These patterns guard the
 * class strings only; the measured width is checked in the bundle probe.
 */
const src = await Bun.file(new URL("../src/components/diff/DiffPage.tsx", import.meta.url)).text();

describe("what the list keeps readable", () => {
  test("a row's name wraps instead of being cut, and the folder gives way first", () => {
    const row = src.slice(src.indexOf("function FileRow("), src.indexOf("function StatusLetter("));
    expect(row).toMatch(/overflowWrap: "anywhere"[^\n]*\}\}>\{name\}/);
    expect(row).not.toMatch(/truncate[^\n]*\}\}>\{name\}/);
    expect(row).toMatch(/truncate min-w-0[^\n]*\{dir \|\| "\(root\)"\}/);
  });

  test("a section's branch does not shrink with its subject", () => {
    expect(src).toMatch(/font-semibold truncate shrink-0 max-w-\[85%\][^\n]*\{g\.label\}/);
    expect(src).toMatch(/text-\[10\.5px\] truncate[^\n]*\{g\.sub\}/);
  });
});
