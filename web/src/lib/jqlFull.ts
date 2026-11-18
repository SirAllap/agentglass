/* Enter on a JQL box asks the site for every page; typing alone asks for the first. A seam between the box and the list's read. */
const subs = new Set<(q: string) => void>();
export const askFullJql = (q: string): void => { for (const f of subs) f(q); };
export function onFullJql(f: (q: string) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
