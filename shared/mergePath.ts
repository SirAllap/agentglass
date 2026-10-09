// The merge box's decision: who moves next, what stands in the way, in what order.
//
// The box used to be a header (the first reason it would not merge) over a
// pile of rows in the order the code happened to build them, so "is this on me
// or on CI" was something to work out. It is now one answer built here, in one
// pure function, and drawn by a component that decides nothing:
//
//   hero     one sentence about who moves next, one primary action, one
//            secondary, and how long CI still needs when CI is the only wait.
//   stages   Review, Required checks, Other CI, Merge, with the one that holds
//            the merge highlighted and a sub-line each.
//   rows     what stands between you and merge: what it is, why it blocks,
//            and who moves it. Ordered so what needs a person comes before what
//            only needs time.
//   otherCi  the checks GitHub does not wait for, as one row and a bar.
//
// The reasons themselves are still `mergeBlockers`, the list that says what
// GitHub will refuse over; this reads it and adds the two things it does not
// carry, which are the perspective (is the viewer the author, is the review
// theirs to give) and each check on its own.
//
// Counts are GitHub's. `checksAll` is already one run per workflow, job name
// and event (see latestPerName in the server), so every number here is a
// partition of it: required + other is `checks.total`, never a second count.
//
// What this does not do: an ETA. It is derived only from a run of the SAME
// workflow and job that already finished in this pull request (a workflow that
// listens to two events runs the job twice), or from `typical` when a caller
// has a history to give. A pull request with neither gets no ETA rather than a
// number made up from nothing, and a run that has already outlived its own
// earlier duration gets none either.

import type { PrCheck, PrCheckRollup, PrMergeGate, PrReview, PrReviewer, PrSummary } from "./types.ts";
import { MIN_SAMPLES, runKey } from "./checkBaseline.ts";
import { mergeBlockers, staleApproval, type MergeBlocker } from "./mergeBlockers.ts";

export type Mover = "you" | "author" | "reviewer" | "ci" | "wait" | "other" | "fyi" | "done";
export type StageKey = "review" | "required" | "other" | "merge";
export type StageStatus = "done" | "blocked" | "wait" | "idle";

export const MOVER_LABEL: Record<Mover, string> = {
  you: "YOU", author: "AUTHOR", reviewer: "REVIEWER", ci: "CI · WAIT", wait: "WAIT", other: "SOMEONE ELSE", fyi: "FYI", done: "DONE",
};

export type RowKind =
  | "draft" | "locked" | "no-permission" | "restricted" | "conflicts"
  | "check-failing" | "check-running" | "check-queued" | "check-cancelled" | "required-missing"
  | "changes" | "review-required" | "threads" | "behind" | "unexplained" | "computing" | "awaiting"
  | "note" | "approved";

export type ActionId =
  | "merge" | "open-log" | "rerun" | "go-thread" | "go-review" | "history" | "mark-ready"
  | "resolve-conflicts" | "open-github" | "update-branch" | "arm-auto";

export interface PathAction {
  id: ActionId;
  label: string;
  /** For `open-log`. */
  url?: string;
  /** For `go-review`: where the review lives in the conversation. */
  nodeId?: string;
}

export interface HeroPart { text: string; em?: boolean }

export interface Hero {
  /** ready: the merge is live. you: a person has to act. wait: only time is missing. stuck: not the viewer's to move. */
  tone: "ready" | "you" | "wait" | "stuck";
  eyebrow: string;
  parts: HeroPart[];
  sub?: string;
  primary?: PathAction;
  secondary?: PathAction;
  /** Review history, when the secondary slot is already taken by something else. */
  also?: PathAction;
  /** A small line beside the actions: what comes after them. */
  after?: string;
}

export interface Stage {
  key: StageKey;
  n: 1 | 2 | 3 | 4;
  label: string;
  status: StageStatus;
  /** The stage that holds the merge right now. */
  current: boolean;
  /** A number worth a line of its own, such as "~4 min". */
  big?: string;
  sub: string;
}

export interface PathRow {
  id: string;
  /** Position in the list, from 1 — what "rows 1–2 are on you" refers to. */
  n: number;
  kind: RowKind;
  stage: StageKey;
  title: string;
  /** Where it comes from: the workflow of a check, who and when for a review. */
  sub?: string;
  pill?: "required";
  why: string;
  mover: Mover;
  moverLabel: string;
  /** Counted in "What stands between you and merge · N". A note is not. */
  counted: boolean;
  /** A progress ring for a check that has not finished. `fraction` only where a typical duration is known. */
  ring?: { mode: "queued" | "running" | "failed"; fraction?: number };
  link?: { label: string; url: string };
}

export interface OtherCi {
  total: number;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  skipped: number;
  /** Whether GitHub said which checks are required. Without it every check is "other". */
  requiredKnown: boolean;
  sub: string;
  /** "12 running · 0 passed · 3 skipped of 58" */
  text: string;
  /** What else is true of the branch: "No conflicts · 81 behind main (fine)". */
  tail: string;
  /** The bar and its legend: only the parts that exist. */
  segments: { key: "passed" | "failed" | "running" | "skipped" | "queued"; count: number; label: string }[];
}

export interface Callout { tone: "warn" | "ok"; text: string }

export interface MergePath {
  /** Nothing stands in the way: the merge is live. */
  ready: boolean;
  hero: Hero;
  stages: Stage[];
  /** Everything with a row, counted or not; `count` says how many are counted. */
  rows: PathRow[];
  count: number;
  otherCi: OtherCi | null;
  callout: Callout | null;
  /** Past rounds of review worth opening; zero hides the button. */
  historyCount: number;
}

export interface MergePathInput {
  state: string;
  mergeState: string;
  mergeable?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  humanReview?: PrSummary["humanReview"];
  /** Reviewers still asked. */
  reviewers?: PrReviewer[];
  reviews?: PrReview[];
  /** When each still-asked reviewer was last asked (login lowercased → ISO),
   *  from the timeline's review-requested events. */
  askedAt?: Record<string, string>;
  author?: string;
  viewerDidAuthor?: boolean;
  viewerRequested?: boolean;
  checks?: PrCheckRollup | null;
  checksAll?: PrCheck[];
  gate?: PrMergeGate;
  baseRefName: string;
  openThreads?: number;
  conflicted?: boolean;
  conflictFiles?: number;
  behind?: number | null;
  awaitingChecks?: boolean;
  autoArmed?: boolean;
  now?: number;
  /** Typical duration in ms by `workflow\u0001name`, when a caller has a history. */
  typical?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// small words
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "about 4 min", "under a minute": how long is left, as a person would say it. */
export function fmtEta(ms: number): string {
  return ms < 60_000 ? "under a minute" : `about ${fmtDuration(ms)}`;
}

function agoShort(now: number, iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const nameList = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]} +${names.length - 2}`;

/**
 * What a check does, in a line, when GitHub does not say.
 *
 * By the name a job is given, because that is all there is: the check API has
 * no description field, only the title a check wrote about its own RESULT. A
 * name that matches nothing says only that it is a status check, which is true
 * and no more.
 */
export function checkKindLine(c: Pick<PrCheck, "name" | "workflow">, required: boolean): string {
  const s = `${c.name} ${c.workflow}`.toLowerCase();
  if (/summary|roll-?up|all[- ]checks|aggregate|status gate/.test(s)) return "Roll-up of the workflow's other jobs; reports when they finish.";
  if (/audit|security|codeql|vuln|snyk|trivy|scan|licen[cs]e|secret/.test(s)) return "Audits the change against security and policy rules.";
  if (/e2e|end-to-end|integration|smoke/.test(s)) return "Runs the end-to-end and integration tests.";
  if (/type-?check|tsc|mypy|pyright/.test(s)) return "Type-checks the code.";
  if (/lint|format|prettier|eslint|style|fmt/.test(s)) return "Checks formatting and lint rules.";
  if (/test|spec|jest|pytest|vitest/.test(s)) return "Runs the automated tests.";
  if (/build|compile|bundle|package/.test(s)) return "Builds the project to make sure it compiles.";
  if (/coverage|codecov/.test(s)) return "Measures test coverage.";
  if (/deploy|preview/.test(s)) return "Deploys a preview of the change.";
  if (/review|claude|copilot|bot/.test(s)) return "Automated review of the diff.";
  return required ? "A required status check on this branch." : "A status check that runs on every push.";
}

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

const WILL_MERGE = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);
const key = (c: PrCheck) => `${c.workflow}\u0001${c.name}`;
/** For durations: the trigger counts, a job that runs on two events is two jobs with two histories. */
const tkey = (c: PrCheck) => runKey(c.workflow, c.name, c.event);

/** Where a check's workflow is named: `workflow` when GitHub gave one, else the part of a "a / b" name before the job. */
function workflowOf(c: PrCheck): { workflow: string; job: string } {
  if (c.workflow) return { workflow: c.workflow, job: c.name };
  const parts = c.name.split(" / ");
  return parts.length > 1
    ? { workflow: parts.slice(0, -1).join(" / "), job: parts[parts.length - 1]! }
    : { workflow: "", job: c.name };
}

const rankOf = (m: Mover) => (m === "you" || m === "author" || m === "other" ? 0 : m === "reviewer" ? 1 : m === "done" ? 3 : 2);
const STAGE_ORDER: StageKey[] = ["review", "required", "other", "merge"];

export function mergePath(i: MergePathInput): MergePath {
  const now = i.now ?? Date.now();
  const base = i.baseRefName || "the base branch";
  const all = i.checksAll ?? [];
  const gate = i.gate;
  const hv = i.humanReview && typeof i.humanReview === "object" && i.humanReview.kind ? i.humanReview : null;
  const openThreads = i.openThreads ?? 0;
  const conflicted = i.conflicted ?? (i.mergeable === "CONFLICTING" || i.mergeState === "DIRTY");
  // BEHIND is not a refusal by itself: the "behind" reason says whether it is one.
  const willMerge = WILL_MERGE.has(i.mergeState) || i.mergeState === "BEHIND";

  // Whose move a thing is, from where the viewer stands.
  const authorMover: Mover = i.viewerDidAuthor ? "you" : "author";
  const reviewerMover: Mover = i.viewerRequested || hv?.mine ? "you" : "reviewer";

  /*
   * A check GitHub waits on. Where the gate could not be read nothing carries
   * `required`, and a blocked pull request with a red or running check is
   * then blocked BY it as far as anybody can tell — the same reading
   * mergeBlockers takes, so the two cannot disagree about which checks count.
   */
  const gating = (c: PrCheck): boolean =>
    c.required === true || (!gate && !willMerge && (c.state === "failure" || !c.done));
  const gated = all.filter(gating);
  const others = all.filter((c) => !gating(c));

  // -------------------------------------------------------------- durations
  const typical = new Map<string, number>(Object.entries(i.typical ?? {}));
  /* The job's own history on this repo comes first: the median of its last
     successful runs, over any pull request. A run earlier on THIS pull request
     is one sample, and only used when there is no history (or too little). */
  for (const c of all) {
    if (c.usual && c.usual.n >= MIN_SAMPLES && c.usual.median > 0) typical.set(tkey(c), c.usual.median);
  }
  for (const c of all) {
    if (c.done && c.state === "success" && c.startedAt && c.completedAt && !typical.has(key(c))) {
      const ms = Date.parse(c.completedAt) - Date.parse(c.startedAt);
      if (ms > 0) typical.set(key(c), ms);
    }
  }
  const elapsedOf = (c: PrCheck) => (c.startedAt ? Math.max(0, now - Date.parse(c.startedAt)) : null);
  /** Left for one running check; null when nothing is known or it has run past what it took before. */
  const remainingOf = (c: PrCheck): number | null => {
    const t = typical.get(tkey(c)) ?? typical.get(key(c));
    if (!t) return null;
    const e = elapsedOf(c);
    if (e === null) return t;
    return e >= t ? null : t - e;
  };

  // -------------------------------------------------------------- the rows
  const blockers = mergeBlockers({
    state: i.state, mergeState: i.mergeState, mergeable: i.mergeable, isDraft: i.isDraft,
    reviewDecision: i.reviewDecision, checks: i.checks, checksAll: all, baseRefName: i.baseRefName,
    gate, openThreads, conflicted, awaitingChecks: i.awaitingChecks,
  });
  const rows: Omit<PathRow, "n" | "moverLabel">[] = [];
  const add = (r: Omit<PathRow, "n" | "moverLabel" | "counted"> & { counted?: boolean }) =>
    rows.push({ counted: r.mover !== "fyi", ...r });

  // Review, from the same facts the reviews are drawn from elsewhere.
  const humans = (i.reviews ?? []).filter((r) => !r.isBot && r.author?.toLowerCase() !== (i.author ?? "").toLowerCase());
  const changesBy = [...humans].filter((r) => r.state === "CHANGES_REQUESTED")
    .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
  const changesWho = hv?.kind === "changes" && hv.who.length ? hv.who : [...new Set(changesBy.map((r) => r.author))];
  const changesRef = changesBy[0];
  const asked = (i.reviewers ?? []).map((r) => r.login);
  const rounds = humans.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED");
  // Any human review is history worth opening, whatever the headline says: the
  // button once hid behind "still wants changes" and vanished when a thread
  // count took the headline over.
  const historyCount = rounds.length;

  const b = (kind: MergeBlocker["kind"]) => blockers.find((x) => x.kind === kind);

  for (const bl of blockers) {
    switch (bl.kind) {
      case "draft":
        add({ id: "draft", kind: "draft", stage: "merge", title: "It is a draft", why: "A draft cannot be merged until it is marked ready for review.", mover: authorMover });
        break;
      case "locked":
        add({ id: "locked", kind: "locked", stage: "merge", title: bl.title, why: bl.detail, mover: bl.weight === "blocks" ? "other" : "fyi" });
        break;
      case "no-permission":
      case "restricted":
        add({ id: bl.kind, kind: bl.kind, stage: "merge", title: bl.title, why: bl.detail, mover: "other" });
        break;
      case "merge-queue": case "hooks": case "unseen":
        add({ id: bl.kind, kind: "note", stage: "merge", title: bl.title, why: bl.detail, mover: "fyi" });
        break;
      case "conflicts":
        add({
          id: "conflicts", kind: "conflicts", stage: "merge", title: bl.title,
          why: "Nothing else here moves until they are resolved and pushed.", mover: authorMover,
        });
        break;
      case "changes-requested": {
        const again = !!(hv?.kind === "changes" && (hv.askedAgain || hv.cleared));
        const who = nameList(changesWho) || "A reviewer";
        const when = agoShort(now, changesRef?.submittedAt ?? hv?.at);
        const askedWhen = agoShort(now, changesWho.map((w) => i.askedAt?.[w.toLowerCase()]).filter(Boolean).sort().pop());
        add({
          id: "changes", kind: "changes", stage: "review", title: "Changes requested",
          sub: again
            ? `re-requested${askedWhen ? ` ${askedWhen}` : ""} · waiting on ${who}`
            : `by ${who}${when ? ` · ${when}` : ""}`,
          why: again
            ? `${who} was asked to look again; it clears when they approve.`
            : `Clears only when ${who} approves or the request is dismissed.`,
          mover: again ? reviewerMover : authorMover === "you" ? "you" : (hv?.mine ? "you" : "author"),
        });
        break;
      }
      case "review-required": {
        const names = asked.length ? nameList(asked) : "";
        add({
          id: "review-required", kind: "review-required", stage: "review", title: bl.title,
          sub: names ? `asked: ${names}` : "nobody has been asked yet",
          why: bl.detail,
          mover: names ? reviewerMover : authorMover,
        });
        break;
      }
      case "behind":
        add({
          id: "behind", kind: "behind", stage: "merge", title: bl.title, why: bl.detail,
          sub: i.behind ? plural(i.behind, "commit") : undefined,
          mover: bl.weight === "blocks" ? authorMover : "fyi",
        });
        break;
      case "unexplained":
        add({ id: "unexplained", kind: "unexplained", stage: "merge", title: bl.title, why: bl.detail, mover: "other" });
        break;
      case "computing":
        add({ id: "computing", kind: "computing", stage: "merge", title: bl.title, why: bl.detail, mover: "wait" });
        break;
      case "awaiting":
        add({ id: "awaiting", kind: "awaiting", stage: "required", title: bl.title, why: bl.detail, mover: "wait" });
        break;
      default:
        break; // checks are read from checksAll below; threads and the rest have rows of their own
    }
  }

  // Threads. Required to be resolved, or the very thing a review asked for.
  if (openThreads > 0) {
    const required = !!gate?.conversationResolution;
    const forReview = hv?.kind === "changes" || i.reviewDecision === "CHANGES_REQUESTED";
    add({
      id: "threads", kind: "threads", stage: "review", title: `${plural(openThreads, "review thread")} open`,
      why: required
        ? "Answering is not resolving: press Resolve on each after the reply."
        : forReview ? "They are what the review asked for: answer each, then press Resolve."
        : "This branch does not require them resolved, but they are still open questions.",
      mover: required || forReview ? authorMover : "fyi",
    });
  }

  // Required checks that are not through, each one on its own row.
  const missing = (gate?.requiredContexts ?? []).filter((n) => !new Set(all.map((c) => c.name)).has(n));
  for (const name of missing) {
    const waiting = i.awaitingChecks || all.some((c) => !c.done);
    add({
      id: `missing:${name}`, kind: "required-missing", stage: "required", title: name, pill: "required",
      why: i.awaitingChecks
        ? "The branch just moved; GitHub creates the runs a few seconds after the push."
        : waiting
        ? "Not started yet: a job that depends on others starts when they finish."
        : "GitHub is waiting for it and nothing is running. If the workflow did not trigger, push or run it by hand.",
      mover: waiting ? "ci" : authorMover,
    });
  }
  const shownGated = gated.filter((c) => c.state !== "success" && c.state !== "skipped" && c.state !== "neutral");
  const seenKeys = new Map<string, number>();
  for (const c of shownGated) seenKeys.set(key(c), (seenKeys.get(key(c)) ?? 0) + 1);
  for (const c of shownGated) {
    const { workflow, job } = workflowOf(c);
    const dupe = (seenKeys.get(key(c)) ?? 0) > 1 && c.event;
    const sub = [workflow, dupe ? c.event : ""].filter(Boolean).join(" · ") || undefined;
    const isReq = c.required === true;
    // GitHub's own title when the check wrote one ("3 tests failed"), as a sentence.
    const written = c.title?.trim();
    const generic = written ? (/[.!?]$/.test(written) ? written : `${written}.`) : checkKindLine(c, isReq);
    const link = c.url ? { label: "Open log ↗", url: c.url } : undefined;
    const idBase = `check:${c.workflow}:${c.name}:${c.event ?? ""}`;
    if (c.state === "failure" && !c.cancelled) {
      const took = c.startedAt && c.completedAt ? Date.parse(c.completedAt) - Date.parse(c.startedAt) : 0;
      add({
        id: idBase, kind: "check-failing", stage: "required", title: job, sub, pill: isReq ? "required" : undefined,
        why: `${generic}${took > 0 ? ` Failed after ${fmtDuration(took)}.` : " Failed."}`,
        mover: authorMover, ring: { mode: "failed" }, link,
      });
    } else if (c.cancelled) {
      add({
        id: idBase, kind: "check-cancelled", stage: "required", title: job, sub, pill: isReq ? "required" : undefined,
        why: "Cancelled by a newer push or a concurrency rule; a new run is expected.",
        mover: "ci", ring: { mode: "queued" }, link,
      });
    } else {
      const e = elapsedOf(c);
      const t = typical.get(tkey(c)) ?? typical.get(key(c));
      const left = remainingOf(c);
      const prog = e === null ? "Not started yet."
        : t && left !== null ? `${fmtDuration(e)} of ~${fmtDuration(t)}.`
        : t ? `${fmtDuration(e)}, longer than the ${fmtDuration(t)} it took before.`
        : `Running for ${fmtDuration(e)}.`;
      add({
        id: idBase, kind: e === null ? "check-queued" : "check-running", stage: "required", title: job, sub,
        pill: isReq ? "required" : undefined, why: `${generic} ${prog}`, mover: "ci",
        ring: e === null ? { mode: "queued" } : { mode: "running", ...(t && e < t ? { fraction: e / t } : t ? { fraction: 1 } : null) },
        link,
      });
    }
  }

  // A blocked pull request with nothing said: GitHub's own word, not a green light.
  if (!willMerge && !rows.some((r) => r.counted) && i.state === "OPEN") {
    add({
      id: "state", kind: "unexplained", stage: "merge", title: "GitHub says it cannot be merged yet",
      why: i.mergeState === "UNKNOWN" ? "It computes mergeability lazily; this settles in a few seconds." : "GitHub did not say which rule is unmet; its own page lists everything.",
      mover: i.mergeState === "UNKNOWN" ? "wait" : "other",
    });
  }

  // What is already decided on the review side: each human's latest verdict,
  // when it is an approval nobody has asked to be redone. Not a blocker, so
  // never counted; a bot's approval is not a person's and is not listed.
  const latest = new Map<string, PrReview>();
  for (const r of [...humans].sort((a, c) => (a.submittedAt || "").localeCompare(c.submittedAt || ""))) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(r.author.toLowerCase(), r);
  }
  const askedLc = new Set(asked.map((a) => a.toLowerCase()));
  const approvals = [...latest.values()].filter((r) => r.state === "APPROVED" && !askedLc.has(r.author.toLowerCase()))
    .sort((a, c) => (c.submittedAt || "").localeCompare(a.submittedAt || ""));
  const reviewers = new Set([...latest.keys(), ...(i.reviewers ?? []).filter((r) => !r.isTeam).map((r) => r.login.toLowerCase())]);
  for (const r of approvals) {
    const when = agoShort(now, r.submittedAt);
    add({
      id: `approved-${r.author.toLowerCase()}`, kind: "approved", stage: "review",
      title: `Approved by ${r.author}${when ? ` · ${when}` : ""}`,
      why: "Already done; it counts unless new commits or a dismissal undo it.", mover: "done", counted: false,
    });
  }

  // Order: what needs a person, then a reviewer, then time. Stable inside.
  const ordered = rows
    .map((r, idx) => ({ r, idx }))
    .sort((a, c) => (a.r.counted === c.r.counted ? 0 : a.r.counted ? -1 : 1)
      || rankOf(a.r.mover) - rankOf(c.r.mover)
      || STAGE_ORDER.indexOf(a.r.stage) - STAGE_ORDER.indexOf(c.r.stage)
      || a.idx - c.idx)
    .map(({ r }, k): PathRow => ({ ...r, n: k + 1, moverLabel: MOVER_LABEL[r.mover] }));
  const counted = ordered.filter((r) => r.counted);
  const first = counted[0] ?? null;
  const ready = !first;

  // ------------------------------------------------------------- other CI
  const cnt = { passed: 0, failed: 0, running: 0, queued: 0, skipped: 0 };
  for (const c of others) {
    if (c.state === "success") cnt.passed++;
    else if (c.state === "failure") cnt.failed++;
    else if (c.state === "skipped" || c.state === "neutral") cnt.skipped++;
    else if (c.startedAt) cnt.running++;
    else cnt.queued++;
  }
  const otherCi: OtherCi | null = others.length === 0 ? null : (() => {
    const textBits = [`${cnt.running} running`, `${cnt.passed} passed`];
    if (cnt.failed > 0) textBits.push(`${cnt.failed} failed`);
    if (cnt.queued > 0) textBits.push(`${cnt.queued} queued`);
    textBits.push(`${cnt.skipped} skipped`);
    const behindBit = i.behind && i.behind > 0
      ? ` · ${i.behind} behind ${base}${gate?.upToDate === true ? " (must update first)" : " (fine)"}` : "";
    const seg = (k: OtherCi["segments"][number]["key"], label: string, count: number) => ({ key: k, label: `${count} ${label}`, count });
    return {
      total: others.length, ...cnt, requiredKnown: !!gate,
      sub: gate ? `not required · ${plural(others.length, "check")}` : `GitHub did not say which are required · ${plural(others.length, "check")}`,
      text: `${textBits.join(" · ")} of ${others.length}`,
      tail: `${conflicted ? "Conflicts with " + base : "No conflicts"}${behindBit}`,
      segments: [
        seg("passed", "passed", cnt.passed), seg("failed", "failed", cnt.failed), seg("running", "running", cnt.running),
        seg("skipped", "skipped", cnt.skipped), seg("queued", "queued", cnt.queued),
      ].filter((s) => s.count > 0),
    };
  })();

  // ------------------------------------------------------------------ ETA
  const runningGated = shownGated.filter((c) => !c.done && !c.cancelled);
  const gatedWait = counted.filter((r) => r.mover === "ci" || r.mover === "wait");
  const etas = runningGated.map(remainingOf);
  const etaMs = runningGated.length > 0 && gatedWait.length === runningGated.length && etas.every((x): x is number => x !== null)
    ? Math.max(...etas) : null;
  const eta = etaMs === null ? null : fmtEta(etaMs);

  // ---------------------------------------------------------------- stages
  const inStage = (s: StageKey) => counted.filter((r) => r.stage === s);
  const currentKey: StageKey = first ? first.stage : "merge";

  // Review
  const revRows = inStage("review");
  const approvedBy = hv?.kind === "approved" ? nameList(hv.who) : "";
  /*
   * WHAT THE REVIEWER DECIDED is said whatever else blocks. A pull request
   * approved sixteen hours earlier read as unapproved when this box listed only
   * obstacles, and the approval was on screen nowhere. It is a stage of its own
   * and it is in the hero when nothing else is: a person decided, and a failing
   * check does not un-decide it. Commits landed after the approval are said with
   * GitHub's own answer on whether it still counts (see staleApproval) rather
   * than as "approved" alone.
   *
   * `humanReview` is the source, not `reviewVerdict` over the roster: the server
   * knows who the author is and who is still outstanding, which the browser
   * cannot see, and the board card reads the same field.
   */
  const approval = hv?.kind === "approved" && hv.stale
    ? staleApproval(i.reviewDecision, hv.mine ? "You approved" : approvedBy ? `Approved by ${approvedBy}` : "Approved", gate)
    : null;
  const approvalStale = !!approval && (hv?.askedAgain || !approval.counts);
  const approvedSaid = hv?.kind === "approved"
    ? (approval ? approval.head : hv.mine ? "You approved" : approvedBy ? `Approved by ${approvedBy}` : "Approved")
    : "";
  const reviewStage = ((): Pick<Stage, "status" | "sub"> => {
    const chg = revRows.find((r) => r.kind === "changes");
    if (chg) {
      const bits: string[] = [];
      if (currentKey === "review" && first?.mover === "you") bits.push("you are here");
      else bits.push(chg.mover === "reviewer" ? "waiting on a second look" : `${nameList(changesWho) || "a reviewer"} wants changes`);
      if (openThreads > 0) bits.push(plural(openThreads, "thread"));
      if (approvals.length) bits.unshift(`${approvals.length} of ${reviewers.size} approved`);
      if (approvals.length && chg.mover === "reviewer") bits[1] = `waiting on ${nameList(changesWho) || "a reviewer"}`;
      return { status: chg.mover === "reviewer" ? "wait" : "blocked", sub: bits.join(" · ") };
    }
    const req = revRows.find((r) => r.kind === "review-required");
    if (req) return { status: req.mover === "reviewer" ? "wait" : "blocked", sub: req.sub ?? "needs a review" };
    const thr = revRows.find((r) => r.kind === "threads");
    if (thr) return { status: "blocked", sub: currentKey === "review" && thr.mover === "you" ? `you are here · ${plural(openThreads, "thread")}` : plural(openThreads, "open thread") };
    if (i.reviewDecision === "APPROVED" || hv?.kind === "approved") {
      const said = approvedSaid || "Approved";
      return { status: approvalStale ? "wait" : "done", sub: said.charAt(0).toLowerCase() + said.slice(1) };
    }
    if (hv?.kind === "awaiting") return { status: "idle", sub: `asked ${nameList(hv.who)} · not required` };
    if (hv?.kind === "commented") return { status: "idle", sub: "reviewed, no verdict · not required" };
    return { status: "done", sub: gate && gate.approvals === 0 ? "no review required" : "no review yet" };
  })();

  // Required checks
  const reqRows = inStage("required");
  const gatedDone = gated.filter((c) => c.state === "success").length;
  const requiredStage = ((): Pick<Stage, "status" | "sub" | "big"> => {
    if (!gate && gated.length === 0) return { status: "idle", sub: "GitHub did not say which are required" };
    if (gated.length === 0 && reqRows.length === 0) return { status: "done", sub: "none required" };
    const failing = reqRows.filter((r) => r.kind === "check-failing");
    if (failing.length) return { status: "blocked", sub: `${failing.length} failing · fix or re-run`, big: `${failing.length} failing` };
    if (reqRows.length) {
      const running = reqRows.filter((r) => r.kind === "check-running").length;
      const queued = reqRows.length - running;
      const bits = [running ? `${running} running` : "", queued ? `${queued} ${reqRows.some((r) => r.kind === "required-missing") ? "not started" : "queued"}` : ""].filter(Boolean);
      return { status: "wait", sub: `${bits.join(" · ")} · by themselves`, ...(eta ? { big: eta.replace("about ", "~") } : null) };
    }
    return { status: "done", sub: `${gatedDone} passed` };
  })();

  // Other CI
  const otherStage: Pick<Stage, "status" | "sub"> = !otherCi
    ? { status: "idle", sub: "none" }
    : cnt.running + cnt.queued > 0 ? { status: "idle", sub: `optional · ${cnt.running + cnt.queued} running` }
    : cnt.failed > 0 ? { status: "idle", sub: `optional · ${cnt.failed} failing` }
    : { status: "done", sub: `optional · ${cnt.passed} passed` };

  // Merge
  const mergeRows = inStage("merge");
  const earlier = [inStage("review").length ? 1 : 0, inStage("required").length ? 2 : 0].filter(Boolean);
  const mergeStage: Pick<Stage, "status" | "sub"> = ready
    ? { status: "done", sub: "ready" }
    : mergeRows.length && currentKey === "merge" ? { status: "blocked", sub: mergeRows[0]!.title }
    : earlier.length ? { status: "idle", sub: `opens after ${earlier.join(" and ")}` }
    : { status: "idle", sub: mergeRows[0]?.title ?? "waiting" };

  const stages: Stage[] = [
    { key: "review", n: 1, label: "Review", ...reviewStage, current: currentKey === "review" },
    { key: "required", n: 2, label: "Required checks", ...requiredStage, current: currentKey === "required" },
    { key: "other", n: 3, label: "Other CI", ...otherStage, current: false },
    { key: "merge", n: 4, label: "Merge", ...mergeStage, current: currentKey === "merge" },
  ];

  // ------------------------------------------------------------------ hero
  const primaryNeedsPerson = counted.filter((r) => r.mover === "you" || r.mover === "author" || r.mover === "other");
  const ciRows = counted.filter((r) => r.mover === "ci" || r.mover === "wait");
  const ciLine = ciRows.length
    ? `CI is finishing the ${ciRows.length === 1 ? "required check" : plural(ciRows.length, "required check")} by itself — nothing to do there.`
    : undefined;
  const historyAction: PathAction | undefined = historyCount > 0 ? { id: "history", label: `Review history (${historyCount})` } : undefined;
  const failingRows = counted.filter((r) => r.kind === "check-failing");

  const hero: Hero = ((): Hero => {
    if (!first) {
      const bits: string[] = [];
      if (approvedSaid) bits.push(approvedSaid);
      if (gated.length) bits.push(plural(gated.length, "required check") + " passed");
      else if (all.length === 0) bits.push(i.awaitingChecks ? "waiting for the checks to start" : "no checks reported on this commit");
      if (!conflicted) bits.push(`no conflicts with ${base}`);
      const running = cnt.running + cnt.queued;
      if (running > 0) bits.push(`${running} other ${running === 1 ? "check is" : "checks are"} still running, none required`);
      const armed = i.autoArmed ? "Auto-merge is armed." : "";
      const behind = rows.some((r) => r.kind === "behind");
      const sub = [bits.join(" · "), armed].filter(Boolean).join(" ");
      return behind
        ? {
          tone: "ready", eyebrow: "READY TO MERGE · BEHIND " + base.toUpperCase(),
          parts: [{ text: `Ready to merge, but it is behind ${base}.` }],
          sub: `You can merge anyway; the checks that passed ran against an older ${base}, so this exact combination is untested.`,
          primary: { id: "merge", label: "Merge pull request" }, secondary: { id: "update-branch", label: "Update branch" },
        }
        : {
          tone: "ready", eyebrow: "READY TO MERGE", parts: [{ text: "Ready to merge." }], sub: sub || undefined,
          primary: { id: "merge", label: "Merge pull request" },
        };
    }

    const f = first;
    const eyebrow = f.mover === "you" ? "MERGING IS BLOCKED · NEXT STEP IS YOURS"
      : f.mover === "author" ? "MERGING IS BLOCKED · NEXT STEP IS THE AUTHOR'S"
      : f.mover === "reviewer" ? "MERGING IS BLOCKED · WAITING ON REVIEW"
      : f.mover === "ci" ? "WAITING ON CI · NOTHING TO DO"
      : f.mover === "wait" ? "WAITING ON GITHUB"
      : "MERGING IS BLOCKED · NOT YOURS TO MOVE";
    const tone: Hero["tone"] = f.mover === "you" || f.mover === "author" ? "you" : f.mover === "other" ? "stuck" : "wait";
    const mk = (parts: HeroPart[], extra: Partial<Hero> = {}): Hero => ({ tone, eyebrow, parts, ...extra });
    const t = (text: string): HeroPart => ({ text });
    const em = (text: string): HeroPart => ({ text, em: true });
    const github: PathAction = { id: "open-github", label: "Open on GitHub ↗" };

    switch (f.kind) {
      case "draft":
        return mk([t("This is still a draft. Mark it ready for review to start the merge path.")], {
          primary: f.mover === "you" ? { id: "mark-ready", label: "Mark ready for review" } : undefined,
          sub: ciLine,
        });
      case "conflicts":
        return mk([t(`It conflicts with ${base}. Resolve ${i.conflictFiles ? plural(i.conflictFiles, "file") : "the conflicts"} and push.`)], {
          primary: f.mover === "you" ? { id: "resolve-conflicts", label: "Resolve conflicts" } : undefined,
          sub: "Nothing else here moves until then.",
        });
      case "locked": {
        const bl = b("locked");
        return mk([em(base), t(" is locked. Nothing merges into it until it is unlocked.")], {
          sub: bl?.detail, primary: github,
        });
      }
      case "no-permission":
        return mk([t("You cannot merge here. Somebody with write access has to.")], { sub: f.why, primary: github });
      case "restricted":
        return mk([t(`You are not allowed to push to ${base}. Somebody on its list has to merge this.`)], { sub: f.why, primary: github });
      case "check-failing": {
        const one = failingRows.length === 1;
        const names: HeroPart[] = failingRows.length <= 2
          ? failingRows.flatMap((r, k) => [...(k ? [t(" and ")] : []), em(r.title)])
          : [em(plural(failingRows.length, "required check"))];
        const verb = one ? " is failing." : " are failing.";
        const url = failingRows.find((r) => r.link)?.link?.url;
        const yours = f.mover === "you";
        return mk([...names, t(yours ? `${verb} ${one ? "Open the log, fix it or re-run it." : "Open the logs, fix them or re-run them."}` : `${verb} The author has to fix ${one ? "it" : "them"} or re-run.`)], {
          primary: url ? { id: "open-log", label: "Open log ↗", url } : { id: "rerun", label: "Re-run failed" },
          secondary: url ? { id: "rerun", label: "Re-run failed" } : undefined,
          sub: ciLine,
        });
      }
      case "required-missing":
        return mk([em(f.title), t(f.mover === "ci" ? " has not reported yet. It is required." : " never reported. GitHub is waiting for it and nothing is running.")], {
          sub: f.why, primary: f.mover === "ci" ? undefined : github,
        });
      case "changes": {
        const who = nameList(changesWho) || "A reviewer";
        if (f.mover === "reviewer") {
          return mk([em(who), t(" was asked to look again. The changes are in; it is their move.")], { secondary: historyAction, sub: ciLine });
        }
        if (f.mover === "author") {
          return mk([em(who), t(" wants changes. The author has to answer them.")], { secondary: historyAction, sub: ciLine });
        }
        if (!i.viewerDidAuthor) {
          return mk([t("You asked for changes. Look again once the author has answered.")], { secondary: historyAction });
        }
        const tail = openThreads > 0
          ? `Answer the ${plural(openThreads, "thread")}, then ${eta ? `this can merge in ${eta}` : "this can merge"}.`
          : "Address them and ask for another look.";
        return mk([em(who), t(` still wants changes. ${tail}`)], {
          primary: openThreads > 0
            ? { id: "go-thread", label: "Go to first open thread →" }
            : { id: "go-review", label: "Go to the review →", nodeId: changesRef?.nodeId, url: changesRef?.url ?? hv?.url },
          secondary: historyAction, sub: ciLine,
          after: `then re-request review from ${changesWho[0] ?? "the reviewer"}`,
        });
      }
      case "review-required": {
        if (f.mover === "reviewer") {
          return mk([t("Waiting on "), em(nameList(asked)), t(" to review.")], { sub: f.why, secondary: historyAction });
        }
        if (f.mover === "you" && i.viewerRequested) {
          return mk([t("Your review is what this is waiting for.")], { sub: f.why });
        }
        return mk([t("It needs an approving review, and nobody has been asked.")], {
          sub: "Pick a reviewer from the Reviewers list on this page.", secondary: historyAction,
        });
      }
      case "threads":
        return mk([t(`${plural(openThreads, "review thread")} still open. Answer them and press Resolve on each.`)], {
          primary: { id: "go-thread", label: "Go to first open thread →" }, sub: ciLine,
        });
      case "behind":
        return mk([t(`It has to be up to date with ${base} first.`)], {
          primary: f.mover === "you" ? { id: "update-branch", label: "Update branch" } : undefined, sub: f.why,
        });
      case "unexplained":
        return f.mover === "wait"
          ? mk([t("GitHub is still working out whether it can merge.")], { sub: "It computes mergeability lazily; this settles in a few seconds." })
          : mk([t("GitHub is blocking it without saying why.")], { sub: b("unexplained")?.detail ?? f.why, primary: github });
      case "computing":
        return mk([t("GitHub is still working out whether it can merge.")], { sub: f.why });
      case "awaiting":
        return mk([t("Waiting for the checks to start.")], { sub: f.why });
      default: {
        // Only CI is left: the n required checks, and how long.
        const n = ciRows.length;
        const they = n === 1 ? "The required check" : `The ${n} required checks`;
        return mk([t(`Waiting on CI. ${they} ${eta ? `should finish in ${eta}` : n === 1 ? "is still running" : "are still running"}.`)], {
          sub: i.autoArmed ? "Auto-merge is armed: it merges by itself when they pass." : "Nothing to do until they finish. Merge when green takes it from there.",
          primary: i.autoArmed ? undefined : { id: "arm-auto", label: "Merge when green" },
        });
      }
    }
  })();
  // Whatever the headline, a pull request with reviews can show them.
  if (historyAction && hero.secondary?.id !== "history") {
    if (hero.secondary) hero.also = historyAction; else hero.secondary = historyAction;
  }

  // --------------------------------------------------------------- callout
  const people = primaryNeedsPerson.length + counted.filter((r) => r.mover === "reviewer").length;
  const callout: Callout | null = counted.length === 0 ? null
    : ciRows.length && people
      ? {
        tone: "warn",
        text: `"Merge when green" covers the CI rows only — ${people === 1 ? "row 1 is" : `rows 1–${people} are`} ${counted.slice(0, people).every((r) => r.mover === "you") ? "on you" : "not CI's to clear"}.`,
      }
    : ciRows.length
      ? { tone: "ok", text: `"Merge when green" covers ${counted.length === 1 ? "the one row" : `all ${counted.length} rows`} — nothing here needs a person.` }
    : null;

  return { ready, hero, stages, rows: ordered, count: counted.length, otherCi, callout, historyCount };
}
