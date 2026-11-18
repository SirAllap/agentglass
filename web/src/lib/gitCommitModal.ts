// The decisions behind the Commit modal, apart from the screen so they can be
// tested: there is no renderer in this project.

export const SUBJECT_LIMIT = 72;
const WARN_LAST = 10;

export type SubjectLevel = "ok" | "warn" | "over";

/** The subject counter: a ring that fills to the limit, amber in the last 10,
 *  red past it. The number is always shown, so colour is never the only sign. */
export function subjectMeter(subject: string) {
  const n = [...subject].length;
  const level: SubjectLevel = n > SUBJECT_LIMIT ? "over" : n > SUBJECT_LIMIT - WARN_LAST ? "warn" : "ok";
  return {
    count: n, level, fill: Math.min(1, n / SUBJECT_LIMIT), label: `${n}/${SUBJECT_LIMIT}`,
    /** Git keeps a long subject; only the log cuts it. A warning, never a block. */
    hint: level === "over" ? `${n - SUBJECT_LIMIT} character${n - SUBJECT_LIMIT === 1 ? "" : "s"} over ${SUBJECT_LIMIT}. Git keeps it, but the log cuts it.` : "",
  };
}

export interface CommitFile { path: string; additions: number; deletions: number; status?: string }

export type StatusLetter = "M" | "A" | "D" | "R";

/** `modified` / `added` / `deleted` / `renamed` (or git's own letter) as one letter. Unknown reads as M. */
export function statusLetter(status?: string): StatusLetter {
  const c = (status ?? "M").trim().charAt(0).toUpperCase();
  return c === "A" || c === "D" || c === "R" ? c : "M";
}

/** The count beside each colour of the status map, in a fixed order, zeros left out. */
export function statusCounts(files: readonly CommitFile[]): { letter: StatusLetter; n: number }[] {
  const n: Record<StatusLetter, number> = { M: 0, A: 0, D: 0, R: 0 };
  for (const f of files) n[statusLetter(f.status)]++;
  return (Object.keys(n) as StatusLetter[]).filter((l) => n[l] > 0).map((letter) => ({ letter, n: n[letter] }));
}

/** The filter box over a long list: case-insensitive, on the whole path. Empty keeps everything. */
export function filterFiles<T extends { path: string }>(files: readonly T[], q: string): T[] {
  const t = q.trim().toLowerCase();
  return t ? files.filter((f) => f.path.toLowerCase().includes(t)) : [...files];
}

/** Question in the header: "Commit 3 files?". */
export function commitTitle(n: number, fold: boolean): string {
  if (fold) return `Fold ${n} file${n === 1 ? "" : "s"} into the last commit?`;
  return `Commit ${n} file${n === 1 ? "" : "s"}?`;
}

/** At this many files the strip stops drawing dots and becomes a status map. */
export const MAP_FROM = 20;

export interface CommitPlan {
  /** Why the button is off, in the footer's words. Empty when it is on. */
  reason: string;
  ok: boolean;
  paths: string[];
  additions: number;
  deletions: number;
  /** Fold is only offered while the last commit is not pushed. */
  canFold: boolean;
  foldNote: string;
  actionLabel: string;
  statusMap: boolean;
}

export function commitPlan(o: {
  files: CommitFile[];
  /** Paths the person left unticked. */
  off: ReadonlySet<string>;
  subject: string;
  fold: boolean;
  /** Commits the branch is ahead of its upstream; null = no upstream. */
  ahead: number | null;
  lastHash?: string;
}): CommitPlan {
  const picked = o.files.filter((f) => !o.off.has(f.path));
  const canFold = o.ahead !== null && o.ahead > 0;
  const fold = o.fold && canFold;
  const n = picked.length;
  const reason = n === 0 ? "Tick at least one file."
    : !o.subject.trim() ? "Write a subject first."
    : "";
  const noun = `${n} file${n === 1 ? "" : "s"}`;
  return {
    reason, ok: reason === "", paths: picked.map((f) => f.path),
    additions: picked.reduce((s, f) => s + f.additions, 0),
    deletions: picked.reduce((s, f) => s + f.deletions, 0),
    canFold,
    foldNote: canFold ? "only while it is not pushed" : `${o.lastHash ?? "The last commit"} is on origin already`,
    actionLabel: fold ? "Rewrite last commit" : `Commit ${noun}`,
    statusMap: o.files.length >= MAP_FROM,
  };
}

/** `src/checkout/` + `retry.ts`: the directory is dimmed, the name is not. */
export function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}
