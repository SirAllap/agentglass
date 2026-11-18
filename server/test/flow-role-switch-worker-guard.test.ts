/*
 * A role switch is the person's or the seat's, never a worker's. The harness
 * cannot boot a real server in this sandbox (loopback refused even for an
 * unmodified baseline test), so this pins the guard at the source level,
 * sliced to the prompt route's own block — the same technique
 * flow-role-lock.test.ts uses for its resume/switch invariant.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("the flowRole branch of /agents/named/prompt refuses a worker caller", async () => {
  const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
  const at = src.indexOf('verb === "prompt" && a && startedByOf(a)');
  expect(at).toBeGreaterThan(-1);
  const block = src.slice(at, src.indexOf("\n      }", at));
  expect(block).toContain('b.flowRole !== undefined && caller?.principal === "worker"');
  expect(block).toContain("a role switch is the person's or the seat's, never a worker's");
  // The guard runs before the switch itself, not after.
  expect(block.indexOf("caller?.principal === \"worker\"")).toBeLessThan(block.indexOf("promptHeadless("));
});
