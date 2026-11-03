// What the anchored error card says when fetch, pull or push fails: a title in
// plain words, one sentence of what happened and what to do next, git's own
// lines underneath, and the one button that moves forward. The command log
// keeps the full text; the card never claims more than the stderr shows.
import type { RemoteOp } from "./gitHeader.ts";

export type FailKind = "unreachable" | "auth" | "rejected" | "diverged" | "overwrite" | "conflict" | "no-upstream" | "hook" | "other";

export function failKind(raw: string): FailKind {
  if (/\[rejected\]|fetch first|non-fast-forward|tip of your current branch is behind/i.test(raw) && !/not possible to fast-forward/i.test(raw)) return "rejected";
  if (/not possible to fast-forward|divergent branches|need to specify how to reconcile/i.test(raw)) return "diverged";
  if (/would be overwritten by (merge|checkout)|local changes.*overwritten|unstaged changes|commit your changes or stash/i.test(raw)) return "overwrite";
  if (/^CONFLICT|Automatic merge failed/im.test(raw)) return "conflict";
  if (/no tracking information|no upstream|has no upstream branch|no such ref was fetched/i.test(raw)) return "no-upstream";
  if (/permission denied|authentication failed|could not read username|publickey|access denied|403/i.test(raw)) return "auth";
  if (/pre-receive|remote rejected|protected branch|hook declined/i.test(raw)) return "hook";
  if (/could not resolve host|connection (timed out|refused|reset)|unable to access|could not read from remote|network is unreachable|no route to host|operation timed out/i.test(raw)) return "unreachable";
  return "other";
}

const NOISE = /^(hint:|Recorded preimage|Recorded resolution)/;

/** Git's own lines, the decisive few, for the pre under the sentence. */
export function rawLines(raw: string, max = 4): string {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  return lines.slice(0, max).map((l) => l.length > 240 ? `${l.slice(0, 239)}…` : l).join("\n");
}

export type NextId = "retry" | "pull-then-push" | "open-remotes" | "none";

export interface FailCard {
  op: RemoteOp;
  title: string;
  /** One sentence: what happened, and what to do. */
  body: string | null;
  raw: string;
  /** The button that moves forward; the card also always offers the command log. */
  next: { id: NextId; label: string };
  /** Fetch only: one row per remote, in the order they ran. */
  rows?: { remote: string; ok: boolean; note: string }[];
}

const s = (n: number) => (n === 1 ? "" : "s");

export interface PushCtx { branch: string; ahead: number; behind: number; remote: string }
export interface PullCtx { branch: string; upstream: string | null }

export function pushCard(raw: string, c: PushCtx): FailCard {
  const base = { op: "push" as const, raw: rawLines(raw) };
  switch (failKind(raw)) {
    case "rejected":
      return { ...base,
        title: c.behind > 0 ? `${c.remote} has ${c.behind} commit${s(c.behind)} you don't have` : `${c.remote} has commits you don't have`,
        body: `Your ${c.ahead > 0 ? `${c.ahead} commit${s(c.ahead)} ${c.ahead === 1 ? "was" : "were"}` : "commits were"} not sent. Bring the new ${c.behind === 1 ? "one" : "ones"} down first, then push again.`,
        next: { id: "pull-then-push", label: "Pull, then push" } };
    case "unreachable":
      return { ...base, title: `${c.remote} could not be reached`, body: "Nothing was sent. Check the connection or the remote's address, then try again.", next: { id: "retry", label: `Try ${c.remote} again` } };
    case "auth":
      return { ...base, title: `${c.remote} refused the credentials`, body: "Nothing was sent. Sign in to the host or fix the key, then push again.", next: { id: "open-remotes", label: "Open Remotes" } };
    case "hook":
      return { ...base, title: `${c.remote} declined ${c.branch}`, body: "The host's rules refused this push, often a protected branch. Push a different branch and open a pull request.", next: { id: "none", label: "" } };
    case "no-upstream":
      return { ...base, title: `${c.branch} has no upstream`, body: `Nothing was sent. Publish ${c.branch} to ${c.remote} to start tracking it.`, next: { id: "retry", label: `Publish to ${c.remote}` } };
    default:
      return { ...base, title: "The push did not go through", body: null, next: { id: "retry", label: "Try again" } };
  }
}

export function pullCard(raw: string, c: PullCtx): FailCard {
  const base = { op: "pull" as const, raw: rawLines(raw) };
  const up = c.upstream ?? "its upstream";
  switch (failKind(raw)) {
    case "diverged":
      return { ...base, title: `${c.branch} and ${up} have diverged`, body: "Pull only fast-forwards. Merge or rebase them from the Branches tab, then push.", next: { id: "none", label: "" } };
    case "overwrite":
      return { ...base, title: "Your changes are in the way", body: "Pulling would overwrite uncommitted work. Commit or stash it, then pull again.", next: { id: "none", label: "" } };
    case "conflict":
      return { ...base, title: "The pull stopped on conflicts", body: "Resolve the conflicted files, then continue or abort.", next: { id: "none", label: "" } };
    case "unreachable":
      return { ...base, title: "The remote could not be reached", body: "Nothing was pulled. Check the connection, then try again.", next: { id: "retry", label: "Try again" } };
    case "auth":
      return { ...base, title: "The remote refused the credentials", body: "Nothing was pulled. Sign in to the host or fix the key, then try again.", next: { id: "open-remotes", label: "Open Remotes" } };
    case "no-upstream":
      return { ...base, title: `${c.branch} has no upstream`, body: "There is nothing to pull from. Push it first, or set an upstream.", next: { id: "none", label: "" } };
    default:
      return { ...base, title: "The pull did not go through", body: null, next: { id: "retry", label: "Try again" } };
  }
}

const rowNote = (raw: string): string => {
  switch (failKind(raw)) {
    case "unreachable": return "no answer from the host";
    case "auth": return "refused the credentials";
    default: return rawLines(raw, 1) || "failed";
  }
};

/** The remotes a fetch card lists as failed: what "try again" retries, all of them. */
export const failedRemotes = (c: FailCard): string[] => (c.rows ?? []).filter((r) => !r.ok).map((r) => r.remote);

export function fetchCard(results: { remote: string; ok: boolean; error?: string }[]): FailCard | null {
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return null;
  const first = bad[0]!;
  const only = bad.length === 1;
  const kind = failKind(first.error ?? "");
  return {
    op: "fetch",
    title: only
      ? (kind === "unreachable" ? `${first.remote} could not be reached` : `${first.remote} could not be fetched`)
      : `${bad.length} remotes could not be fetched`,
    body: null,
    raw: rawLines(first.error ?? ""),
    next: { id: "retry", label: only ? `Try ${first.remote} again` : "Try the failed remotes again" },
    rows: results.map((r) => ({ remote: r.remote, ok: r.ok, note: r.ok ? "fetched" : rowNote(r.error ?? "") })),
  };
}
