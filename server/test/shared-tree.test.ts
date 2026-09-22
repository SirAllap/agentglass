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
 *   * the tree is where the session WROTE, not where it stands. An agent that
 *     sits in the parent repo and reaches into a worktree with absolute paths is
 *     that worktree's author, and five agents standing in one parent while each
 *     writes to its own checkout are not sharing anything.
 */
import { describe, expect, test } from "bun:test";
import { treeAuthors, liveSessions, type TreeEdit } from "../src/sharedtree.ts";

const REPO = "/home/dev/code/orbit";
const WT = "/home/dev/code/orbit-WEB-1042";
const VENDOR = "/home/dev/code/orbit/vendor/lib";
const TREES = [
  { path: REPO, branch: "main" },
  { path: WT, branch: "feat/web-1042" },
  { path: VENDOR, branch: "main" },
];

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
    ], TREES, all);
    expect(out).toHaveLength(1);
    expect(out[0]!.root).toBe(REPO);
    expect(out[0]!.branch).toBe("main");
    expect(out[0]!.sessions).toEqual(["a", "b"]);
    expect(out[0]!.overlap).toEqual(["src/app.ts"]);
  });

  test("one tree, different files: still shared, with nothing in the overlap", () => {
    const out = sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("b", `${REPO}/src/other.ts`, 1),
    ], TREES, all);
    expect(out).toHaveLength(1);
    expect(out[0]!.overlap).toEqual([]);
  });

  test("a worktree whose path starts with the repo's is a different tree", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("b", `${WT}/src/app.ts`, 1),
    ], TREES, all)).toEqual([]);
  });

  test("the innermost checkout holds the file, not the repo around it", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("b", `${VENDOR}/index.ts`, 1),
    ], TREES, all)).toEqual([]);
  });

  test("a session that is no longer live does not make a tree shared", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("gone", `${REPO}/src/app.ts`, 1),
    ], TREES, (id) => id !== "gone")).toEqual([]);
  });

  test("where it writes decides, not where it stands: agents in one parent writing to their own worktrees share nothing", () => {
    // Both of these agents' cwd is REPO. Neither wrote there.
    expect(sharedTrees([
      edit("a", `${WT}/src/app.ts`, 2),
      edit("b", `${VENDOR}/index.ts`, 1),
    ], TREES, all)).toEqual([]);
  });

  test("a file outside every known checkout is not attributed to any", () => {
    expect(sharedTrees([
      edit("a", "/tmp/scratch.sh", 2),
      edit("b", "/tmp/scratch.sh", 1),
    ], TREES, all)).toEqual([]);
  });

  test("a hook with no session to its name is not an author", () => {
    expect(sharedTrees([
      edit("a", `${REPO}/src/app.ts`, 2),
      edit("", `${REPO}/src/app.ts`, 1),
      edit("unknown", `${REPO}/src/app.ts`, 1),
    ], TREES, all)).toEqual([]);
  });

  test("sessions are listed newest writer first", () => {
    const out = sharedTrees([
      edit("old", `${REPO}/a.ts`, 1),
      edit("new", `${REPO}/b.ts`, 9),
      edit("mid", `${REPO}/c.ts`, 5),
    ], TREES, all);
    expect(out[0]!.sessions).toEqual(["new", "mid", "old"]);
  });
});

describe("treeAuthors", () => {
  test("a checkout with one live author is listed too — that is the heading that can name who did the work", () => {
    const out = treeAuthors([
      edit("a", `${WT}/src/app.ts`, 2),
      edit("b", `${REPO}/src/app.ts`, 1),
    ], TREES, all);
    expect(out.map((t) => [t.root, t.branch, t.sessions])).toEqual([
      [WT, "feat/web-1042", ["a"]],
      [REPO, "main", ["b"]],
    ]);
  });
});

describe("liveSessions", () => {
  const NOW = 10 * 60 * 60_000;
  test("heard from recently is live; quiet past the window is not", () => {
    const live = liveSessions([
      { session_id: "recent", last_seen: NOW - 60_000 },
      { session_id: "quiet", last_seen: NOW - 5 * 60 * 60_000 },
    ], new Set(), NOW);
    expect(live.has("recent")).toBe(true);
    expect(live.has("quiet")).toBe(false);
  });

  test("an agent still in a pane is live however long it has been waiting on a person", () => {
    const live = liveSessions([{ session_id: "waiting", last_seen: NOW - 5 * 60 * 60_000 }], new Set(["waiting"]), NOW);
    expect(live.has("waiting")).toBe(true);
  });
});
