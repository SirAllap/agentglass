/** What "Show what is in it" opens for a stash: its commit, because the diff
 *  route takes a hash and `stash@{0}` is not one. Null for a stash the server
 *  gave no hash for. */
export function stashDetailTarget(s: { ref: string; message: string; hash?: string }): { hash: string; title: string } | null {
  return s.hash ? { hash: s.hash, title: `${s.ref} · ${s.message}` } : null;
}
