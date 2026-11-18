/* A live tab was re-rooted (frame `tabroot`): whoever draws that tab's footer re-reads its pane at once. */
export type TabRootNote = { paneId: string; name: string; cwd: string };
const subs = new Set<(n: TabRootNote) => void>();
export function publishTabRoot(n: TabRootNote): void { for (const fn of subs) fn(n); }
export function onTabRoot(fn: (n: TabRootNote) => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; }
