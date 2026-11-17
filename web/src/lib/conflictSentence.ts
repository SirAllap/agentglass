/*
 * The one place that decides what a refused card write says. The server names
 * what moved ("This card changed while you had it open: its status is now
 * Done. Reloaded") when it can. When it cannot — no baseline, an older server,
 * a tracker 409 — the caller shows its own generic line. Three screens used to
 * each pick for themselves; now they ask here.
 */

const NAMED = /^(This card changed while you had it open: .{1,400}?)(?:[.,] ?Reloaded)?$/i;

/** The server's sentence about WHAT moved, without its trailing "Reloaded"; null when it gave none. */
export function whatMoved(error: string | undefined | null): string | null {
  const m = NAMED.exec((error ?? "").trim());
  return m ? m[1]!.replace(/[.\s]+$/, "") : null;
}
