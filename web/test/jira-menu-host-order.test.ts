/*
 * The card menu's rows did nothing: MenuHost returned the card menu before `const pickCard` and `const onPick` ran, so the
 * handler it gave the menu pointed at a binding that was never initialised ("Current sprint" in a filter view moved no card).
 * A rule about source: nothing in the component is returned before the handlers the returned menus call exist.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/jira/list/menus/JiraMenuHost.tsx", import.meta.url)).text();
const body = src.slice(src.indexOf("function MenuHost("), src.indexOf("function parentOf("));
const code = body.split("\n").filter((l) => !l.trim().startsWith("/*") && !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");

describe("MenuHost", () => {
  test("every handler is declared before the first return of a menu", () => {
    const first = code.indexOf("return <");
    expect(first).toBeGreaterThan(0);
    for (const name of ["pickCard", "onPick", "openPull", "assignTo"]) {
      const at = code.indexOf(`const ${name} =`);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(first);
    }
  });
  test("no return sits between the handlers' declarations and the card menu's build", () => {
    expect(code.slice(0, code.indexOf("const onPick =")).includes("return <JiraCardMenu")).toBe(false);
    expect(code.slice(0, code.indexOf("const onPick =")).includes("return <JiraAssignPop")).toBe(false);
  });
});
