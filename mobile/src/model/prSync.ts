/*
 * Syncing a pull request's branch, and saying what happened to it.
 *
 * `POST /prs/update-branch` merges the base into the head on GitHub's side. It
 * is one pull request per call — there is no bulk route, and this module does
 * not invent one: a lane sync is N of these with one summary, which is why the
 * summary below counts what the server accepted and nothing else.
 *
 * The half worth writing down is the refusal. GitHub answers a conflict with a
 * refusal that reads like a crash, and the thing a person needs to know is that
 * NOTHING MOVED — not the remote branch, not their checkout. Every non-success
 * outcome says that in the same sentence, because it is true of every one of
 * them: the server only ever seems to touch the local branch when a sync is
 * explicitly asked for, and the sheets here never ask.
 */
import type { PrActionResult } from "../../../shared/types.ts";

/** The sentence every refusal shares. */
export const UNTOUCHED = "Nothing is half-written — the branch is untouched, exactly as it was before the sync.";

/** One commit the base has and the branch lacks, as `/prs/behind` names it. */
export interface IncomingCommit { sha: string; title: string }

/** The mock's "What main brings" lines (screen 38): `a11c2 Lane order cache`.
 *  Five at most; the rest are the count on the row above. */
export function incomingLines(target: SyncTarget): string[] {
  return (target.incoming ?? []).slice(0, 5).map((c) => `${c.sha} ${c.title}`);
}

/** One pull request on its way to the base. `behind` is absent until read. */
export interface SyncTarget {
  number: number;
  behind?: number;
  ahead?: number;
  /** What the base brings, newest first: a short sha and a title each. */
  incoming?: IncomingCommit[];
  head?: string;
  /** GitHub already says it conflicts; the sheet draws that before the press. */
  conflict?: boolean;
  /** This machine's copy can be fast-forwarded, so the server may move it too.
   *  Decided by `/prs/behind`'s own `local.sync` — never guessed here. */
  syncLocal?: boolean;
}

export type SyncStatus =
  | "synced" | "requested" | "conflict" | "lagging" | "failed" | "unknown"
  /** Never compared: the read that answers "how far behind" did not answer. */
  | "unread"
  /** Compared, and where it was. */
  | "skipped";

export interface SyncOutcome {
  number: number;
  status: SyncStatus;
  /** One line, also the row's second line in the sheet. */
  line: string;
  /** The files GitHub names when it refused over a conflict. */
  conflicts?: string[];
  /** The branch is where it was. False only for a sync that moved it. */
  untouched: boolean;
}

/** How far behind, in words. Absent is "not read", which is not zero. */
export function behindLine(target: SyncTarget, base: string): string {
  if (target.behind === undefined) return `Behind ${base} by an unread number of commits`;
  const n = target.behind;
  if (n <= 0) return `Up to date with ${base}`;
  return `Behind ${base} by ${n} commit${n === 1 ? "" : "s"}`;
}

/** What the base brings, from the one comparison `/prs/behind` answers. */
export function bringLine(target: SyncTarget, base: string): string {
  const behind = target.behind ?? 0;
  const ahead = target.ahead ?? 0;
  if (!behind) return `${base} has nothing this branch is missing.`;
  return `${base} is ${behind} commit${behind === 1 ? "" : "s"} ahead; this branch has ${ahead} commit${ahead === 1 ? "" : "s"} ${base} does not.`;
}

/** How many calls a press would make. Never the lane's length: an up-to-date
 *  branch is not a sync. */
export function syncCount(targets: readonly SyncTarget[]): number {
  return targets.filter((t) => (t.behind ?? 0) > 0).length;
}

/** The sheet's title: one branch by name, several as a count. */
export function syncTitle(targets: readonly SyncTarget[], base: string): string {
  if (targets.length === 1) return `Sync #${targets[0]!.number} with ${base}`;
  return `Sync ${targets.length} branches with ${base}`;
}

/** The sheet's quiet line under the title. */
export function syncSubtitle(targets: readonly SyncTarget[], base: string): string {
  if (targets.length === 1) {
    const t = targets[0]!;
    const behind = t.behind;
    // The mock's line (38): the branch, how far, and whether it will apply.
    const state = behind === undefined ? "reading how far behind" : behind > 0 ? `behind ${behind}` : `up to date with ${base}`;
    return `${t.head ? `${t.head} · ` : ""}${state} · ${t.conflict ? "conflicts" : "no conflicts"}`;
  }
  const n = syncCount(targets);
  if (n) return `${n} of ${targets.length} are behind ${base}`;
  const unread = targets.filter((t) => t.behind === undefined).length;
  if (unread) return `${unread} of ${targets.length} could not be compared with ${base}`;
  return `Every one of the ${targets.length} is up to date with ${base}`;
}

/** One server answer, as the row that says what happened. */
export function outcomeOf(number: number, res: PrActionResult): SyncOutcome {
  if (res.conflict) {
    return {
      number, status: "conflict", untouched: true,
      line: `${res.error ?? "GitHub would not update this branch."} ${UNTOUCHED}`,
    };
  }
  if (res.prLagging) {
    return {
      number, status: "lagging", untouched: true,
      line: `${res.error ?? "GitHub updated the branch but the pull request has not caught up."} ${UNTOUCHED}`,
    };
  }
  if (res.requested) {
    return {
      number, status: "requested", untouched: true,
      line: `${res.detail ?? "Update requested."} ${UNTOUCHED}`,
    };
  }
  if (res.ok) {
    return { number, status: "synced", untouched: false, line: res.detail ?? "Synced — GitHub moved the branch." };
  }
  return {
    number, status: "failed", untouched: true,
    line: `${res.error ?? "GitHub refused that sync."} ${UNTOUCHED}`,
  };
}

/**
 * The request never got an answer.
 *
 * Deliberately NOT "untouched": a timeout can land after GitHub accepted the
 * update, and this phone cannot see the branch. Claiming it stayed put would be
 * the one lie this sheet exists to avoid.
 */
export function unreachableOutcome(number: number, error: string): SyncOutcome {
  return {
    number, status: "unknown", untouched: false,
    line: `The computer did not answer, so whether this branch moved is unknown. ${error}`,
  };
}

/** A branch with nothing to bring, still shown so the count adds up. */
export function skippedOutcome(number: number, base: string): SyncOutcome {
  return { number, status: "skipped", untouched: true, line: `Up to date with ${base}.` };
}

/** A branch nobody compared. Absent `behind` is not zero, so this may not say
 *  "up to date" — the read that answers the number failed. */
export function unreadOutcome(number: number, base: string): SyncOutcome {
  return {
    number, status: "unread", untouched: true,
    line: `How far behind ${base} could not be read, so this branch was not compared and not synced.`,
  };
}

/** The word on a row, and its tint in the sheet. */
export function outcomeWord(status: SyncStatus): string {
  return status === "synced" ? "Synced"
    : status === "requested" ? "Requested"
    : status === "conflict" ? "Conflict"
    : status === "lagging" ? "Not caught up"
    : status === "failed" ? "Failed"
    : status === "unknown" ? "Unknown"
    : status === "unread" ? "Not read"
    : "Up to date";
}

export interface SyncSummary {
  /** What the server accepted AND moved. A queued request is not a sync. */
  synced: number;
  conflicts: number;
  failed: number;
  /** A request that never answered: not known to have moved, not known to have stayed. */
  unknown: number;
  /** Branches nobody compared: not known to need anything. */
  unread: number;
  /** Branches with nothing to do. */
  skipped: number;
  line: string;
}

/**
 * One line over N answers.
 *
 * `synced` is deliberately the narrow count: a lane that says "Synced 3" over
 * two branches and a refusal is the bug this function exists to prevent.
 */
export function syncSummary(outcomes: readonly SyncOutcome[], base = "the base"): SyncSummary {
  const count = (s: SyncStatus): number => outcomes.filter((o) => o.status === s).length;
  const synced = count("synced");
  const conflicts = count("conflict");
  const unknown = count("unknown");
  const unread = count("unread");
  const failed = count("failed") + count("lagging") + count("requested");
  const skipped = count("skipped");
  const parts: string[] = [];
  if (synced) parts.push(`Synced ${synced} branch${synced === 1 ? "" : "es"}.`);
  if (conflicts) parts.push(`${conflicts} conflicted — ${conflicts === 1 ? "its branch is" : "their branches are"} untouched.`);
  if (failed) parts.push(`${failed} did not move — ${failed === 1 ? "its branch is" : "their branches are"} untouched.`);
  if (unknown) parts.push(`${unknown} could not be confirmed — pull to refresh before trying again.`);
  if (unread) parts.push(`${unread} ${unread === 1 ? "branch was" : "branches were"} not compared — how far behind could not be read.`);
  if (!outcomes.length) return { synced, conflicts, failed, unknown, unread, skipped, line: "Nothing to sync." };
  if (!parts.length) return {
    synced, conflicts, failed, unknown, unread, skipped,
    line: `Everything is already up to date with ${base}.`,
  };
  return { synced, conflicts, failed, unknown, unread, skipped, line: parts.join(" ") };
}
