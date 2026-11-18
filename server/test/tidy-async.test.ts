// The tidy report ran ten blocking git calls in a row on the server's only
// thread, behind GET /git/tidy: `branch --merged` walks the graph, twice, and
// the server waited for all of it. A blocking spawn of the same kind was
// measured holding the installed app for 9.7 s and 19.9 s.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tidyReport } from "../src/tidy.ts";

const tidy = await Bun.file(new URL("../src/tidy.ts", import.meta.url)).text();
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const code = tidy.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("no blocking git call is left in the report", () => {
  expect(code).toContain("export async function tidyReport(");
  expect(code).toContain("await gitAsync(root, ");
  // `git(` not preceded by a letter or a dot is the blocking one.
  expect(/(^|[^A-Za-z.])git\(/m.test(code)).toBe(false);
  expect(code).not.toContain("spawnSync");
});

test("the route waits for it", () => {
  const line = index.split("\n").find((l) => l.includes('"/git/tidy"') && !/^\s*(\/\/|\*)/.test(l)) ?? "";
  expect(line).toContain("await tidyReport(");
});

test("a timer ticks while the report waits for git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-tidy-async-"));
  try {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const r = await tidyReport(dir);
    clearInterval(timer);
    // Not a checkout: one git call, answered, and the loop was free meanwhile.
    expect(r.error).toBe("not a git checkout");
    expect(ticks).toBeGreaterThan(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
