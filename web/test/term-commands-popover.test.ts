/*
 * The Commands popover leads with the project's own commands, and a pin made there shows on the quiet bar.
 */
import { describe, expect, test } from "bun:test";

import { showPins } from "../src/components/CommandBar.tsx";
const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
/** Source without its comment lines, so a word in a comment cannot satisfy a rule about code. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const commandBar = await read("../src/components/CommandBar.tsx");

describe("Commands popover", () => {
  test("lists the project's own commands before git and settings", () => {
    const c = code(commandBar);
    const at = ["groups.map(([label, list])", "{gitMatches.map(", "{settingsPageMatches.map("].map((m) => c.indexOf(m));
    expect(at.every((n) => n !== -1)).toBe(true);
    expect(at[0]).toBeLessThan(at[1]!);
    expect(at[0]).toBeLessThan(at[2]!);
  });

  test("a pin shows on the quiet bar; only the empty strip is hidden", () => {
    expect(showPins(true, [])).toBe(false);
    expect(showPins(true, ["git status"])).toBe(true);
    expect(showPins(false, [])).toBe(true);
    expect(showPins(undefined, [])).toBe(true);
  });

  test("the strip is hidden by showPins and nothing else", () => {
    expect(code(commandBar)).toContain("showPins(quiet, pins) ? undefined : { display: \"none\" }");
  });
});
