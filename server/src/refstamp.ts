// What a repository's local refs look like on disk, as one string that moves
// when any of them moves: read with stat, no git. The pattern gitwork.ts's
// auto-fetch uses for remote refs (remoteRefsStamp): a git call whose answer
// depends only on refs is asked again only when this string changes.
//
// What moves when a ref moves: git writes a loose ref as a lock file renamed
// over the old one (a new inode and mtime), deletes it when the ref goes,
// rewrites packed-refs whole, and appends to reftable's list. Files, not
// directories: a directory's mtime moves on every lock file git makes and drops.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const fileStamp = async (p: string): Promise<string> => {
  try { const st = await stat(p); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return "-"; }
};

async function walk(d: string, parts: string[]): Promise<void> {
  let ents;
  try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(d, e.name);
    if (e.isDirectory()) await walk(p, parts);
    else parts.push(`${p} ${await fileStamp(p)}`);
  }
}

/**
 * Local branches, the primary HEAD, packed-refs, reftable, and every linked
 * worktree's HEAD (so a worktree added, removed or switched moves it too).
 * `common` is the repository's shared `.git`.
 */
export async function localRefsStamp(common: string): Promise<string> {
  const parts = [
    await fileStamp(join(common, "HEAD")),
    await fileStamp(join(common, "packed-refs")),
    await fileStamp(join(common, "reftable", "tables.list")),
  ];
  await walk(join(common, "refs", "heads"), parts);
  let trees: string[] = [];
  try { trees = (await readdir(join(common, "worktrees"))).sort(); } catch { /* none */ }
  for (const t of trees) parts.push(`wt ${t} ${await fileStamp(join(common, "worktrees", t, "HEAD"))}`);
  return parts.join("\n");
}
