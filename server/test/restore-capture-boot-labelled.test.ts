/*
 * The first layout capture after a boot asked the events table, pane by pane,
 * whether each flag value of a claude command line was a typed prompt. Nothing
 * is cached yet then, and each "anywhere" ask walks every prompt row (~100 ms on
 * a 1.6 GB file), so one microtask continuation held the loop ~0.8-1.4 s under
 * the name "unlabelled: tickStack" in server-stall.log. Now the ask is labelled
 * and the loop is handed back between panes.
 */
import { expect, test } from "bun:test";
import { currentLabel } from "../src/loopwatch.ts";
import { __setPromptAsk, __wasPromptFor, yieldToLoop } from "../src/tmuxrestore.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../src/tmuxrestore.ts"), "utf8");

test("the prompt lookup runs under a loopwatch label", () => {
  expect(src).toMatch(/waitedFor\("restore prompt lookup", \(\) => sessions\.some/);
});

test("the loop is yielded to before each pane's prompt lookups", () => {
  const yielded = src.indexOf("await yieldToLoop();");
  const asks = src.indexOf("const agentArgs = agentArgsOf(under.argv, (text) => wasPromptFor(");
  expect(yielded).toBeGreaterThan(0);
  expect(asks).toBeGreaterThan(yielded);
  expect(asks - yielded).toBeLessThan(200);
});

test("behaviour: the 'anywhere' ask runs under the restore label", () => {
  let during = "";
  const undo = __setPromptAsk({ of: () => false, anywhere: () => { during = currentLabel(); return false; } });
  try { __wasPromptFor(990001, "typed prompt", [], 0, 5); } finally { undo(); }
  expect(during).toContain("restore prompt lookup");
});

test("behaviour: yieldToLoop lets a queued timer run before the next pane is asked", async () => {
  const order: string[] = [];
  setImmediate(() => order.push("other work"));
  await yieldToLoop();
  order.push("next pane");
  expect(order).toEqual(["other work", "next pane"]);
});
