/*
 * Source control on the phone: the parts of Branches and Stash that are
 * decisions rather than drawing.
 *
 * Deliberately not here: the commit graph, the reflog, worktrees, branch
 * delete and stash drop. The desktop has them; each is the next thing after
 * this and is not on the phone yet.
 */
import type { GitBranch } from "../../../shared/types.ts";

/** The segments, in reading order: what I changed, what I landed, where I can
 *  go, what I put aside, what is waiting for review. Short labels: five must
 *  fit one row at phone width. */
export const VIEWS = [
  { id: "changes", label: "Changes" },
  { id: "log", label: "Log" },
  { id: "branches", label: "Branches" },
  { id: "stash", label: "Stash" },
  { id: "pr", label: "PR" },
] as const;
export type ScmView = (typeof VIEWS)[number]["id"];

/** git's `[ahead 4, behind 53]` as the arrows the header already uses. */
export function trackWords(track: string): string {
  if (!track) return "";
  if (/gone/.test(track)) return "upstream gone";
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""].filter(Boolean).join(" ");
}

/** Where you are, then the rest as git listed them. */
export function orderBranches(list: GitBranch[]): GitBranch[] {
  return [...list.filter((b) => b.current), ...list.filter((b) => !b.current)];
}

/** The server's own rule for a ref name (`validRef` in server/src/gitwork.ts —
 *  keep the two in step), said before the round trip. */
export function newBranchProblem(raw: string, have: GitBranch[]): string | null {
  const name = raw.trim();
  if (!name) return "Type a name.";
  if (have.some((b) => b.name === name)) return `A branch called ${name} already exists.`;
  const ok = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(name) && !name.endsWith("/") && !name.endsWith(".lock");
  return ok ? null : "Use letters, digits and . _ / - only; no spaces, no \"..\", no leading dash.";
}

/** `WIP on feat/x: 1a2b3c4 subject` / `On main: message` split into the words
 *  a person wrote and the branch it was put aside from. */
export function stashTitle(message: string): { title: string; branch: string | null } {
  const m = /^(?:WIP on|On) ([^:]+): (?:[0-9a-f]{7,40} )?(.*)$/.exec(message);
  return m ? { title: m[2] || message, branch: m[1] ?? null } : { title: message, branch: null };
}

/** `fresh` in the order `prev` had it, anything new after. */
export function keepOrder<T extends { root: string }>(prev: T[], fresh: T[]): T[] {
  const at = new Map(prev.map((r, i) => [r.root, i]));
  return [...fresh].sort((a, b) => (at.get(a.root) ?? 1e9) - (at.get(b.root) ?? 1e9));
}
