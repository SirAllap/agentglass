/*
 * "The next file" is the next one you can SEE.
 *
 * Reported on a five-file branch: ticking Viewed on the first file jumped to the
 * fourth row of the rail. GitHub lists changed files alphabetically by full
 * path, the rail draws every directory before the loose files beside it, and
 * the two orders are not the same list — so "the next one", taken off the
 * arriving order, skipped two rows. `j` skipped them too.
 *
 * The fix is that the panel orders its files the way the rail paints them,
 * once, and everything downstream inherits it. This pins that order.
 */
import { describe, expect, it } from "bun:test";
import { buildFileTree, flattenTree, treeOrder } from "../src/lib/prFileTree.ts";

/** The reported branch, alphabetically by path — the order GitHub sends. */
const ARRIVED = [
  { path: "docs/reports/migration-notes.md" },
  { path: "pyproject.toml" },
  { path: "src/orbit/api/clients/tests/test_rest_views.py" },
  { path: "src/orbit/base/tests/test_utils.py" },
  { path: "uv.lock" },
];

const paths = (xs: { path: string }[]) => xs.map((x) => x.path);

describe("the order the changed files are read in", () => {
  it("is the rail's order: directories first, loose files after", () => {
    expect(paths(treeOrder(ARRIVED))).toEqual([
      "docs/reports/migration-notes.md",
      "src/orbit/api/clients/tests/test_rest_views.py",
      "src/orbit/base/tests/test_utils.py",
      "pyproject.toml",
      "uv.lock",
    ]);
  });

  it("makes the second file the second row — the bug was that it was the fourth", () => {
    const order = paths(treeOrder(ARRIVED));
    expect(order[1]).toBe("src/orbit/api/clients/tests/test_rest_views.py");
    expect(paths(ARRIVED)[1]).toBe("pyproject.toml"); // what it used to move to
  });

  it("keeps every file, once", () => {
    const order = paths(treeOrder(ARRIVED));
    expect(order.length).toBe(ARRIVED.length);
    expect(new Set(order).size).toBe(ARRIVED.length);
  });

  it("is settled: ordering an ordered list changes nothing", () => {
    // The tree is rebuilt from `shownFiles` on every render, and `shownFiles` is
    // now already in this order — a rule that reshuffled its own output would
    // move the rail under the reader on a filter keystroke.
    expect(paths(treeOrder(treeOrder(ARRIVED)))).toEqual(paths(treeOrder(ARRIVED)));
  });

  it("meets directories in the order their first file arrives", () => {
    const order = paths(treeOrder([
      { path: "zeta/a.ts" },
      { path: "alpha/b.ts" },
      { path: "root.md" },
    ]));
    expect(order).toEqual(["zeta/a.ts", "alpha/b.ts", "root.md"]);
  });

  it("walks a nested tree depth-first, files of a directory after its subdirectories", () => {
    const order = paths(treeOrder([
      { path: "web/src/lib/a.ts" },
      { path: "web/src/b.ts" },
      { path: "web/top.ts" },
    ]));
    expect(order).toEqual(["web/src/lib/a.ts", "web/src/b.ts", "web/top.ts"]);
  });

  it("flattens what the tree holds, collapsed runs included", () => {
    // `web/src/lib` is drawn as one row; collapsing it must not lose the file.
    const tree = buildFileTree([{ path: "web/src/lib/only.ts" }]);
    expect(paths(flattenTree(tree))).toEqual(["web/src/lib/only.ts"]);
  });

  it("has nothing to say about an empty change", () => {
    expect(treeOrder([])).toEqual([]);
  });
});
