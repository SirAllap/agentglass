/*
 * Two live sessions writing into one working tree.
 *
 * The Diff view groups by checkout, which is the right unit when every agent
 * has its own worktree — the section IS that agent's work. When two agents
 * write into the same checkout the section is both of them at once, and a file
 * both edited has one on-disk diff that no grouping can split by author. These
 * are the cases that decide whether the view says so or quietly doesn't:
 *
 *   * a file both sessions edited is the overlap — the part that is genuinely
 *     approximate — and a tree they both wrote to without overlapping files is
 *     still shared, because the section heading still names two authors;
 *   * `orbit` and `orbit-WEB-1042` are different trees even though one path is a
 *     prefix of the other, which is the mistake that lends one agent's edits to
 *     the wrong checkout;
 *   * a session that has gone away does not make a tree shared: what it left
 *     behind is history, not a second author at work;
 *   * with three authors, a file two of them edited names those two;
 *   * a session that ended with `/clear` is not a second author beside the one
 *     that replaced it;
 *   * nor is a live one whose edits in the tree have all been committed since.
 *
 * That the tree is where a session WROTE and not where it stands is pinned in
 * shared-tree-route.test.ts, where the sessions have a cwd to stand in.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeAuthors, liveSessions, physical, type TreeEdit } from "../src/sharedtree.ts";

const REPO = "/home/dev/code/orbit";
const WT = "/home/dev/code/orbit-WEB-1042";
const VENDOR = "/home/dev/code/orbit/vendor/lib";
const TREES = [{ path: REPO }, { path: WT }, { path: VENDOR }];

const edit = (session_id: string, file_path: string, timestamp: number): TreeEdit =>
  ({ session_id, file_path, timestamp });
const all = () => true;
/** The flag, as the Diff view raises it: a checkout with more than one author. */
const sharedTrees = (...a: Parameters<typeof treeAuthors>) => treeAuthors(...a).filter((t) => t.sessions.length > 1);

describe("sharedTrees", () => {
  test("two live sessions editing one file in one tree: shared, and that file is the overlap", () => {
    const out = sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 3),
      edit("b", `${REPO}/src/app.ts`, 2),
      edit("b", `${REPO}/README.md`, 1),
    ], TREES, all, all);
    expect(out).toHaveLength(1);
    expect(out[0]!.root).toBe(REPO);
    expect(out[0]!.sessions).toEqual(["a", "b"]);
    expect(out[0]!.overlap).toEqual([{ path: "src/app.ts", sessions: ["a", "b"] }]);
  });

  test("one tree, different files: still shared, with nothing in the overlap", () => {
    const out = sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("b", `${REPO}/src/other.ts`, 1),
    ], TREES, all, all);
    expect(out).toHaveLength(1);
    expect(out[0]!.overlap).toEqual([]);
  });

  test("a worktree whose path starts with the repo's is a different tree", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("b", `${WT}/src/app.ts`, 1),
    ], TREES, all, all)).toEqual([]);
  });

  test("the innermost checkout holds the file, not the repo around it", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("b", `${VENDOR}/index.ts`, 1),
    ], TREES, all, all)).toEqual([]);
  });

  test("a session that is no longer live does not make a tree shared", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("gone", `${REPO}/src/app.ts`, 1),
    ], TREES, (id) => id !== "gone", all)).toEqual([]);
  });

  test("a file outside every known checkout is not attributed to any", () => {
    expect(sharedTrees([
      edit("a", "/tmp/scratch.sh", 2),
      edit("b", "/tmp/scratch.sh", 1),
    ], TREES, all, all)).toEqual([]);
  });

  test("a hook with no session to its name is not an author", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("", `${REPO}/src/app.ts`, 1),
      edit("unknown", `${REPO}/src/app.ts`, 1),
    ], TREES, all, all)).toEqual([]);
  });

  test("sessions are listed newest writer first", () => {
    const out = sharedTrees([
      edit("old", `${REPO}/a.ts`, 1),
      edit("new", `${REPO}/b.ts`, 9),
      edit("mid", `${REPO}/c.ts`, 5),
    ], TREES, all, all);
    expect(out[0]!.sessions).toEqual(["new", "mid", "old"]);
  });

  test("with three authors, a file two of them edited names exactly those two", () => {
    const out = sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 3),
      edit("b", `${REPO}/src/other.ts`, 2),
      edit("c", `${REPO}/src/app.ts`, 1),
    ], TREES, all, all);
    expect(out[0]!.sessions).toEqual(["a", "b", "c"]);
    expect(out[0]!.overlap).toEqual([{ path: "src/app.ts", sessions: ["a", "c"] }]);
  });
});

describe("treeAuthors", () => {
  test("a checkout with one live author is listed too — that is the heading that can name who did the work", () => {
    const out = treeAuthors([
      edit("a", `${WT}/src/app.ts`, 2),
      edit("b", `${REPO}/src/app.ts`, 1),
    ], TREES, all, all);
    expect(out.map((t) => [t.root, t.sessions])).toEqual([
      [WT, ["a"]],
      [REPO, ["b"]],
    ]);
  });

  // A committed file is no longer a row in its section, so the session that
  // edited it has no work there left to be confused with anybody's.
  const onDisk = (...rows: string[]) => (root: string, rel: string) => rows.includes(`${root}/${rel}`);

  test("a live session whose edits here are all committed is not an author here", () => {
    const out = treeAuthors([
      edit("b", `${REPO}/src/app.ts`, 3),
      edit("a", `${WT}/src/app.ts`, 2),
      edit("a", `${REPO}/src/old.ts`, 1),
    ], TREES, all, onDisk(`${REPO}/src/app.ts`, `${WT}/src/app.ts`));
    expect(out.map((t) => [t.root, t.sessions])).toEqual([
      [REPO, ["b"]],
      [WT, ["a"]],
    ]);
  });

  test("one file of its still on disk keeps it an author, and a committed file both edited is no overlap", () => {
    const out = sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 4),
      edit("b", `${REPO}/src/app.ts`, 3),
      edit("b", `${REPO}/src/b.ts`, 2),
      edit("a", `${REPO}/src/a.ts`, 1),
    ], TREES, all, onDisk(`${REPO}/src/a.ts`, `${REPO}/src/b.ts`));
    expect(out).toHaveLength(1);
    expect(out[0]!.sessions).toEqual(["b", "a"]);
    expect(out[0]!.overlap).toEqual([]);
  });
});

describe("liveSessions", () => {
  const NOW = 10 * 60 * 60_000;
  test("heard from recently is live; quiet past the window is not", () => {
    const live = liveSessions([
      { session_id: "recent", last_seen: NOW - 60_000, gone: false },
      { session_id: "quiet", last_seen: NOW - 5 * 60 * 60_000, gone: false },
    ], new Set(), NOW);
    expect(live.has("recent")).toBe(true);
    expect(live.has("quiet")).toBe(false);
  });

  test("an agent still in a pane is live however long it has been waiting on a person", () => {
    const live = liveSessions([{ session_id: "waiting", last_seen: NOW - 5 * 60 * 60_000, gone: false }], new Set(["waiting"]), NOW);
    expect(live.has("waiting")).toBe(true);
  });

  test("a session that ended a minute ago is gone, not live for the rest of the window", () => {
    // `/clear`: the old session's SessionEnd is its last word, and the one that
    // replaced it in the same pane must not find it still sharing the tree.
    const live = liveSessions([
      { session_id: "cleared", last_seen: NOW - 60_000, gone: true },
      { session_id: "after", last_seen: NOW - 30_000, gone: false },
    ], new Set(), NOW);
    expect([...live]).toEqual(["after"]);
  });
});

describe("physical", () => {
  // git names a checkout by its physical path; a hook names a file by the path
  // the agent used. Through a symlinked directory the two never meet as strings.
  const box = mkdtempSync(join(tmpdir(), "agx-physical-"));
  const real = join(box, "real");
  mkdirSync(join(real, "src"), { recursive: true });
  symlinkSync(real, join(box, "link"));
  afterAll(() => rmSync(box, { recursive: true, force: true }));

  test("a file reached through a symlinked directory resolves to where git sees it", () => {
    // realpath of the expectation too: the temp dir is itself a symlink on macOS.
    expect(physical(join(box, "link", "src", "app.ts"))).toBe(join(realpathSync(real), "src", "app.ts"));
  });

  test("a file whose directory is gone keeps the path it was given", () => {
    expect(physical(join(box, "deleted", "app.ts"))).toBe(join(box, "deleted", "app.ts"));
  });
});
