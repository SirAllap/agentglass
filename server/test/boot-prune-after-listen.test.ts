/*
 * The boot retention prune must not run in the tick that ends with the server
 * listening: everything in that tick runs before /health can answer. It is
 * deferred with a timer, still once at boot, and still hourly after that.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

test("boot prune is deferred after Bun.serve, not called inline", () => {
  expect(src).not.toMatch(/^prune\(\);/m);
  const serve = src.indexOf("const server = Bun.serve");
  const deferred = src.indexOf('setTimeoutAs("boot prune", () => { waitedFor("retention prune", prune)');
  expect(serve).toBeGreaterThan(0);
  expect(deferred).toBeGreaterThan(serve);
  expect(src).toMatch(/setIntervalAs\("hourly prune"/);
});
