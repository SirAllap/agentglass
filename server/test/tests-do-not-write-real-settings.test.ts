/**
 * THE SUITE MUST NOT WRITE THE SETTINGS OF WHOEVER RUNS IT.
 *
 * Measured this morning, with the deputy stuck and its screen reading "it has
 * nowhere to work": the fence held `agentglass`, one test file ran from the
 * repository root, and the fence held `""`. The suite had been emptying the
 * owner's own setting a dozen times a night. Everything else about the deputy
 * being stuck was downstream of that.
 *
 * Two faults, and each one alone was enough:
 *
 *   `server/bunfig.toml` carries the preload that redirects XDG_CONFIG_HOME,
 *   and bun reads a bunfig from the directory it was STARTED in — so
 *   `cd server && bun test` was protected and `bun test server/` from the root,
 *   which is how everything in this repo actually runs it, was not.
 *
 *   The redirect was `if (!XDG_CONFIG_HOME)`, so a machine that sets it — at
 *   the real `~/.config`, which is the whole point — got no protection at all.
 *
 * This asserts the property rather than either mechanism: wherever the settings
 * of this process live, it is not where a person's do.
 */
import { test, expect } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

test("the config directory this process writes to is a scratch one", () => {
  const set = process.env.XDG_CONFIG_HOME ?? "";
  expect(set, "the preload did not run — a test can now write the real settings").not.toBe("");
  expect(resolve(set).startsWith(resolve(tmpdir()) + "/"), `XDG_CONFIG_HOME is ${set}`).toBe(true);
  expect(resolve(set).startsWith(resolve(homedir(), ".config"))).toBe(false);
});

test("and the preload is reachable from the repository root, not only from server/", () => {
  /* Every agent, script and person in this repo runs `bun test server/` from
     the root. A guard that only loads from one directory is a guard with a
     door left open. */
  const root = readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8");
  expect(root).toContain("preload");
  expect(root).toContain("server/test/tmpsweep.ts");
});
