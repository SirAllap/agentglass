/**
 * `do`'s short form names each verb's one argument — and it has to name it the
 * way the SERVER reads it.
 *
 * Two were wrong and both failed in the middle of a chain, after the steps
 * before them had already run:
 *
 *   "eval": "expr"         the server reads `js`, so every `do "eval ..."`
 *                          came back "js must be a non-empty expression under
 *                          20k" for an expression that was right there.
 *   "waitfor": "selector"  waitfor takes a CONDITION, so `do "waitfor #done"`
 *                          sent "#done" as JavaScript and the page answered
 *                          "Uncaught SyntaxError: Private field '#done' must
 *                          be declared in an enclosing class" — and that
 *                          example was printed in the CLI's own help.
 *
 * Read from the CLI and checked against the real parser, because the two live
 * on opposite sides of a wire and nothing else compares them.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAsk } from "../src/browserdrive.ts";

const CLI = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");

/** The map as the CLI has it: verb -> the body key it fills. */
function doArgs(): Record<string, string> {
  const at = CLI.indexOf("DO_ONE_ARG = {");
  expect(at, "the short form's argument map is gone").toBeGreaterThan(-1);
  const body = CLI.slice(at, CLI.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/"([a-zA-Z]+)":\s*"([a-zA-Z]+)"/g)) out[m[1]!] = m[2]!;
  return out;
}

test("every verb in do's short form fills the key its parser reads", () => {
  const map = doArgs();
  expect(Object.keys(map).length).toBeGreaterThan(10);
  const wrong: string[] = [];
  for (const [op, key] of Object.entries(map)) {
    /* A value that is fine for any of these keys: a selector, a url, a key
       name and a JavaScript expression all survive as this string. */
    const sample = op === "open" ? "https://example.com/" : op === "press" ? "Enter" : "#done";
    const parsed = parseAsk(op, { [key]: sample });
    if ("error" in parsed) wrong.push(`${op} sends ${key}: ${parsed.error}`);
  }
  expect(wrong, "these steps are refused by the server for the argument the CLI sends").toEqual([]);
});

test("and waitfor is not given a selector, whatever the help used to say", () => {
  expect(doArgs().waitfor, "waitfor takes a condition").toBe("js");
  expect(CLI).not.toContain("'waitfor #done'");
});
