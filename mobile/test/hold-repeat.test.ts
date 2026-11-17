/*
 * One press is one hold.
 *
 * A hold that was refused — a merge GitHub said no to, a gate the desk answered
 * a moment earlier — leaves its sheet up with the reason, and the next press
 * has to be able to try again. The button used to remember that it had fired
 * for as long as it was mounted, so the second press did nothing and said
 * nothing, and the sheet it lived in stays mounted while it is closed.
 *
 * There is no renderer here, so the rule is read off the source: `begin` is the
 * only place a press starts, and it must clear the flag `finish` set.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

/** A function's own body, from its declaration to the line that closes it. */
const bodyOf = (text: string, decl: string): string => {
  const at = text.indexOf(decl);
  if (at < 0) throw new Error(`not found: ${decl}`);
  const end = text.indexOf("\n  };", at);
  if (end < 0) throw new Error(`no closing brace after: ${decl}`);
  return text.slice(at, end);
};

const ui = src("src", "ui.tsx");
const begin = bodyOf(ui, "const begin = (): void => {");
const finish = bodyOf(ui, "const finish = (): void => {");

describe("a HoldButton after its hold fired", () => {
  test("a new press clears the flag the last one set", () => {
    expect(begin).toContain("confirmed.current = false");
  });

  test("and no longer refuses to start because it fired before", () => {
    expect(begin).not.toContain("confirmed.current) return");
  });

  test("while one press still fires only once", () => {
    // The guard that stops the fill's callback and the release both calling it.
    expect(finish).toContain("if (confirmed.current) return;");
    expect(finish).toContain("confirmed.current = true;");
  });
});
