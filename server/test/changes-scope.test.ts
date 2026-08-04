// Which recorded edits belong to the open project.
//
// A session is in scope because its cwd is; where it WRITES is a separate
// question, and the diff view was answering it with "everywhere". Scoped to one
// repo, the list filled with a note under ~/Documents and a scratch script in
// /tmp — real edits by real sessions of that project, and not one of them the
// project — pushing the code you opened the view to read off the screen.
//
// The property that makes this usable rather than annoying is the second test:
// a linked worktree IS the project. Get that wrong and a repo worked through
// worktrees — which is the whole point of this app — hides nearly every edit it
// should be showing, which is a far worse failure than the noise it replaced.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;      // the scoped project
let linked: string;    // a `git worktree add` of it, as orbit-WEB-1042 is of orbit
let elsewhere: string; // notes, scratch — a session's own writing, off the project
let sibling: string;   // a different repo entirely

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });

beforeAll(() => {
  const box = mkdtempSync(join(tmpdir(), "agx-changes-scope-"));
  repo = join(box, "proj");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(box, "init", "-q", "proj");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  linked = join(box, "proj-FEATURE-1");
  git(repo, "worktree", "add", "-q", "-b", "feature-1", linked);

  sibling = join(box, "other");
  mkdirSync(sibling, { recursive: true });
  git(box, "init", "-q", "other");

  elsewhere = mkdtempSync(join(tmpdir(), "agx-elsewhere-"));
  mkdirSync(join(elsewhere, "notes"), { recursive: true });
  writeFileSync(join(elsewhere, "notes", "worklog.md"), "- did a thing\n");

  cleanup = () => { rmSync(box, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); };
});

let cleanup = () => {};
afterAll(() => cleanup());

// The scope is passed explicitly, exactly as /changes passes workspaceRoot() —
// so this reads the real decision function without touching the config the
// machine is actually running on.
const config = async () => await import("../src/config.ts");

describe("an edit is the project's, or it is not", () => {
  test("a file in the scoped repo is the project's", async () => {
    const { inScope } = await config();
    expect(inScope(join(repo, "src", "a.ts"), repo)).toBe(true);
  });

  test("a file in a linked worktree is the project's too", async () => {
    // The one that matters: orbit-WEB-1042 is orbit. A prefix test on the
    // scope directory alone says no, and hides the work.
    const { inScope } = await config();
    expect(inScope(join(linked, "src", "a.ts"), repo)).toBe(true);
  });

  test("a note this project's session wrote elsewhere is not the project's", async () => {
    const { inScope } = await config();
    expect(inScope(join(elsewhere, "notes", "worklog.md"), repo)).toBe(false);
  });

  test("a scratch file under the temp dir is not the project's", async () => {
    const { inScope } = await config();
    expect(inScope(join(tmpdir(), "claude-1000", "-home-x-code-proj", "abc", "proof.py"), repo)).toBe(false);
  });

  test("another repo beside it is not the project's", async () => {
    const { inScope } = await config();
    expect(inScope(join(sibling, "x.ts"), repo)).toBe(false);
  });

  test("a path that only shares a prefix with the scope is not inside it", async () => {
    // `/code/proj` must not swallow `/code/proj-FEATURE-1` by string prefix —
    // it is in scope here, but as a worktree, and a sibling that is NOT a
    // worktree has to come back false or the boundary is textual, not real.
    const { inScope } = await config();
    expect(inScope(join(`${repo}-not-a-worktree`, "x.ts"), repo)).toBe(false);
  });

  test("nothing is outside when there is no project", async () => {
    // /changes short-circuits on an unscoped instance rather than asking, and
    // this is why: with no scope there is nothing to be outside of, and the
    // answer for every path is "in".
    const { inScope } = await config();
    expect(inScope(join(elsewhere, "notes", "worklog.md"), "")).toBe(true);
  });
});
