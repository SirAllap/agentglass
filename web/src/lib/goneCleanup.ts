/**
 * The decisions behind "delete N merged", separated from the panel that asks
 * them — because getting one wrong deletes somebody's work, and a decision
 * buried in a component is a decision nobody can test.
 *
 * Two things live here: which branches can be deleted outright versus which are
 * pinned by a worktree, and — once the server has reported what is inside those
 * worktrees — which of them we are actually willing to remove.
 *
 * The second one shipped broken. It read
 *
 *     byPath.get(path)?.error ?? true
 *
 * to mean "unreadable", which is true whenever `error` is absent — that is,
 * every time the server answered perfectly. Every branch with a worktree was
 * refused with "no answer from the server" while the server was right there
 * answering. Neither the type checker nor the server's own tests could see it:
 * the expression is well-typed and the endpoint was correct. Only exercising
 * this decision with a successful report catches it, which is why it is now a
 * function that can be handed one.
 */
import type { GitBranch, WorktreeLeftovers } from "../../../shared/types.ts";

/** Branches whose upstream is gone and whose work is in the trunk, split by
 *  whether a worktree is holding them. `git branch -D` refuses on the held
 *  ones no matter how hard it is forced. */
export function partitionByWorktree(
  goneMerged: GitBranch[],
  heldByWorktree: Map<string, string>,
): { free: GitBranch[]; held: GitBranch[] } {
  return {
    free: goneMerged.filter((b) => !heldByWorktree.has(b.name)),
    held: goneMerged.filter((b) => heldByWorktree.has(b.name)),
  };
}

/**
 * Which held branches we are willing to act on, given what came back.
 *
 * A report with an `error`, or no report at all, means we could not see inside
 * that checkout — and "couldn't look" must never take the same path as "nothing
 * in there", because one of them ends in `rm -rf`. Those are refused with the
 * reason attached, and the caller reports them as kept.
 */
export function splitReadable(
  held: GitBranch[],
  heldByWorktree: Map<string, string>,
  reports: WorktreeLeftovers[],
): { removable: { branch: GitBranch; report: WorktreeLeftovers }[]; refused: { branch: GitBranch; why: string }[] } {
  const byPath = new Map(reports.map((r) => [r.path, r] as const));
  const removable: { branch: GitBranch; report: WorktreeLeftovers }[] = [];
  const refused: { branch: GitBranch; why: string }[] = [];
  for (const branch of held) {
    const path = heldByWorktree.get(branch.name);
    const report = path ? byPath.get(path) : undefined;
    // Explicit, in this order, so an absent `error` can never be mistaken for a
    // failure the way `?.error ?? true` did.
    if (!report) refused.push({ branch, why: "no answer from the server" });
    else if (report.error) refused.push({ branch, why: report.error });
    else removable.push({ branch, report });
  }
  return { removable, refused };
}

/**
 * The first question, whose shape depends entirely on the split.
 *
 * With nothing free to delete, "3 more are checked out in a worktree" reads as
 * three *additional* branches on top of the three it just said could not be
 * touched — six, in a repo that has three. Each case gets its own sentence
 * rather than one sentence with a hole in it.
 */
export function goneConfirmText(
  free: GitBranch[],
  held: GitBranch[],
  unmergedCount: number,
  trunk: string,
): string {
  const parts: string[] = [];
  const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (free.length) {
    parts.push(`Delete ${free.length} ${s(free.length, "branch", "branches")} already merged into ${trunk}?`);
    if (held.length) {
      parts.push(`${held.length} more ${s(held.length, "is", "are")} checked out in a worktree. You'll be asked about ${s(held.length, "it", "those")} separately, with what removing ${s(held.length, "it", "them")} would delete.`);
    }
  } else if (held.length) {
    // No "more" here: there is nothing for them to be more *than*.
    parts.push(`All ${held.length} merged ${s(held.length, "branch is", "branches are")} checked out in a worktree, so ${s(held.length, "it", "they")} can't be deleted on ${s(held.length, "its", "their")} own.`);
    parts.push(`Remove ${s(held.length, "that worktree", "those worktrees")} and delete ${s(held.length, "the branch", "the branches")}? You'll see exactly what removing ${s(held.length, "it", "them")} would delete before anything happens.`);
  }
  if (unmergedCount) {
    parts.push(`${unmergedCount} ${s(unmergedCount, "has", "have")} no remote branch but ${s(unmergedCount, "is", "are")} NOT in ${trunk} — those are kept.`);
  }
  return parts.join("\n\n");
}

/** One worktree's entry in the "this is what goes" list. */
export function leftoversLine(report: WorktreeLeftovers, name: string, shownMax = 6): string {
  const shown = report.entries.slice(0, shownMax);
  const rest = report.entries.length - shown.length + report.more;
  const body = report.entries.length
    ? shown.map((e) => `    ${e.path}${e.vsMain === "differs" ? "  (also in the main checkout, different)" : ""}`).join("\n")
      + (rest > 0 ? `\n    …and ${rest} more` : "")
      + (report.skipped ? `\n    (+${report.skipped} rebuildable, e.g. caches — not listed)` : "")
    : report.skipped || report.identical
      ? `    nothing unique — ${[report.identical && `${report.identical} already in the main checkout`, report.skipped && `${report.skipped} rebuildable`].filter(Boolean).join(", ")}`
      : "    empty";
  return `  ${name}\n${body}`;
}

/**
 * Which leftovers start out ticked in the rescue list.
 *
 * Two rules, and neither one knows what a `.specs` directory is — the repo this
 * was built for keeps its notes there, the next one won't, and a heuristic that
 * has to be told the folder name is a heuristic that only ever works once.
 *
 *   * `differs` is never pre-ticked. Copying it overwrites the main checkout's
 *     own version, which is the accident this whole feature exists to avoid.
 *     It stays offered — sometimes the worktree's copy IS the newer one — but
 *     that has to be a deliberate tick.
 *   * `absent` is pre-ticked while it stays small. Nothing can be lost by
 *     copying it, and size is the one signal that separates notes from build
 *     output without naming either: a page of findings is kilobytes, a `dist/`
 *     is megabytes.
 *
 * On the repo this was built for that lands exactly on the four `.specs`
 * entries and leaves 22 MB of `dist/` and a 5 MB `tmp/` unticked, without a
 * single project-specific rule.
 */
export const RESCUE_PRESELECT_MAX_BYTES = 4 * 1024 * 1024;

export function preselected(report: WorktreeLeftovers, maxBytes = RESCUE_PRESELECT_MAX_BYTES): Set<string> {
  const out = new Set<string>();
  for (const e of report.entries) {
    if (e.vsMain === "absent" && e.bytes >= 0 && e.bytes <= maxBytes) out.add(e.path);
  }
  return out;
}

/** Bytes as something a human reads at a glance in a list. */
export function fmtBytes(n: number): string {
  if (n < 0) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}G`;
}
