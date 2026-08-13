// The changed files of a pull request, read as the directory tree they are —
// and, from that same tree, the order they are actually looked at in.
//
// Pure and out of PrPanel.tsx so both can be unit-tested: the grouping is what
// the file rail draws, and the flattening is what "the next file" means for
// every way there is to move through a review (j/k, the Viewed tick, and the
// stack of diffs itself).

/** A directory of the change, with its subdirectories and the files directly
 *  inside it. Generic over the file so the tree owes nothing to the panel. */
export type TreeNode<T extends { path: string }> = {
  name: string;
  path: string;
  dirs: Map<string, TreeNode<T>>;
  files: T[];
};

/** Group changed paths into directories, then collapse the runs of single-child
 *  directories the way GitHub does (`web/src/lib` on one row, not three). */
export function buildFileTree<T extends { path: string }>(files: T[]): TreeNode<T> {
  const root: TreeNode<T> = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) { next = { name: dir, path: node.path ? `${node.path}/${dir}` : dir, dirs: new Map(), files: [] }; node.dirs.set(dir, next); }
      node = next;
    }
    node.files.push(f);
  }
  const squash = (n: TreeNode<T>): TreeNode<T> => {
    let cur = n;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0]!;
      cur = { ...only, name: `${cur.name}/${only.name}`.replace(/^\//, "") };
    }
    return { ...cur, dirs: new Map([...cur.dirs].map(([k, v]) => [k, squash(v)])) };
  };
  return { ...root, dirs: new Map([...root.dirs].map(([k, v]) => [k, squash(v)])) };
}

/**
 * The files in the order the rail paints them: top to bottom.
 *
 * Not the order they arrive in. GitHub lists changed files alphabetically by
 * full path, and the tree draws every directory before the loose files beside
 * it — so on a branch of `docs/…`, `pyproject.toml`, `src/…`, `uv.lock` the
 * second row you see is a file that is third in the list, and the second file
 * in the list is the fourth row. Anything that means "the next one" off the
 * arriving order therefore skips: ticking Viewed on the first file jumped to
 * the fourth, and so did j.
 *
 * Directories first, in the order they were met, then the files sitting
 * directly in this one — which is exactly what `FileTree` renders, and the
 * reason this reads it off the built tree instead of restating the rule.
 */
export function flattenTree<T extends { path: string }>(node: TreeNode<T>): T[] {
  const out: T[] = [];
  for (const dir of node.dirs.values()) out.push(...flattenTree(dir));
  out.push(...node.files);
  return out;
}

/** The changed files, ordered the way they are read. */
export function treeOrder<T extends { path: string }>(files: T[]): T[] {
  return flattenTree(buildFileTree(files));
}
