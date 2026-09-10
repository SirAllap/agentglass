/*
 * WHEN EACH SEAT WAS LAST WOKEN — a leaf, so two modules can ask without
 * importing each other.
 *
 * `seatwake.ts` writes it and `seat.ts` reads it for the view's dial, and
 * having either import the other made a cycle: the wake needs the seats, the
 * seats need the wake. One map with no dependencies breaks it.
 *
 * In memory on purpose. After a restart nothing has been told anything yet,
 * and the first look wakes every seat once, which is the right answer rather
 * than a stale timestamp claiming somebody was spoken to.
 */
const woken = new Map<string, { fingerprint: string; at: number }>();

export const wokenFor = (root: string) => woken.get(root) ?? null;
export const noteWoken = (root: string, fingerprint: string, at: number) => { woken.set(root, { fingerprint, at }); };
export const lastWoken = (root: string): number | null => woken.get(root)?.at ?? null;
export const __resetWoken = () => woken.clear();
