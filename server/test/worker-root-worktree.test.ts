/**
 * A worker started in a worktree of an open project speaks for that project.
 * The policy start path (`agents/policystart.ts`) minted its credential with no
 * root, so `confinedOwnRoot` was undefined and every `gh_*` call answered
 * "this worker has no project".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerFor, confinedOwnRoot, revokeWorkerTokens } from "../src/auth.ts";
import { mintBrowserCredential } from "../src/browseraccess.ts";
import { projectRootOf } from "../src/git.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-wroot-")));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" });
const project = join(dir, "orbit");
const tree = join(dir, "elsewhere", "orbit-fix");
const loose = join(dir, "loose");
mkdirSync(project, { recursive: true });
mkdirSync(loose, { recursive: true });
git(project, "init", "-q");
git(project, "commit", "-q", "--allow-empty", "-m", "init");
mkdirSync(join(dir, "elsewhere"), { recursive: true });
git(project, "worktree", "add", "-q", "-b", "fix", tree);

afterAll(() => { revokeWorkerTokens("wroot-a"); revokeWorkerTokens("wroot-b"); rmSync(dir, { recursive: true, force: true }); });

const callerOf = (t: string) => callerFor(new Request("http://x/", { headers: { authorization: `Bearer ${t}` } }), new URL("http://x/"), "machine");

describe("a worker's credential carries its project", () => {
  test("a worktree outside the project dir folds to the project", () => {
    const env: Record<string, string> = {};
    const t = mintBrowserCredential(env, "wroot-a", "claude", "builder", { root: projectRootOf(tree) ?? undefined })!;
    expect(confinedOwnRoot(callerOf(t))).toBe(project);
  });

  test("a directory in no repo has no project, and none is guessed", () => {
    expect(projectRootOf(loose)).toBeNull();
    const t = mintBrowserCredential({}, "wroot-b", "claude", "builder", { root: projectRootOf(loose) ?? undefined })!;
    expect(confinedOwnRoot(callerOf(t))).toBeUndefined();
  });

  test("every credential the policy path mints is given the project root", () => {
    const s = readFileSync(new URL("../src/agents/policystart.ts", import.meta.url), "utf8");
    const calls = s.split("mintBrowserCredential(").slice(1).map((c) => c.slice(0, c.indexOf(");")));
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toMatch(/root: (p\.policyRoot|flowRoot)/);
  });
});
