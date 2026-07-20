// A flat list of changed paths, read as the directory tree it actually is.
//
// A repo-wide change touches paths that share almost all of their length —
// `server/src/chat.ts`, `server/src/config.ts`, `server/src/db.ts`. Rendered
// flat, the eye has to diff thirty near-identical strings to find the one part
// that differs, and the shape of the change (three files in one module, one
// stray file elsewhere) is invisible. Nesting turns that into structure you
// read at a glance, which is why lazygit defaults to it.
//
// Deliberately a pure function over the change list: no React, no git, so the
// tree can be unit-tested on its own and rebuilt cheaply on every poll.

import type { GitFileChange } from "../../../shared/types.ts";

export interface TreeFile {
  kind: "file";
  /** Just the last segment — the directory rows carry the rest. */
  name: string;
  /** Full path, still the identity everywhere else in the panel. */
  path: string;
  change: GitFileChange;
}
export interface TreeDir {
  kind: "dir";
  name: string;
  /** Full path of the directory, used as the collapse key. */
  path: string;
  children: TreeNode[];
  /** Files at or below this directory — what the collapsed row summarises. */
  count: number;
}
export type TreeNode = TreeDir | TreeFile;

/**
 * Build the tree, directories before files and each group alphabetical.
 *
 * Directories first is the convention every file browser uses, and it keeps a
 * deep module from being buried under the loose files that happen to sort
 * before it. Sorting is by name rather than by change size on purpose: the list
 * is a map you navigate, so it has to stay in the same order between polls.
 */
export function buildFileTree(changes: GitFileChange[], relOf: (c: GitFileChange) => string): TreeNode[] {
  const root: TreeDir = { kind: "dir", name: "", path: "", children: [], count: 0 };

  for (const change of changes) {
    const rel = relOf(change);
    if (!rel) continue;
    const parts = rel.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    let dir = root;
    dir.count++;
    for (const part of parts) {
      const path = dir.path ? `${dir.path}/${part}` : part;
      let next = dir.children.find((c): c is TreeDir => c.kind === "dir" && c.name === part);
      if (!next) {
        next = { kind: "dir", name: part, path, children: [], count: 0 };
        dir.children.push(next);
      }
      next.count++;
      dir = next;
    }
    dir.children.push({ kind: "file", name: fileName, path: rel, change });
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
    for (const n of nodes) if (n.kind === "dir") sort(n.children);
    return nodes;
  };
  return sort(root.children);
}

/** Every directory path in the tree — what "expand all" has to know about, and
 *  what "collapse all" fills the collapsed set with. */
export function allDirPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "dir") { out.push(n.path); allDirPaths(n.children, out); }
  }
  return out;
}

/**
 * Flatten to the rows actually on screen, skipping anything inside a collapsed
 * directory.
 *
 * Returning a flat array rather than rendering recursively is what lets the
 * keyboard layer treat the tree as one list: j/k move by visible row, and a
 * collapsed directory is a single stop rather than a hidden sub-list the cursor
 * can fall into.
 */
export function visibleRows(
  nodes: TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
  out: { node: TreeNode; depth: number }[] = []
): { node: TreeNode; depth: number }[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "dir" && !collapsed.has(node.path)) visibleRows(node.children, collapsed, depth + 1, out);
  }
  return out;
}
