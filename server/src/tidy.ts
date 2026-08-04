/**
 * What has accumulated in a checkout, and the command that would clear it.
 *
 * Written for a real repository in a real state: fifty-five local branches,
 * twenty-four worktrees, twenty-two stashes and half a gigabyte, with branches
 * in it whose owner could no longer say where they came from. The ask was
 * explicit — "tell me how to clean it, or give me something in the app that
 * does it faster, and make sure you touch nothing in git."
 *
 * So this module READS. It never writes, and it exposes no endpoint that
 * could: every finding carries a command as a STRING, which the panel types
 * into a shell and leaves at the prompt. The same shape as installing a
 * dependency, for the same reason — a destructive git command should be run by
 * the person whose repository it is, after they have read it.
 *
 * The commands are chosen so that the worst case is a refusal, never a loss:
 *
 *   * `git branch -d`, never `-D`. Lowercase refuses to delete a branch whose
 *     work is not merged; uppercase is the one that loses commits. If a branch
 *     in the list is not really merged, the command declines and says so — the
 *     safest possible failure, and the reason no finding here offers `-D`.
 *   * `git worktree prune` removes registrations whose directory is already
 *     gone. There is nothing on disk left to lose.
 *   * `git gc` repacks. It is the same maintenance git runs on its own.
 *   * Stashes get NO deletion command at all — see the finding.
 */
import { git } from "./git.ts";

import type { TidyFinding, TidyReport } from "../../shared/types.ts";
export type { TidyFinding, TidyReport };

const MAX_SHOWN = 12;

/**
 * Lines this module refuses to hand over, whatever a future finding believes.
 *
 * The first two versions of the test for this checked only the commands the
 * test repository happened to produce — and a temporary checkout has no stale
 * worktrees, no half-gigabyte of loose objects and no eight hundred remote
 * refs, so most findings never existed and most commands were never examined.
 * Deliberately swapping a safe command for `git reset --hard` turned nothing
 * red. Twice.
 *
 * A rule that only holds where a fixture reaches is not a rule. So the check
 * moved out of the tests and into the module: every command passes through
 * here on the way out, so the guarantee covers findings nobody has written
 * yet. A command that trips it loses its button and says why, which is a
 * missing convenience rather than a lost branch.
 */
const UNSAFE: { re: RegExp; why: string }[] = [
  { re: /\bbranch\b[^\n]*\s-D\b/, why: "-D deletes unmerged commits; -d refuses and names the branch" },
  { re: /\s(--force|-f)\b/, why: "forcing turns a refusal into a loss, and a refusal is the point" },
  { re: /\breset\s+--hard\b/, why: "discards the working tree" },
  { re: /\bclean\s+-[a-z]*f/, why: "deletes untracked files, which have no other copy" },
  { re: /\bstash\s+(drop|clear)\b/, why: "a stash exists nowhere else" },
  { re: /\bpush\s+[^\n]*--force/, why: "rewrites somebody else's history" },
  { re: /\bfilter-branch\b|\bfilter-repo\b/, why: "rewrites every commit" },
  // Plain `git gc` keeps unreachable objects for two weeks, which is the
  // window in which a mistaken branch deletion is still undoable. Any explicit
  // --prune= closes it, and --prune=now closes it immediately — found by the
  // test refusing to pass, because the first pattern here looked for
  // `prune --expire` and this is spelled `--prune=now`.
  { re: /\breflog\s+expire\b|\bprune\s+--expire\b|\bgc\b[^\n]*--prune=/, why: "throws away the safety net that makes a mistaken deletion recoverable" },
];

/** The command, or nothing and a reason. Exported so it can be driven with
 *  dangerous input directly, instead of hoping a fixture produces some. */
export function vetCommand(cmd: string | null): { command: string | null; refused?: string } {
  if (!cmd) return { command: null };
  for (const u of UNSAFE) if (u.re.test(cmd)) return { command: null, refused: u.why };
  return { command: cmd };
}

/** `git branch` marks the branch checked out in a worktree with `+` and the
 *  current one with `*`. Splitting on whitespace and taking the first field
 *  returns "+" for exactly the branches most likely to matter. */
const branchName = (line: string): string => line.replace(/^[*+]\s*/, "").trim().split(/\s+/)[0] ?? "";

/** The checkout's own idea of its default branch, not ours. */
function baseBranch(root: string): string {
  const head = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const short = head.stdout.trim().replace(/^origin\//, "");
    if (short) return short;
  }
  for (const guess of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", guess]).code === 0) return guess;
  }
  return "main";
}

export function tidyReport(root: string): TidyReport {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return { root, base: "main", findings: [], error: "not a git checkout" };

  const base = baseBranch(root);

  /**
   * Branches a worktree has checked out.
   *
   * `git branch -d` refuses these, and rightly — deleting the branch a live
   * checkout is sitting on would strand it. Found by watching the command run
   * for real: seven deletions succeeded and two failed in red, and both
   * failures were knowable in advance from this list. Offering a command that
   * is guaranteed to half-fail is a worse answer than offering one that works
   * and naming what it left behind.
   */
  const checkedOut = new Set<string>();
  {
    const wl = git(root, ["worktree", "list", "--porcelain"]);
    if (wl.code === 0) {
      for (const line of wl.stdout.split("\n")) {
        if (line.startsWith("branch ")) checkedOut.add(line.slice(7).trim().replace(/^refs\/heads\//, ""));
      }
    }
  }
  const HELD_WORKTREE = "a worktree has it checked out — remove that worktree first";
  const HELD_UNMERGED = "it has commits that are on no other branch — read them before deciding";

  /**
   * Everything merged into the base, as a set.
   *
   * Needed by the gone-upstream finding as well as its own, and this is the
   * correction that matters most in this file. A deleted upstream was being
   * treated as proof the work landed — "usually because its PR merged" — and
   * on a real checkout three of six such branches had commits that were on no
   * other branch. `git branch -d` refused all three, correctly, and the user
   * read six red errors for a command the panel had promised would work.
   *
   * A remote branch disappears for more than one reason: the pull request
   * merged, or it was closed unmerged, or somebody tidied the remote, or work
   * was committed locally after the merge. Only the graph knows which.
   */
  const mergedSet = new Set<string>();
  {
    const m = git(root, ["branch", "--merged", base, "--format=%(refname:short)"]);
    if (m.code === 0) for (const b of m.stdout.split("\n").map((x) => x.trim()).filter(Boolean)) mergedSet.add(b);
  }
  const holdReason = (b: string): string | null =>
    checkedOut.has(b) ? HELD_WORKTREE : !mergedSet.has(b) ? HELD_UNMERGED : null;

  const findings: TidyFinding[] = [];
  /** `all` is the full list; `items` and `extra` are how much of it is shown.
   *  A finding with nothing in it is not added at all — an empty section is a
   *  row of furniture that teaches people to skim past the ones that matter. */
  const add = (f: Omit<TidyFinding, "extra" | "items" | "blocked"> & { all: string[]; blocked?: { name: string; why: string }[] }) => {
    if (!f.all.length) return;
    const vet = vetCommand(f.command);
    findings.push({
      id: f.id, title: f.title, what: f.what, command: vet.command,
      why: f.why, effect: f.effect, risk: f.risk, diagram: f.diagram,
      blocked: f.blocked ?? [],
      // A refusal replaces the note rather than joining it: if the module will
      // not offer the line, why it will not is the only thing worth reading.
      note: vet.refused ? `No command offered: ${vet.refused}.` : f.note,
      items: f.all.slice(0, MAX_SHOWN), extra: Math.max(0, f.all.length - MAX_SHOWN),
    });
  };

  // ---- branches whose upstream is gone -----------------------------------
  // The clearest signal a branch is finished: the remote it tracked has been
  // deleted, which is what happens when its pull request merges.
  const vv = git(root, ["branch", "-vv"]);
  const gone = vv.code === 0
    ? vv.stdout.split("\n").filter((l) => l.includes(": gone]")).map(branchName).filter(Boolean)
    : [];
  const goneHeld = gone.map((b) => ({ name: b, why: holdReason(b) })).filter((x): x is { name: string; why: string } => x.why !== null);
  const goneFree = gone.filter((b) => holdReason(b) === null);
  add({
    id: "gone", all: gone, blocked: goneHeld,
    title: "Branches whose remote is gone",
    what: "Each of these tracked a branch on the remote that no longer exists — usually because its pull request merged and the host deleted it.",
    command: goneFree.length ? `git branch -d ${goneFree.join(" ")}` : null,
    note: "`-d`, never `-D`: it refuses any branch whose work is not merged, and names it. A refusal here is the command working.",
    why: "`git branch -vv` prints `: gone]` beside a branch whose upstream no longer exists — a fact from the last pruning fetch, not a guess about age or naming. It does NOT prove the work landed: a remote branch also disappears when its pull request is closed unmerged, so each one is checked against the graph as well, and any branch with commits of its own is held back below.",
    effect: "Deletes the local branch NAME. The commits stay reachable from wherever they were merged, and from the reflog for at least two weeks.",
    risk: "Anything not merged, or checked out in a worktree, is already left out of the command and listed as held. If git still refuses one, it names it and deletes the rest — nothing is ever forced.",
    diagram: [
      "  origin/orbit-1042   ✗  deleted on the remote (its PR merged)",
      "        ▲",
      "        │ tracked",
      "  orbit-1042          ●  still here, pointing at nothing",
    ],
  });

  // ---- branches already merged into the base ------------------------------
  const merged = git(root, ["branch", "--merged", base, "--format=%(refname:short)"]);
  const mergedNames = merged.code === 0
    ? merged.stdout.split("\n").map((s) => s.trim()).filter((s) => s && s !== base && !gone.includes(s))
    : [];
  // These are merged by definition, so a worktree is the only thing that can
  // hold one back here.
  const mergedHeld = mergedNames.filter((b) => checkedOut.has(b)).map((b) => ({ name: b, why: HELD_WORKTREE }));
  const mergedFree = mergedNames.filter((b) => !checkedOut.has(b));
  add({
    id: "merged", all: mergedNames, blocked: mergedHeld,
    title: `Branches already merged into ${base}`,
    what: `Every commit on these is already on ${base}, so deleting the branch deletes nothing but the name.`,
    command: mergedFree.length ? `git branch -d ${mergedFree.join(" ")}` : null,
    note: "Branches checked out in a worktree are refused until that worktree is removed — that is git protecting the checkout, not an error.",
    why: `\`git branch --merged ${base}\` lists branches whose every commit is already an ancestor of ${base}. Git computed that from the graph — it is not "looks old" or "name looks done".`,
    effect: "Deletes the branch name only. Every commit on it is already reachable from " + base + ", so nothing becomes unreachable.",
    risk: "A branch that is checked out in a worktree is refused until that worktree is removed. That is git protecting a live checkout.",
    diagram: [
      `  ${base}   ●──●──●──●   every commit below is already here`,
      "                   ╲",
      "  orbit-980         ●   the name is the only thing left",
    ],
  });

  // ---- worktrees whose directory is gone ----------------------------------
  const wt = git(root, ["worktree", "list", "--porcelain"]);
  const stale: string[] = [];
  if (wt.code === 0) {
    let current = "";
    for (const line of wt.stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice(9).trim();
      else if (line.startsWith("prunable") && current) stale.push(current);
    }
  }
  add({
    id: "worktrees", all: stale,
    title: "Worktrees whose directory is gone",
    what: "Registrations pointing at directories that no longer exist. Git keeps the bookkeeping until asked, so they go on appearing in every list.",
    command: stale.length ? "git worktree prune -v" : null,
    note: "Only the registration goes; the directory is already gone. Nothing on disk can be lost here.",
    why: "`git worktree list --porcelain` marks these `prunable`: git looked for the directory each one registers and did not find it.",
    effect: "Removes the bookkeeping under .git/worktrees for directories that are already gone. `-v` makes it name each one as it goes.",
    risk: "None that can cost anything: there is no directory left to delete. A worktree still on disk is never touched.",
    diagram: [
      "  .git/worktrees/spike  ●  registration git still keeps",
      "         │",
      "         ▼",
      "  /tmp/…/spike          ✗  directory already deleted",
    ],
  });

  // ---- stashes -------------------------------------------------------------
  // Deliberately no command. A stash is uncommitted work, and it is the one
  // thing here that no other copy of exists.
  const stash = git(root, ["stash", "list", "--format=%gd  %cs  %s"]);
  const stashes = stash.code === 0 ? stash.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  add({
    id: "stashes", all: stashes,
    title: "Stashes",
    what: "Uncommitted work, set aside. The oldest ones are usually the ones nobody will come back to — but that is a judgement only their author can make.",
    command: null,
    note: "No command offered on purpose. A stash is the one thing in this list that exists nowhere else, and `git stash drop` cannot be undone once the reflog expires. Read one with `git stash show -p stash@{0}` and decide it yourself.",
    why: "`git stash list` — every entry, oldest last. Listed for the same reason as the rest: it is taking up room in your head.",
    effect: "Nothing. This finding has no button.",
    risk: "The reason there is no button: a stash is not on any branch and not on any remote. Dropping one is the only action in this tab with no way back.",
    diagram: [
      "  stash@{0}  ●  the only copy",
      "               ✗ no branch",
      "               ✗ no remote",
      "               ✗ nothing else points at it",
    ],
  });

  // ---- housekeeping --------------------------------------------------------
  const objs = git(root, ["count-objects", "-v"]);
  const loose = Number(/^count: (\d+)/m.exec(objs.stdout ?? "")?.[1] ?? 0);
  const sizeKb = Number(/^size-pack: (\d+)/m.exec(objs.stdout ?? "")?.[1] ?? 0);
  add({
    id: "gc", all: loose > 500 ? [`${loose} loose objects · ${(sizeKb / 1024 / 1024).toFixed(2)} GB packed`] : [],
    title: "Loose objects",
    what: "Objects written but not yet packed. They cost disk and slow every command that has to walk them.",
    command: "git gc",
    note: "The same maintenance git already runs on its own; this only makes it happen now. Nothing reachable is removed.",
    why: "`git count-objects -v` reports the loose count. Above a few hundred it is worth packing; git would get to it on its own eventually.",
    effect: "Packs loose objects together and drops ones nothing can reach. Reachable history is untouched, and the repository gets smaller and faster to walk.",
    risk: "Plain `git gc` keeps unreachable objects for two weeks, which is the window that makes a mistaken deletion recoverable. No `--prune=now` is offered, and the module refuses one.",
    diagram: [
      "  2665 loose objects  ──gc──▶  packed",
      "",
      "  reachable history            unchanged",
      "  deleted-by-mistake           still recoverable for 2 weeks",
    ],
  });

  /**
   * There is no remote-tracking finding, and it is worth saying why here so
   * nobody adds one back.
   *
   * There was one. It counted `refs/remotes` and offered `git fetch --prune`
   * on anything over two hundred. On a real checkout that read 869 and looked
   * like a pile of rubbish to sweep — and the user swept it, twice, and the
   * number did not move. It was right not to: asked directly, the remote has
   * 867 branches, and `git remote prune --dry-run` would remove none. The
   * count was of refs you HAVE, and the card was presenting it as refs that
   * are STALE. Those are different numbers and only the remote knows the
   * second one.
   *
   * Rewording it was the first attempt and it was not enough. A card with a
   * button is a claim that there is something to do, and no amount of hedging
   * text below the button unsays it. This module's own rule already covers the
   * case — a finding with nothing in it is absent, not empty — and this one
   * was exempt from it only because it counted the wrong thing.
   *
   * A busy repository is not a dirty one. If this comes back it needs a signal
   * that can tell those apart, and the only one that can is the remote.
   */

  return { root, base, findings };
}
