// The `issue` command opens a tmux window for a button. It used to `return`
// without a word when the folder was out of scope or gone, and the button had
// already written "Claude is on it". Every path out must answer.
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const at = src.indexOf('if (msg.cmd === "issue") {');
const block = src.slice(at, src.indexOf('if (msg.cmd === "resume") {', at));
const code = block.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

test("the issue handler is found", () => { expect(at).toBeGreaterThan(0); });

test("a refused folder is answered with the reason, never dropped", () => {
  expect(code).not.toMatch(/inScope\(cwd\)[^\n]*\)\s*return;/);
  for (const why of ["not an absolute path", "no longer exists", "outside the open project"]) expect(code).toContain(why);
});

test("both window openings answer with what the engine did", () => {
  expect(code.match(/engineWindowOutcome\([^\n]*\.then\(\(w\) => \{ answer\(w\.ok/g)?.length).toBe(2);
});
