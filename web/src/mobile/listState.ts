/**
 * Which of several situations an empty list is actually in.
 *
 * `listPrs` answers with `needsAuth`, `error`, `loading`, `prs`, `hasNext` and
 * `total`. The phone kept `.prs` and dropped the rest, so four different
 * situations all rendered as "No open pull requests. Nothing is waiting to
 * land": gh missing or logged out, the request failing, a cache that had not
 * warmed, and there genuinely being none. Only the last of those is true, and
 * only the first two are things you could act on.
 *
 * A wrong answer delivered in the voice reserved for right ones is worse than
 * an error, because there is nothing to react to.
 *
 * This is a function rather than a ternary in the markup so it can be tested as
 * data — the first version of the guard for it asserted that the words "GitHub
 * is not signed in" appeared in the file, which stayed true when the branch
 * that shows them was disabled.
 */

export type ListState =
  /** gh is missing or logged out. Fixable, and the fix is a command. */
  | { kind: "needs-auth" }
  /** The request failed, and we can say how. */
  | { kind: "error"; message: string }
  /** The server is fetching behind its own response; ask again shortly. */
  | { kind: "loading" }
  /** It really is empty. */
  | { kind: "empty" }
  /** Rows, and whether they are all of them. */
  | { kind: "rows"; truncated: boolean };

export interface ListLike {
  prs?: unknown[];
  needsAuth?: boolean;
  error?: string;
  loading?: boolean;
  hasNext?: boolean;
}

/**
 * Order matters. `needsAuth` outranks everything: a signed-out gh also reports
 * zero rows and often an error, and naming the underlying cause is the only one
 * of the three that leads anywhere. `loading` only wins while there is nothing
 * to show — once rows have arrived, a background refresh is not a reason to
 * take them off the screen.
 */
export function listState(r: ListLike | null | undefined): ListState {
  if (!r) return { kind: "loading" };
  if (r.needsAuth) return { kind: "needs-auth" };
  const rows = r.prs?.length ?? 0;
  if (r.error && !rows) return { kind: "error", message: r.error };
  if (rows) return { kind: "rows", truncated: !!r.hasNext };
  if (r.loading) return { kind: "loading" };
  return { kind: "empty" };
}

/** What docker said, when it said anything. */
export type DockerState =
  | { kind: "unavailable"; message: string }
  | { kind: "empty" }
  | { kind: "rows" };

export function dockerState(
  d: { available: boolean; error: string | null } | undefined,
  count: number,
): DockerState {
  // "The daemon is down" and "this project has nothing running" are different
  // facts, and only one of them is something you can do anything about.
  if (d && !d.available) {
    return {
      kind: "unavailable",
      message: d.error || "agentglass cannot reach the docker daemon, so it cannot tell you what is running.",
    };
  }
  return count ? { kind: "rows" } : { kind: "empty" };
}
