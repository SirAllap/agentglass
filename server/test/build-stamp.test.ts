/*
 * The build stamp, which has to be unable to lie.
 *
 * It was `git rev-parse HEAD` and nothing else, and every input to the package
 * is copied off DISK — electron/package.json's `files` and `extraResources` by
 * electron-builder, the web bundle and the sidecar by build.mjs itself. So a
 * dirty tree produced a binary stamped with a commit it did not contain, and
 * the About pane rendered that as seven authoritative hex characters.
 *
 * Both of the day's casualties are in here as cases:
 *  - a binary stamped 9699619 that carried the tailscale-serve auth fix from
 *    dd1f558, its CHILD, so "does my installed app have the security fix?"
 *    could not be answered from the stamp at all;
 *  - an install that carried another session's uncommitted electron/main.js,
 *    which is how a build that could not draw a window reached the desktop.
 *
 * The two properties being pinned:
 *  1. two different trees cannot produce the same stamp;
 *  2. a build that is not a commit never looks like one.
 *
 * Driven against the real electron/build.mjs in a throwaway git repository,
 * because the bug was entirely about what git was asked and what was on disk.
 * Asserting on the source text would have passed against the broken version.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BUILD_MJS = new URL("../../electron/build.mjs", import.meta.url).pathname;
const trash: string[] = [];
afterEach(() => { for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function write(dir: string, rel: string, body: string) {
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/**
 * A repository shaped like this one: the real build.mjs, one file from each
 * root it hashes, and two files that are inside those roots but ship with
 * nothing — a README and a web test.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agx-stamp-"));
  trash.push(dir);
  write(dir, ".gitignore", "node_modules\nelectron/staging\nelectron/dist-app\nweb/dist\n");
  write(dir, "package.json", JSON.stringify({ name: "agentglass", version: "0.8.0" }));
  write(dir, "bun.lock", "{}\n");
  write(dir, "electron/package.json", JSON.stringify({ name: "agentglass-electron", version: "0.8.0" }));
  // build.mjs copies this into staging, so it has to exist.
  write(dir, "electron/self-update.sh", "#!/usr/bin/env bash\n");
  write(dir, "electron/main.js", "// the electron shell\n");
  write(dir, "web/src/App.tsx", "export const App = () => null\n");
  write(dir, "server/src/index.ts", "export const serve = () => 0\n");
  write(dir, "shared/types.ts", "export type T = 1\n");
  write(dir, "hooks/hook.py", "print(1)\n");
  // Inside a hashed root, packaged by nothing.
  write(dir, "web/test/App.test.tsx", "test('x', () => {})\n");
  // Outside every hashed root.
  write(dir, "README.md", "# agentglass\n");
  write(dir, "docs/notes.md", "notes\n");
  mkdirSync(join(dir, "electron"), { recursive: true });
  copyFileSync(BUILD_MJS, join(dir, "electron/build.mjs"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "one");
  return dir;
}

type Stamp = {
  version: string; commit: string; stamp: string; tree: string;
  dirty: boolean; dirtyFiles: string[]; dirtyOther: number; baseTag: string; distance: number;
};

/** Run the stamping half of build.mjs — the same mode CI uses, which skips the
 *  web build and the sidecar compile and does nothing else differently. */
function stampOf(dir: string): Stamp {
  const r = spawnSync("node", [join(dir, "electron/build.mjs"), "--provenance-only"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build.mjs failed: ${r.stderr || r.stdout}`);
  return JSON.parse(readFileSync(join(dir, "electron/staging/build-info.json"), "utf8")) as Stamp;
}
function stampWithOutput(dir: string) {
  const r = spawnSync("node", [join(dir, "electron/build.mjs"), "--provenance-only"], { cwd: dir, encoding: "utf8" });
  return { ...r, json: JSON.parse(readFileSync(join(dir, "electron/staging/build-info.json"), "utf8")) as Stamp };
}
const check = (dir: string) =>
  spawnSync("node", [join(dir, "electron/build.mjs"), "--check-stamp", join(dir, "electron/staging/build-info.json")],
    { cwd: dir, encoding: "utf8" });

/** Seven bare hex characters is the one shape that means "this IS a commit".
 *  Nothing else in the vocabulary may ever match it. */
const LOOKS_LIKE_A_COMMIT = /^[0-9a-f]{7}$/;

describe("a clean tree", () => {
  test("stamps as its commit, and says which tree that was", () => {
    const dir = fixture();
    const s = stampOf(dir);
    expect(s.stamp).toMatch(LOOKS_LIKE_A_COMMIT);
    expect(s.commit.startsWith(s.stamp)).toBe(true);
    expect(s.dirty).toBe(false);
    expect(s.dirtyFiles).toEqual([]);
    // The tree hash is there even when clean, so a later build can be compared
    // against it rather than against a commit that says nothing about content.
    expect(s.tree).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is still clean when the dirty file ships with nothing", () => {
    // The other half of the design, and the reason the closure is not just
    // "the repo": a warning that fires because somebody edited a test or a
    // README is a warning nobody reads by the end of the week. The count is
    // still reported — it is just not allowed to change what the build IS.
    const dir = fixture();
    const before = stampOf(dir);
    appendFileSync(join(dir, "README.md"), "an edit\n");
    appendFileSync(join(dir, "web/test/App.test.tsx"), "// an edit\n");
    writeFileSync(join(dir, "docs/scratch.md"), "untracked\n");
    const after = stampOf(dir);
    expect(after.stamp).toBe(before.stamp);
    expect(after.tree).toBe(before.tree);
    expect(after.dirty).toBe(false);
    expect(after.dirtyOther).toBe(3);
  });
});

describe("a tree that is not its commit", () => {
  test("cannot pass for one — casualty 2, another session's uncommitted main.js", () => {
    const dir = fixture();
    const clean = stampOf(dir);
    appendFileSync(join(dir, "electron/main.js"), "// mid-edit, from another session\n");
    const s = stampOf(dir);

    expect(s.dirty).toBe(true);
    expect(s.stamp).not.toMatch(LOOKS_LIKE_A_COMMIT);
    expect(s.stamp).toBe(`${clean.stamp}+dirty.${s.tree.slice(0, 7)}`);
    // Named, because "which uncommitted file is in the app I am running" is the
    // question that had no answer.
    expect(s.dirtyFiles).toContain("M electron/main.js");
    expect(s.tree).not.toBe(clean.tree);
  });

  test("cannot pass for one — casualty 1, the fix present in the tree and absent from HEAD", () => {
    // 9699619 was stamped on a binary that contained dd1f558's auth fix. The
    // stamp named the parent, so the security question could not be answered
    // from it. Here the same shape: the fix is on disk, HEAD does not have it.
    const dir = fixture();
    const parent = stampOf(dir);
    writeFileSync(join(dir, "server/src/index.ts"), "export const serve = () => requireAuth()\n");
    const s = stampOf(dir);
    expect(s.commit).toBe(parent.commit);   // HEAD really has not moved
    expect(s.stamp).not.toBe(parent.stamp); // and the stamp still refuses to repeat itself
    expect(s.dirtyFiles).toContain("M server/src/index.ts");

    // Committing that same content is a DIFFERENT build, and reads as one.
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "the auth fix");
    const child = stampOf(dir);
    expect(child.stamp).toMatch(LOOKS_LIKE_A_COMMIT);
    expect(child.stamp).not.toBe(parent.stamp);
  });

  test("a new file nobody has added yet counts", () => {
    const dir = fixture();
    const clean = stampOf(dir);
    writeFileSync(join(dir, "web/src/Brand.tsx"), "export const B = 1\n");
    const s = stampOf(dir);
    expect(s.dirty).toBe(true);
    expect(s.dirtyFiles).toContain("?? web/src/Brand.tsx");
    expect(s.tree).not.toBe(clean.tree);
  });

  test("a packaged file renamed OUT of the package counts", () => {
    // The hole the first version of this had, and it reintroduced the whole
    // bug: after `git mv electron/main.js docs/main.js` that path is in neither
    // `ls-files -c` nor `-o`, so a membership test against the enumerated file
    // list did not find it, filed the rename as an edit "outside the package",
    // and stamped a bare commit sha on a tree with a packaged file missing.
    // Two different trees, one stamp. Matching by prefix instead does not care
    // whether the path still exists.
    const dir = fixture();
    const clean = stampOf(dir);
    mkdirSync(join(dir, "docs"), { recursive: true });
    git(dir, "mv", "electron/main.js", "docs/main.js");
    const s = stampOf(dir);
    expect(s.tree).not.toBe(clean.tree);
    expect(s.dirty).toBe(true);
    expect(s.stamp).not.toMatch(LOOKS_LIKE_A_COMMIT);
    // Both ends named, because only the old one says what left.
    expect(s.dirtyFiles.join("\n")).toContain("electron/main.js");
  });

  test("a rename inside the package counts, and reads as a rename", () => {
    const dir = fixture();
    git(dir, "mv", "web/src/App.tsx", "web/src/Root.tsx");
    const s = stampOf(dir);
    expect(s.dirty).toBe(true);
    expect(s.dirtyFiles.join("\n")).toContain("web/src/App.tsx -> web/src/Root.tsx");
  });

  test("hiding a packaged file behind .gitignore counts", () => {
    // .gitignore is not shipped, but it decides which files the hash can see.
    // Left out of the closure, adding a line to it silently shrinks the tree
    // while the stamp goes on claiming the commit.
    const dir = fixture();
    const clean = stampOf(dir);
    appendFileSync(join(dir, ".gitignore"), "hooks/\n");
    const s = stampOf(dir);
    expect(s.tree).not.toBe(clean.tree);
    expect(s.dirty).toBe(true);
    expect(s.stamp).not.toMatch(LOOKS_LIKE_A_COMMIT);
  });

  test("a deleted file counts", () => {
    const dir = fixture();
    const clean = stampOf(dir);
    unlinkSync(join(dir, "hooks/hook.py"));
    const s = stampOf(dir);
    expect(s.dirty).toBe(true);
    expect(s.dirtyFiles).toContain("D hooks/hook.py");
    expect(s.tree).not.toBe(clean.tree);
  });

  test("says so loudly, and names the files, before anything is installed", () => {
    const dir = fixture();
    appendFileSync(join(dir, "electron/main.js"), "// x\n");
    const { stderr } = stampWithOutput(dir);
    expect(stderr).toContain("NOT A COMMIT");
    expect(stderr).toContain("electron/main.js");
  });
});

describe("no two trees share a stamp", () => {
  test("different content, different stamp; the same content, the same stamp", () => {
    const dir = fixture();
    appendFileSync(join(dir, "electron/main.js"), "// edit A\n");
    const a = stampOf(dir);
    writeFileSync(join(dir, "electron/main.js"), "// the electron shell\n// edit B\n");
    const b = stampOf(dir);
    expect(b.stamp).not.toBe(a.stamp);

    // Back to A's exact bytes: the stamp is a property of the tree, not of the
    // order things happened in, so it comes back.
    writeFileSync(join(dir, "electron/main.js"), "// the electron shell\n// edit A\n");
    expect(stampOf(dir).stamp).toBe(a.stamp);
  });

  test("the executable bit is part of the tree", () => {
    // bin/ and self-update.sh only work executable, so a mode change is a
    // different package even when every byte matches.
    const dir = fixture();
    const before = stampOf(dir);
    spawnSync("chmod", ["+x", join(dir, "electron/self-update.sh")]);
    expect(stampOf(dir).tree).not.toBe(before.tree);
  });
});

describe("the window between stamping and packaging", () => {
  // build.mjs necessarily runs before electron-builder copies the files. On a
  // worktree several sessions are editing, a save inside that window ships in a
  // package the stamp does not describe. --check-stamp is what closes it, and
  // callers run it before stopping anything, so refusing costs a rebuild rather
  // than an outage.
  test("an unmoved tree verifies", () => {
    const dir = fixture();
    stampOf(dir);
    expect(check(dir).status).toBe(0);
  });

  test("a tree that moved is caught, with both stamps named", () => {
    const dir = fixture();
    const packaged = stampOf(dir);
    appendFileSync(join(dir, "web/src/App.tsx"), "// saved mid-package\n");
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the tree changed while the package was being built");
    expect(r.stderr).toContain(packaged.stamp);
  });
});

describe("a checkout that cannot prove anything", () => {
  test("with no git, the stamp is unknown rather than a sha", () => {
    const dir = fixture();
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const { json, stderr } = stampWithOutput(dir);
    expect(json.stamp).toBe("unknown");
    expect(json.stamp).not.toMatch(LOOKS_LIKE_A_COMMIT);
    expect(json.dirty).toBe(true);
    expect(stderr).toContain("UNVERIFIABLE");
  });

  test("--check-stamp refuses to bless a stamp it cannot recompute", () => {
    const dir = fixture();
    stampOf(dir);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(check(dir).status).toBe(1);
  });
});

describe("what a release is allowed to call itself", () => {
  test("a clean build on a tag is that release", () => {
    const dir = fixture();
    git(dir, "tag", "-a", "v0.9.0", "-m", "release");
    const s = stampOf(dir);
    expect(s.baseTag).toBe("v0.9.0");
    expect(s.distance).toBe(0);
    expect(s.version).toBe("0.9.0");
  });

  test("a dirty build on a tag is not", () => {
    // `describe` says distance 0, which only ever meant "HEAD is on the tag".
    // Letting the tag win there is how a build carrying somebody's uncommitted
    // work gets to call itself v0.9.0 in the About pane.
    const dir = fixture();
    git(dir, "tag", "-a", "v0.9.0", "-m", "release");
    appendFileSync(join(dir, "electron/main.js"), "// not in v0.9.0\n");
    const s = stampOf(dir);
    expect(s.baseTag).toBe("v0.9.0");
    expect(s.version).not.toBe("0.9.0");
    expect(s.stamp).not.toMatch(LOOKS_LIKE_A_COMMIT);
  });
});
