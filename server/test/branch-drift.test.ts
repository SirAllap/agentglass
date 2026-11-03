// The Branches list says how far each branch is from the trunk and who made its
// tip: "4 only here, 2 newer on main" is the row's arrows and the inspector's
// picture, and neither can be computed in the browser.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-drift-")));
const REPO = join(dir, "repo");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "d.db");

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}
function commit(file: string, message: string) {
  writeFileSync(join(REPO, file), message);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

describe("branches() drift from the trunk", () => {
  let list: Awaited<ReturnType<typeof import("../src/gitwork.ts").branches>>;
  beforeAll(async () => {
    mkdirSync(REPO, { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "mira@example.com");
    git("config", "user.name", "Mira Okafor");
    commit("a", "root");
    git("checkout", "-q", "-b", "feat/export");
    commit("b", "one"); commit("c", "two"); commit("d", "three");
    git("checkout", "-q", "main");
    commit("e", "newer on main");
    list = await (await import("../src/gitwork.ts")).branches(REPO);
  });
  test("a branch carries commits only here, commits only on the trunk, and its author", () => {
    const b = list.branches.find((x) => x.name === "feat/export");
    expect(b?.aheadTrunk).toBe(3);
    expect(b?.behindTrunk).toBe(1);
    expect(b?.author).toBe("Mira Okafor");
  });
  test("the trunk itself is level with itself", () => {
    const m = list.branches.find((x) => x.name === "main");
    expect([m?.aheadTrunk, m?.behindTrunk]).toEqual([0, 0]);
  });
});
