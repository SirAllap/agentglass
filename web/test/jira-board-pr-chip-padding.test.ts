/* The board's PR row hugs its chip: equal left/right padding, so a card with
   a pull request and no CI label does not show a box wider on the right. */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const rule = (sel: string) => new RegExp(`^${sel.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m").exec(CSS)?.[1] ?? "";

describe("board PR row padding", () => {
  it("is the same on the left and the right", () => {
    const parts = /(?:^|[\s;])padding:\s*([^;]+);/.exec(rule(".agx-jb-prrow"))?.[1]?.trim().split(/\s+/) ?? [];
    // `V H` (one value for both sides) or `T R B L` (right [1] equals left [3]).
    expect(parts.length === 2 || (parts.length === 4 && parts[1] === parts[3])).toBe(true);
  });
  it("gives the CI label its own right padding instead of the row", () => {
    expect(rule(".agx-jb-ci")).toMatch(/padding-right:\s*6px/);
  });
});
