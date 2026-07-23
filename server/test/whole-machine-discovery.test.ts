// What "Whole machine" looks at — and, more to the point, what it no longer does.
//
// Discovery used to crawl the disk on the unscoped path: a conventional-homes
// guess (~/code, ~/src, …) plus the parent of every known project, each recursed
// with readdirSync to REPO_SCAN_DEPTH. On a real ~/code that speculative walk is
// pure JS/native, runs longer than its own cache, and pins a core at 99.9% while
// the terminal on the same thread freezes (reproduced by scripts/loadtest.ts with
// AGX_LOAD_WHOLE_MACHINE=1).
//
// So the walk is gone. "Whole machine" now means "the projects agentglass already
// knows about": what telemetry has seen agents run in, what the user configured,
// and agentglass's own repo. A project with none of those does not appear on its
// own — the user names it once with repoDirs. These tests pin exactly that line:
// a repo that is ONLY reachable by walking $HOME stays hidden, and the sources
// that remain each surface it.
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "";
let code = "";
const realHome = process.env.HOME;
const realRoot = process.env.AGENTGLASS_ROOT;
const realDirs = process.env.AGENTGLASS_REPO_DIRS;
const realRepos = process.env.AGENTGLASS_REPOS;

const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
function makeRepo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  return dir;
}

// A fresh HOME each time so nothing leaks between cases, and — crucially —
// UNSCOPED (no AGENTGLASS_ROOT) so discoverRepos takes its whole-machine path.
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agx-wm-")));
  code = join(home, "code");
  mkdirSync(code, { recursive: true });
  process.env.HOME = home;
  delete process.env.AGENTGLASS_ROOT;
  delete process.env.AGENTGLASS_REPO_DIRS;
  delete process.env.AGENTGLASS_REPOS;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realRoot === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = realRoot;
  if (realDirs === undefined) delete process.env.AGENTGLASS_REPO_DIRS; else process.env.AGENTGLASS_REPO_DIRS = realDirs;
  if (realRepos === undefined) delete process.env.AGENTGLASS_REPOS; else process.env.AGENTGLASS_REPOS = realRepos;
  rmSync(home, { recursive: true, force: true });
});

// Invalidated before every call because the repo list is cached by scope and
// these cases share a scope (null). ignoreScope:true is the project picker's
// call — the one that must reach the whole machine.
async function discover(paths: string[], knownRoots: string[] = []): Promise<string[]> {
  const gw = await import("../src/gitwork.ts");
  gw.invalidateRepos();
  return (await gw.discoverRepos(paths, knownRoots, { ignoreScope: true })).map((r) => r.name);
}

describe("whole-machine discovery no longer walks the disk", () => {
  test("a repo reachable only by crawling $HOME is NOT discovered", async () => {
    // `unseen` sits in ~/code with a real .git — exactly what the old walk would
    // have found. With no telemetry, no config and no scan pointing at it, it must
    // stay hidden: that absence is the whole fix.
    makeRepo(join(code, "unseen"), "unseen");
    expect(await discover([])).not.toContain("unseen");
  });

  test("telemetry is the primary source — a touched repo appears", async () => {
    const seen = makeRepo(join(code, "seen"), "seen");
    // `paths` is what getChanges hands discoverRepos: files agents edited. One
    // path inside the repo is enough to surface the repo, with no walk.
    expect(await discover([join(seen, "README.md")])).toContain("seen");
  });

  test("a transcript-scanned known root appears", async () => {
    const known = makeRepo(join(code, "known"), "known");
    expect(await discover([], [known])).toContain("known");
  });

  test("an explicitly configured repoDir is still swept (the escape hatch)", async () => {
    // Naming the directory is the supported way to add a repo the app has never
    // seen an agent run in. reposUnder() still walks it — but only because the
    // user asked, and only the directory they named.
    makeRepo(join(code, "configured"), "configured");
    process.env.AGENTGLASS_REPO_DIRS = code;
    expect(await discover([])).toContain("configured");
  });

  test("AGENTGLASS_REPOS names a repo that lives elsewhere", async () => {
    const elsewhere = makeRepo(join(home, "elsewhere"), "elsewhere");
    process.env.AGENTGLASS_REPOS = elsewhere;
    expect(await discover([])).toContain("elsewhere");
  });
});
