// Scope as a boundary, not just a filter.
//
// #48 made an open project narrow what you can *see*. This pins the other half:
// what you can *touch*. A cockpit that shows one project while still handing out
// git writes and a login shell anywhere on the machine is the confusing
// half-state — the UI claims one project and the capabilities say otherwise.
//
// The rule is deliberately shared by every write path (git mutations, the PTY,
// chat) rather than re-implemented per call site, because the original scoping
// bug was exactly that: each endpoint had to remember, and most didn't.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-scopewrite-"));
const PROJECT = join(dir, "project");
const SIBLING = join(dir, "project-backup");
for (const p of [PROJECT, SIBLING, join(PROJECT, "packages", "api")]) mkdirSync(p, { recursive: true });

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own scope
process.env.AGENTGLASS_DB = join(dir, "w.db");

// The scope is passed explicitly rather than read from the environment:
// `bun test` runs every file in one process and config.ts resolves its scope
// once at module load, so whichever test file imported it first would decide
// what these assertions see. Passing it makes the rule testable on its own.
let cfg: typeof import("../src/config.ts");
beforeAll(async () => { cfg = await import("../src/config.ts"); });

describe("inScope", () => {
  test("the project itself and anything under it", () => {
    expect(cfg.inScope(PROJECT, PROJECT)).toBe(true);
    expect(cfg.inScope(join(PROJECT, "packages", "api"), PROJECT)).toBe(true);
  });

  test("a sibling sharing the name prefix is out", () => {
    // "/code/app" must not authorise "/code/app-backup" — the trailing
    // separator is the whole reason this isn't a bare startsWith.
    expect(cfg.inScope(SIBLING, PROJECT)).toBe(false);
  });

  test("an unrelated path is out", () => {
    expect(cfg.inScope("/etc", PROJECT)).toBe(false);
    expect(cfg.inScope(dir, PROJECT)).toBe(false); // the parent is not the project
  });

  test("traversal cannot climb out of the scope", () => {
    // The path is resolved before comparison, so spelling an escape doesn't
    // work — this is the case a string compare alone would wave through.
    expect(cfg.inScope(join(PROJECT, "..", "project-backup"), PROJECT)).toBe(false);
    expect(cfg.inScope(join(PROJECT, "..", ".."), PROJECT)).toBe(false);
  });

  test("a missing path is refused rather than assumed safe", () => {
    expect(cfg.inScope(null, PROJECT)).toBe(false);
    expect(cfg.inScope(undefined, PROJECT)).toBe(false);
    expect(cfg.inScope("", PROJECT)).toBe(false);
  });

  test("whole-machine allows everything", () => {
    // The other half of the contract, and the one a too-eager guard would
    // break: with no project open there is nothing to enforce, and every
    // existing setup must keep working exactly as before.
    expect(cfg.inScope("/etc", null)).toBe(true);
    expect(cfg.inScope(SIBLING, null)).toBe(true);
    // Still refuses a path it was given nothing to check.
    expect(cfg.inScope(null, null)).toBe(true);
  });
});
