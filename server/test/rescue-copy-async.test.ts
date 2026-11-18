// Copying leftovers out of a worktree ran `cp -R` as a blocking spawn with no
// limit on the server's one thread: a tree of a few GB held every panel until
// it was done. What it copies and refuses is pinned by
// worktree-leftovers.test.ts; this pins that it no longer blocks.
import { expect, test } from "bun:test";
import { RESCUE_COPY_LIMIT_MS } from "../src/gitwork.ts";

const source = await Bun.file(new URL("../src/gitwork.ts", import.meta.url)).text();

test("the copy runs beside the loop, with a limit, and a stopped copy is not a copy", () => {
  const at = source.indexOf("export async function rescueLeftovers(");
  expect(at).toBeGreaterThan(-1);
  const code = source.slice(at, source.indexOf("\n}\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  expect(code).not.toContain("spawnSync");
  expect(code).toContain('await spawnOut(["cp", "-Rn", from, to], { timeoutMs: RESCUE_COPY_LIMIT_MS });');
  expect(code).toContain("if (p.killed || p.exitCode !== 0) {");
  expect(RESCUE_COPY_LIMIT_MS).toBeGreaterThanOrEqual(60_000);
});
