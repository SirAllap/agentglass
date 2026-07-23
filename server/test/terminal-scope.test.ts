// /terminal/commands hands back a repo's Makefile targets and script names.
// Scoped to one project, it must refuse a root outside that project — otherwise
// ?root=/any/other/repo leaks the file contents (command names) of a repo the
// cockpit was never opened for. safeAbs confines nothing to the workspace; only
// inScope does.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "agx-termscope-"));
const SCOPED = join(dir, "scoped");
const OTHER = join(dir, "other");
// A real repo each: projectCommands resolves the git root and walks for a
// Makefile, so string paths would surface nothing and the test would pass
// vacuously.
for (const p of [SCOPED, OTHER]) {
  mkdirSync(p, { recursive: true });
  spawnSync("git", ["-C", p, "init", "-q"]);
  writeFileSync(join(p, "Makefile"), "deploy:\n\techo ship it\n");
}
process.env.AGENTGLASS_ROOT = SCOPED; // read at import inside config.ts
process.env.XDG_CONFIG_HOME = dir;

let terminal: typeof import("../src/terminal.ts");

beforeAll(async () => {
  terminal = await import("../src/terminal.ts");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("projectCommands scoping", () => {
  test("lists a Makefile target for the open project", async () => {
    const cmds = await terminal.projectCommands(SCOPED);
    expect(cmds.make.some((m) => m.name === "deploy")).toBe(true);
  });

  test("refuses a repo outside the open project — no command names leak", async () => {
    const cmds = await terminal.projectCommands(OTHER);
    expect(cmds.make).toEqual([]);
    expect(cmds.scripts).toEqual([]);
  });
});
