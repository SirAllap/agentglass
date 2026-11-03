// What the Branches, Remotes and Tags tabs decide before they draw: the dock's
// selection, the one sentence of an error frame, and the "is it on the remote"
// chip. Pure, so the decisions are tested where there is no renderer.
import type { GitRemoteBranch, GitStash, GitTag, GitTagOrigin, GitWorktree } from "../../../shared/types.ts";
import { plainGitError } from "./gitActions.ts";
import type { DockSelection } from "./gitDock.ts";
import type { Tone } from "../components/git/ui.tsx";

/** One plain sentence for an error frame (F18). The raw text goes to the console, never the frame. */
export function frameSentence(raw: string, remote?: string): string {
  if (/could not resolve|could not read from remote|unable to access|connection (refused|timed out|reset)|timed out|network is unreachable/i.test(raw))
    return `Could not reach ${remote || "the remote"}.`;
  if (/Unable to create '[^']*\.lock'|another git process/i.test(raw))
    return "Another git process holds the lock. The list refreshes by itself when it lets go.";
  if (/^(error|fatal):|^CONFLICT|not fully merged/im.test(raw)) {
    const why = plainGitError(raw, true).replace(/[.\s]+$/, "");
    return `git refused: ${why}.`;
  }
  return "Something went wrong. Try again.";
}

const G4_VIEWS = new Set(["branches", "remotes", "tags", "submodules", "worktrees", "stashes", "tidy"]);

/** A failure's toast: on the G4 tabs one plain sentence (F18), elsewhere git's line as before. */
export function failToast(view: string, raw: string, remote?: string): string {
  return G4_VIEWS.has(view) ? frameSentence(raw, remote) : plainGitError(raw);
}

/** A row of the branch list, as far as the dock cares. */
export interface BranchPick {
  name: string; isCurrent: boolean; held: boolean;
  ahead: number; behind: number; hasUpstream: boolean; busy?: boolean;
}

/** Ticked rows win over the cursor: the dock acts on what the person ticked. */
export function branchSelection(
  ticked: readonly string[], cursor: BranchPick | undefined, byName: (n: string) => BranchPick | undefined,
): DockSelection {
  if (ticked.length > 1) {
    const heldNames = ticked.filter((n) => { const p = byName(n); return !!p && (p.isCurrent || p.held); });
    return { count: ticked.length, names: ticked, heldNames };
  }
  const one = ticked.length === 1 ? byName(ticked[0]) ?? cursor : cursor;
  if (!one) return { count: 0 };
  return {
    count: 1, name: one.name, isCurrent: one.isCurrent, branchHeld: one.held, busy: one.busy,
    ahead: one.ahead, behind: one.behind, upstream: one.hasUpstream,
  };
}

export function remoteSelection(b: GitRemoteBranch | undefined, root: string): DockSelection {
  if (!b) return { count: 0 };
  return { count: 1, name: b.ref, localCopy: b.local, branchHeld: !!b.worktree && b.worktree !== root };
}

export function tagSelection(t: GitTag | undefined, origin: GitTagOrigin | undefined): DockSelection {
  if (!t) return { count: 0 };
  return { count: 1, name: t.name, tagOnOrigin: origin?.onOrigin ?? "unknown" };
}

/** The chip on a tag row. No chip when no remote was asked (`origin` undefined). */
export function tagOriginChip(origin: GitTagOrigin | undefined): { label: string; tone: Tone } | null {
  if (!origin) return null;
  if (origin.onOrigin === "yes") return { label: `on ${origin.remote ?? "origin"}`, tone: "good" };
  if (origin.onOrigin === "no") return { label: "only here", tone: "warn" };
  return { label: "origin unknown", tone: "neutral" };
}

/** Remote branches the person does not have yet come first, as the mockup groups them. */
export function notHereFirst<T extends { local: boolean; worktree?: string }>(rows: readonly T[]): T[] {
  const has = (r: T) => r.local || !!r.worktree;
  return [...rows.filter((r) => !has(r)), ...rows.filter(has)];
}

/** What the inline tag form may send. Empty message = lightweight. */
export function tagFormPlan(name: string, message: string, existing: readonly string[]):
  { ok: boolean; reason: string; annotated: boolean; message: string } {
  const n = name.trim(), m = message.trim();
  const base = { annotated: m.length > 0, message: m };
  if (!n) return { ok: false, reason: "name the tag first", ...base };
  if (/[\s~^:?*[\\]|\.\.|\.lock$|^-|\/$/.test(n)) return { ok: false, reason: `${n} is not a name git accepts`, ...base };
  if (existing.includes(n)) return { ok: false, reason: `${n} already exists`, ...base };
  return { ok: true, reason: "", ...base };
}

// ---- Submodules, Worktrees, Stashes and Tidy ----

export const submoduleSelection = (path: string | undefined): DockSelection =>
  path ? { count: 1, name: path } : { count: 0 };

/** Git said no to `worktree remove` because a submodule is set up inside it. */
export const refusedForSubmodule = (error: string | undefined): boolean => /submodule/i.test(error ?? "");

export function worktreeSelection(w: GitWorktree | undefined, refused: ReadonlySet<string>): DockSelection {
  if (!w) return { count: 0 };
  return {
    count: 1, name: w.path, isCurrent: w.current, worktreeLocked: w.locked, busy: !!w.busy,
    worktreeSubmoduleRefused: refused.has(w.path),
  };
}

/** Paths a stash apply left unmerged, relative to the repo: what the tree says, not what git printed. */
export const unmergedPaths = (changes: readonly { file_path: string; status: string }[], root: string): string[] =>
  [...new Set(changes.filter((c) => c.status === "unmerged")
    .map((c) => (c.file_path.startsWith(root + "/") ? c.file_path.slice(root.length + 1) : c.file_path)))];

/**
 * A clash (F11): unmerged paths exist and the stash is still there. When the
 * panel applied one itself (`applied` = its hash) only that stash is flagged;
 * after a reload nobody remembers which, so every stash is.
 */
export const stashClashes = (unmerged: number, stashHash: string, applied?: string): boolean =>
  unmerged > 0 && (!applied || applied === stashHash);

export const stashSelection = (s: GitStash | undefined, clash: boolean): DockSelection =>
  s ? { count: 1, name: s.ref, stashClash: clash } : { count: 0 };

/** The second ask of a worktree git refused over a submodule: says what force costs. */
export const forceRemoveAsk = (name: string) => ({
  title: `Remove ${name} anyway?`,
  body: "Git refused because a submodule is set up in it. Forcing deletes the folder, the submodule checkout and every uncommitted change in it. That work is gone.",
});

/** The one ask of "Put my tree back": names every file it resets. */
export const putBackAsk = (paths: readonly string[]) => ({
  title: "Put my tree back?",
  body: `The tree goes back to how it was before the apply: what the stash changed is undone, and these files in conflict return to the last commit:\n${paths.join("\n")}\nEdits you made before applying stay, and the stash itself is kept.`,
});

/** One bar segment per Tidy finding that has something, sized by its count. */
export function tidySegments(findings: readonly { id: string; title: string; items: readonly string[]; extra: number }[]):
  { id: string; label: string; count: number; pct: number }[] {
  const counted = findings.map((f) => ({ id: f.id, label: f.title, count: f.items.length + f.extra })).filter((f) => f.count > 0);
  const total = counted.reduce((n, f) => n + f.count, 0);
  return counted.map((f) => ({ ...f, pct: (f.count / total) * 100 }));
}
