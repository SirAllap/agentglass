// The server's word that a pull request event reached a repository Polaris follows.
// Windows that show Polaris subscribe while they are open; nothing here is a timer that
// asks: a burst of events (a suite finishing on several pull requests) is told once.
const subs = new Set<() => void>();
let pending: ReturnType<typeof setTimeout> | null = null;
export const POLARIS_QUIET_MS = 400;
export const onPolarisChanged = (fn: () => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
export function publishPolarisChanged(): void {
  if (pending) return;
  pending = setTimeout(() => { pending = null; for (const fn of subs) fn(); }, POLARIS_QUIET_MS);
}
