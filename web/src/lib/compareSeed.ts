/**
 * The other side a compare opens on: the current branch, so "compare with the
 * current branch" means that. Null (let the modal auto-pick) on a detached HEAD,
 * when the row compared IS the current branch, or when the branch is not in the
 * ref menu.
 */
export function initialOtherFor(current: string | null | undefined, base: string, refs: readonly string[]): string | null {
  if (!current || current === base || !refs.includes(current)) return null;
  return current;
}

/** What a remote row compares: the full ref (`origin/feat/x`), because the short
 *  name (`feat/x`) is not a ref in a checkout that has no local branch of it. */
export function remoteCompareRef(b: { ref: string }): string {
  return b.ref;
}

/** The base menu's options. The base is always one of them: a select whose value
 *  is not an option shows its first option while state still holds the other. */
export function baseOptions(refs: readonly string[], base: string): string[] {
  return !base || refs.includes(base) ? [...refs] : [base, ...refs];
}
