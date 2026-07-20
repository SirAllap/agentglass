import { test, expect } from "bun:test";
import { buildFileTree, allDirPaths, visibleRows, type TreeDir } from "../src/lib/fileTree.ts";
import type { GitFileChange } from "../../shared/types.ts";

const change = (p: string) => ({ file_path: p }) as GitFileChange;
const rel = (c: GitFileChange) => c.file_path;
const tree = (...paths: string[]) => buildFileTree(paths.map(change), rel);

test("nests paths into directories", () => {
  const t = tree("server/src/chat.ts", "server/src/db.ts", "Makefile");
  // Directories sort before loose files.
  expect(t.map((n) => n.name)).toEqual(["server", "Makefile"]);
  const server = t[0] as TreeDir;
  expect(server.kind).toBe("dir");
  const src = server.children[0] as TreeDir;
  expect(src.name).toBe("src");
  expect(src.children.map((c) => c.name)).toEqual(["chat.ts", "db.ts"]);
});

test("counts every file at or below a directory", () => {
  const t = tree("a/b/c/one.ts", "a/b/two.ts", "a/three.ts");
  const a = t[0] as TreeDir;
  expect(a.count).toBe(3);
  expect((a.children[0] as TreeDir).count).toBe(2); // a/b
});

test("sorts alphabetically within a kind, directories first", () => {
  const t = tree("z.ts", "a.ts", "beta/x.ts", "alpha/y.ts");
  expect(t.map((n) => n.name)).toEqual(["alpha", "beta", "a.ts", "z.ts"]);
});

test("a file at the repo root has no directory row", () => {
  const t = tree("README.md");
  expect(t).toHaveLength(1);
  expect(t[0].kind).toBe("file");
});

test("collapsed directories hide their descendants", () => {
  const t = tree("server/src/chat.ts", "server/src/db.ts", "Makefile");
  const open = visibleRows(t, new Set());
  // server, src, chat.ts, db.ts, Makefile
  expect(open).toHaveLength(5);

  const shut = visibleRows(t, new Set(["server"]));
  // The collapsed directory is still a row — just a single stop, so j/k can
  // land on it and reopen it.
  expect(shut.map((r) => r.node.name)).toEqual(["server", "Makefile"]);
});

test("depth reflects nesting, for indentation", () => {
  const rows = visibleRows(tree("a/b/c.ts"), new Set());
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
});

test("allDirPaths finds every directory, at any depth", () => {
  expect(allDirPaths(tree("a/b/c.ts", "d/e.ts")).sort()).toEqual(["a", "a/b", "d"]);
});

test("ignores empty paths rather than inventing a blank row", () => {
  expect(tree("")).toHaveLength(0);
});

test("a leading slash doesn't create an unnamed root directory", () => {
  const t = tree("/abs/path.ts");
  expect(t[0].name).toBe("abs");
});

// The navigation bug this ordering fixes: j/k walked git's own order (staged,
// then unstaged, with untracked trailing) while the eye followed the tree
// (directories first, alphabetical). On a repo with untracked files that read
// as the cursor jumping between them as a separate run.
test("visible order is what the tree renders, not the input order", () => {
  // git's order: a loose file, then two under a directory, untracked last.
  const t = tree("zebra.ts", "server/src/b.ts", "server/src/a.ts", "docs/plan.md");
  const files = visibleRows(t, new Set())
    .filter((r) => r.node.kind === "file")
    .map((r) => r.node.name);
  // Directories first (docs before server), alphabetical within, loose file last.
  expect(files).toEqual(["plan.md", "a.ts", "b.ts", "zebra.ts"]);
});

test("a folded directory takes its files out of the walk", () => {
  const t = tree("server/src/a.ts", "server/src/b.ts", "top.ts");
  const files = visibleRows(t, new Set(["server"]))
    .filter((r) => r.node.kind === "file")
    .map((r) => r.node.name);
  expect(files).toEqual(["top.ts"]);
});
