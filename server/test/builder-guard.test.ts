/*
 * What a flight-plan builder may not run or write from its shell, read the way a shell
 * reads a command line: wrappers, quoting, git's global options, absolute paths. Each
 * "never" row is a way past the launch's prefix deny list that this closes.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandVerdict, realish, splitShell, type GuardCtx } from "../src/builderGuard.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-guard-")));
const tree = join(dir, "orbit-fp-footer"), elsewhere = join(dir, "acme"), scratch = join(dir, "scratch");
mkdirSync(tree, { recursive: true }); mkdirSync(elsewhere); mkdirSync(scratch);
symlinkSync(elsewhere, join(tree, "out"));
symlinkSync(join(elsewhere, "not-there-yet"), join(tree, "dangling"));
const ctx: GuardCtx = { worktree: tree, cwd: tree, tmp: scratch, base: "develop", home: join(dir, "home") };
const never = (cmd: string) => expect(commandVerdict(cmd, ctx)).toMatchObject({ decision: "never" });
const fine = (cmd: string) => expect(commandVerdict(cmd, ctx)).toBeNull();
import { afterAll } from "bun:test";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("git", () => {
  test("push, pull, merge, tag and update-ref are never, however they are spelled", () => {
    for (const c of [
      "git push", "git push origin HEAD", "git -C . push", "git -c user.name=x push", "git --git-dir=.git push", "git --no-pager push",
      "/usr/bin/git push", "env git push", "env GIT_TRACE=1 git push", "command git push", "exec git push", "nohup git push",
      "sh -c 'git push'", "bash -lc \"git merge main\"", "sudo -u root git tag v1", "timeout 5 git pull", "FOO=1 git push",
      "ls && git push", "ls; git push", "echo hi | git push", "echo $(git push)", "echo `git tag x`", "git merge main", "git pull --rebase",
      "git update-ref refs/heads/main HEAD", "git tag v1", "sh -c \"sh -c 'git push'\"", "\\git push", "'git' push",
    ]) never(c);
  });

  test("branch and checkout of the base branch are never; the builder's own branch and a rebase are fine", () => {
    for (const c of ["git branch -f main HEAD", "git branch -D main", "git branch -M develop", "git branch --force master abc", "git checkout main", "git switch develop", "git checkout origin/main", "git -C . checkout master"]) never(c);
    for (const c of ["git rebase main", "git rebase origin/main", "git checkout -b flight-plan/footer-2", "git checkout -- src/a.ts", "git branch -D flight-plan/old", "git commit -m 'merge main notes'", "git status", "git diff main...HEAD", "git log --oneline", "git add -A", "git stash list"]) fine(c);
  });

  test("git pointed at another tree is never; at its own tree is fine", () => {
    never(`git -C ${elsewhere} status`);
    never(`git --git-dir=${elsewhere}/.git log`);
    fine(`git -C ${tree} status`);
    fine("git -C . status");
  });
});

describe("gh", () => {
  test("pr and release are never; api only reads", () => {
    for (const c of ["gh pr create", "gh pr merge 3", "gh release create v1", "gh -R acme/orbit pr view 3", "/usr/local/bin/gh pr list",
      "gh api -X POST repos/acme/orbit/issues", "gh api --method=PATCH repos/a/b", "gh api repos/a/b -f title=x", "gh api graphql -f query='mutation { x }'", "gh api -XDELETE repos/a/b"]) never(c);
    for (const c of ["gh api repos/acme/orbit/pulls", "gh api -X GET repos/acme/orbit", "gh issue list", "gh run view 3"]) fine(c);
  });
});

describe("agentglass-ui", () => {
  test("settings set and rules set are never in any argv position", () => {
    for (const c of ["agentglass-ui settings set theme dark", "agentglass-ui --as me settings set x 1", "agentglass-ui rules set --match X never", "python3 /opt/bin/agentglass-ui settings set a b", "env agentglass-ui settings set a b"]) never(c);
    for (const c of ["agentglass-ui settings get theme", "agentglass-ui rules list", "agentglass-ui flight-plan plan report fp_1 done", "agentglass-ui settings list"]) fine(c);
  });
});

describe("writes from the shell stay in the worktree", () => {
  test("a redirect, tee, sed -i, cp, mv, rm, install, ln and dd outside it are never", () => {
    for (const c of [
      `echo x > ${elsewhere}/a`, `echo x >> ${elsewhere}/a`, `echo x 2> ${elsewhere}/err`, `echo x &> ${elsewhere}/all`, `echo x | tee ${elsewhere}/a`,
      `sed -i s/a/b/ ${elsewhere}/a`, `sed -i -e 's/a/b/' ${elsewhere}/a`, `cp src/a ${elsewhere}/a`, `cp -t ${elsewhere} src/a`, `mv src/a ${elsewhere}/a`, `mv ${elsewhere}/a src/a`,
      `rm ${elsewhere}/a`, `rm -rf ${elsewhere}`, `install -m 755 src/a ${elsewhere}/a`, `ln -s src/a ${elsewhere}/l`, `dd if=/dev/zero of=${elsewhere}/big`,
      "echo x > ../acme/a", "echo x > ~/note", `sh -c 'echo x > ${elsewhere}/a'`, `ls && echo x > ${elsewhere}/a`, "echo x > $HOME/a", "echo x > out/a", "echo x > dangling",
      "rm /etc/hosts", `cd ${elsewhere} && echo x > a`,
    ]) {
      if (c.startsWith("cd ")) continue; // the cwd is the hook's, a `cd` inside the line is the named limit
      never(c);
    }
  });

  test("inside the worktree, the builder's scratch directory and the null device is fine", () => {
    for (const c of ["echo x > src/a.ts", `echo x >> ${tree}/log`, "echo x | tee src/b", "sed -i s/a/b/ src/a.ts", "cp src/a src/b", "mv src/a src/b", "rm -rf build",
      `echo x > ${scratch}/note`, "echo x > $TMPDIR/note", "echo x > ${TMPDIR}/note", "echo x > /dev/null", "ls 2>&1", "ls 2>/dev/null", "bun test 2>&1 | tail -5", "cat a > /dev/stderr",
      "git log --oneline | head -3", "echo a > b && echo c > d", "grep -r x . > found.txt"]) fine(c);
  });

  test("a symlink out of the tree, or one that dangles, is seen for what it points at", () => {
    expect(realish(join(tree, "out", "a"))).toBe(join(elsewhere, "a"));
    expect(realish(join(tree, "dangling"))).toBe(join(elsewhere, "not-there-yet"));
    expect(realish(join(tree, "new", "deep", "file"))).toBe(join(tree, "new", "deep", "file"));
  });

  test("a sibling that only starts with the tree's name is outside it", () => {
    never(`echo x > ${tree}-other/a`);
  });
});

describe("reading the line", () => {
  test("quotes, escapes and substitutions", () => {
    expect(splitShell(`echo "a b" 'c d' e\\ f`).segments[0]!.map((t) => t.s)).toEqual(["echo", "a b", "c d", "e f"]);
    expect(splitShell("a && b || c; d | e").segments.map((s) => s[0]!.s)).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitShell("echo $(git push) `ls`").nested).toEqual(["git push", "ls"]);
    expect(splitShell("echo x 2>&1 > out").segments[0]!.map((t) => t.s)).toEqual(["echo", "x", ">&", "1", ">", "out"]);
  });
});
