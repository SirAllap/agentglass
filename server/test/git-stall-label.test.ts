// A stall inside the blocking git call was blamed on the label before it: the
// log named a tmux read for a freeze that was twenty-eight merges in a row.
import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/git.ts", import.meta.url)).text();

test("the blocking git call waits under its own stall label", () => {
  const at = source.indexOf("export function git(");
  expect(at).toBeGreaterThan(-1);
  const body = source.slice(at, source.indexOf("\n}\n", at));
  expect(body).toMatch(/waitedFor\(`git \$\{verbOf\(args\)\}`, \(\) => Bun\.spawnSync\(/);
});
