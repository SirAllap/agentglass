/**
 * "Unstick": close a pull request GitHub has lost track of, reopen it, and wait
 * until GitHub has synced it again.
 *
 * Measured once, and rare: the branch ref had moved (a merge of the base landed
 * on it) while the pull request kept pointing at the old head, and mergeability
 * stayed UNKNOWN for more than an hour. Update branch was refused with "head sha
 * didn't match the current head ref". Closing and reopening the pull request made
 * GitHub resync its head; after that Update branch worked and CI started.
 *
 * Closing a pull request is not free (a tracker bot may move the linked card, a
 * chat notice goes out), so this file is mostly about WHEN the action is allowed
 * to exist and how it stops, not about how it runs:
 *
 *   - `unstickGate` is the only place that decides whether the action appears.
 *     It wants a hard-negative list to be empty, a stuck signal that holds NOW,
 *     that signal held across two separate looks and for long enough, and a
 *     normal Update branch already tried. Anything short of all of that shows
 *     nothing new: the honest sentence the panel already has, and a link to
 *     github.com.
 *   - `unstickLive` is the same hard list plus the signal, with no clock, for the
 *     server and for the first step of the run to re-check against a fresh read.
 *   - `runUnstick` is the step machine, with every side effect injected, so each
 *     failure point is a test and not a story.
 *
 * Ceilings, said so the next reader can tell a chosen limit from a gap: the clock
 * of a signal starts when THIS app first saw it, not when GitHub began to be
 * wrong, so a pull request found already stuck reads as short and waits; "the base
 * is locked" is only known when GitHub tells a non-admin (see PrMergeGate.locked),
 * and a lock GitHub does not show is let through, with the run's own checks as the net;
 * the thresholds, the looks and the Update branch trial live in the window only, and the
 * server re-checks the hard list and the signal on a fresh read but holds no clock.
 */

/** Branch ref ahead of the pull request's head, held this long, before it counts. */
export const LAG_AFTER_MS = 10 * 60_000;
/** Mergeability UNKNOWN held this long, before it counts. */
export const UNKNOWN_AFTER_MS = 30 * 60_000;
/** Separate looks at the pull request that must all have seen the signal. */
export const MIN_LOOKS = 2;
/** Two reads closer than this are one look: a re-render is not a second opinion. */
export const LOOK_GAP_MS = 45_000;
/** A run nobody looked at for this long is not a run: it may have flickered unseen, so the clock starts over. */
export const RUN_STALE_MS = 30 * 60_000;
/** After an accepted Update branch, how long to give GitHub before it counts as "had no effect". */
export const TRIAL_SETTLE_MS = 2 * 60_000;
/** How long GitHub gets to report the pull request closed, and then open and synced. */
export const CLOSED_WAIT_MS = 30_000;
export const SYNC_WAIT_MS = 2 * 60_000;
const CLOSED_POLL_MS = 2_000;
const SYNC_POLL_MS = 4_000;
/** Reads that may fail in a row while waiting before the wait gives up. */
const READ_FAILS_ALLOWED = 2;

// ── the signal held over time ───────────────────────────────────────────────

/** A condition seen on consecutive looks: since when, and by how many separate looks. */
export interface Run { since: number; looks: number; lastLookAt: number }

/**
 * Fold one look into a run. The condition not holding ends the run (null), so a
 * flicker resets the clock; a look inside LOOK_GAP_MS of the last counted one is
 * the same look.
 */
export function lookAt(run: Run | null, holds: boolean, now: number): Run | null {
  if (!holds) return null;
  if (!run || now < run.since || now - run.lastLookAt > RUN_STALE_MS) return { since: now, looks: 1, lastLookAt: now };
  if (now - run.lastLookAt < LOOK_GAP_MS) return run;
  return { ...run, looks: run.looks + 1, lastLookAt: now };
}

/** What a normal Update branch did here. `requested` is GitHub's 202 with the head it was pressed on. */
export type UpdateTrial =
  | { kind: "refused"; at: number }
  | { kind: "requested"; at: number; headBefore: string };

// ── facts ───────────────────────────────────────────────────────────────────

export interface UnstickFacts {
  state: string;
  isDraft: boolean;
  /** The viewer opened it. */
  author: boolean;
  /** The viewer may push to it and edit it, and the repository role is writer or better when known. */
  canWrite: boolean;
  /** The head is in a fork. */
  crossRepo: boolean;
  /** Any check is still running, or the rollup has not finished. */
  checksRunning: boolean;
  autoMerge: boolean;
  inMergeQueue: boolean;
  changesRequested: boolean;
  /** The base is locked, or this app cannot tell at all. */
  baseLocked: boolean;
  headSha: string;
  /** The branch on GitHub right now, when it was read. */
  refSha: string | null;
  mergeState: string;
}

/** The slice of a PrDetail this reads. A structural type so shared/ imports no web or server module. */
export interface DetailLike {
  state: string;
  isDraft: boolean;
  viewerDidAuthor: boolean;
  viewerCanUpdate?: boolean;
  headRepoOwner?: string;
  isCrossRepository?: boolean;
  checks: { total: number; pending: number; allDone: boolean };
  autoMerge?: unknown;
  reviewDecision?: string | null;
  gate?: { permission?: string; locked: boolean | null; inQueue: boolean } | null;
  headSha?: string;
  commits?: { oid: string }[];
  mergeState: string;
}

const WRITER_ROLES = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

export function factsOf(d: DetailLike, refSha: string | null, repoOwner: string): UnstickFacts {
  const head = d.headSha ?? d.commits?.[d.commits.length - 1]?.oid ?? "";
  const role = d.gate?.permission;
  return {
    state: d.state,
    isDraft: d.isDraft,
    author: d.viewerDidAuthor === true,
    canWrite: d.viewerCanUpdate === true && (role === undefined || WRITER_ROLES.has(role)),
    crossRepo: d.isCrossRepository === true
      || (!!d.headRepoOwner && !!repoOwner && d.headRepoOwner.toLowerCase() !== repoOwner.toLowerCase()),
    checksRunning: d.checks.pending > 0 || (d.checks.total > 0 && !d.checks.allDone),
    autoMerge: !!d.autoMerge,
    inMergeQueue: d.gate?.inQueue === true,
    changesRequested: d.reviewDecision === "CHANGES_REQUESTED",
    baseLocked: d.gate ? d.gate.locked === true : true,
    headSha: head,
    refSha,
    mergeState: d.mergeState,
  };
}

// ── the gate ────────────────────────────────────────────────────────────────

export type UnstickNo =
  | "not-open" | "merged" | "draft" | "not-author" | "no-write" | "fork"
  | "checks-running" | "auto-merge" | "merge-queue" | "changes-requested" | "base-locked"
  | "no-signal" | "too-early" | "one-look" | "update-untried";

/** In the order they are checked: the first that applies is the one reported. */
export function unstickHard(f: UnstickFacts): UnstickNo | null {
  if (f.state === "MERGED") return "merged";
  if (f.state !== "OPEN") return "not-open";
  if (f.isDraft) return "draft";
  if (!f.author) return "not-author";
  if (!f.canWrite) return "no-write";
  if (f.crossRepo) return "fork";
  if (f.checksRunning) return "checks-running";
  if (f.autoMerge) return "auto-merge";
  if (f.inMergeQueue) return "merge-queue";
  if (f.changesRequested) return "changes-requested";
  if (f.baseLocked) return "base-locked";
  return null;
}

export type UnstickSignal = "lag" | "unknown";

/**
 * The stuck condition as it reads right now, with no clock. GitHub saying it has
 * not decided (UNKNOWN) is required in both forms: a branch ahead of its pull request
 * while mergeability reads anything else is not the measured case, and the row that
 * carries the button is the "GitHub has not decided" row, so the gate and the button
 * must agree. The lag form is the one with a cause, and has the shorter clock.
 */
export function unstickSignalNow(f: UnstickFacts): UnstickSignal | null {
  if (f.mergeState !== "UNKNOWN") return null;
  if (f.refSha && f.headSha && f.refSha !== f.headSha) return "lag";
  return "unknown";
}

/** The hard list and the signal, against one fresh read. What the server and the run's first step ask. */
export function unstickLive(f: UnstickFacts): { ok: true; signal: UnstickSignal } | { ok: false; reason: UnstickNo } {
  const hard = unstickHard(f);
  if (hard) return { ok: false, reason: hard };
  const signal = unstickSignalNow(f);
  return signal ? { ok: true, signal } : { ok: false, reason: "no-signal" };
}

export interface GateInput {
  now: number;
  facts: UnstickFacts;
  /** How long the branch ref has been ahead of the pull request's head, as looks. */
  lag: Run | null;
  /** How long mergeability has read UNKNOWN. */
  unknown: Run | null;
  /** A normal Update branch, if this app pressed one on this head. */
  trial: UpdateTrial | null;
}

export type UnstickGate = { show: true; signal: UnstickSignal; minutes: number } | { show: false; reason: UnstickNo };

/** Whether the earlier Update branch counts: refused, or accepted and then nothing moved. */
export function trialCounts(t: UpdateTrial | null, f: UnstickFacts, now: number, since?: number): boolean {
  if (!t) return false;
  // A refusal from before this spell began says nothing about it.
  if (t.kind === "refused") return since === undefined || t.at >= since;
  return now - t.at >= TRIAL_SETTLE_MS && !!f.headSha && t.headBefore === f.headSha;
}

/**
 * Whether the Unstick action appears. Every condition is required; when one is
 * missing the reason is the first of them in the order below, and the panel shows
 * nothing new. `show: false` is the answer for almost every pull request there is.
 */
export function unstickGate(i: GateInput): UnstickGate {
  const live = unstickLive(i.facts);
  if (!live.ok) return { show: false, reason: live.reason };
  const run = live.signal === "lag" ? i.lag : i.unknown;
  const need = live.signal === "lag" ? LAG_AFTER_MS : UNKNOWN_AFTER_MS;
  if (!run || run.looks < 1) return { show: false, reason: "too-early" };
  if (i.now - run.since < need) return { show: false, reason: "too-early" };
  if (run.looks < MIN_LOOKS) return { show: false, reason: "one-look" };
  if (!trialCounts(i.trial, i.facts, i.now, run.since)) return { show: false, reason: "update-untried" };
  return { show: true, signal: live.signal, minutes: Math.floor((i.now - run.since) / 60_000) };
}

/** One plain sentence per reason, for the dialog opened on a pull request that does not qualify and for the run's first step. */
export const NO_WORDS: Record<UnstickNo, string> = {
  "not-open": "The pull request is not open.",
  "merged": "The pull request is merged. There is nothing to unstick.",
  "draft": "The pull request is a draft.",
  "not-author": "Only the author should close and reopen a pull request this way, and you did not open this one.",
  "no-write": "You do not have write access here, so GitHub may not let you reopen it after closing.",
  "fork": "The branch lives in a fork. Reopening a fork's pull request is not always possible for you, so this is not offered.",
  "checks-running": "Checks are running. Closing and reopening would restart them.",
  "auto-merge": "Auto-merge is armed. Closing would disarm it.",
  "merge-queue": "The pull request is in the merge queue.",
  "changes-requested": "A reviewer has requested changes; closing it would bury that request.",
  "base-locked": "The base branch is locked, or this pull request's base rules were not loaded, so a reopen cannot be promised.",
  "no-signal": "It does not look stuck: the pull request follows its branch and GitHub has decided on mergeability.",
  "too-early": "It has not been like this for long enough to call it stuck.",
  "one-look": "It looked stuck once, but it has not been seen stuck on a second, separate refresh yet.",
  "update-untried": "Press Update branch first. Unstick is only for when that was refused or had no effect.",
};

// ── the dialog's words ──────────────────────────────────────────────────────

export const UNSTICK_LABEL = "Unstick: close, reopen and sync";
/** The confirm button, in the dialog that already says which pull request. */
export const UNSTICK_CONFIRM = "Close, reopen and sync";
export const RARE_LINE = "This is rare; if you are not sure, open it on github.com instead.";

/** What the person is told before the one click. Plain words, side effects first. */
export function unstickWhy(signal: UnstickSignal, minutes: number, head: string, ref: string | null): string {
  const short = (s: string) => s.slice(0, 7);
  return signal === "lag"
    ? `The branch on GitHub is at ${short(ref ?? "")} but this pull request still points at ${short(head)}, and has for about ${minutes} min. Update branch did not fix it.`
    : `GitHub has not said whether this pull request can merge for about ${minutes} min, and Update branch did not change that.`;
}

export const UNSTICK_EFFECTS: readonly string[] = [
  "The pull request is closed, then reopened, one step at a time. You see each step.",
  "Closing fires GitHub's \"pull request closed\" events: a tracker bot may move the linked card, and a chat notice may go out.",
  "Reviews, commits and comments are kept. The run refuses to start while auto-merge is armed, checks on this head are running or changes are requested. Checks on the branch's newer commit are not seen and may restart.",
  "It stops at the first step that fails and says which. If it stops after the close, the pull request stays closed until you reopen it.",
  "Afterwards the card's status is read again; if it moved, you get a one-click way to put it back.",
];

// ── the linked card, before and after ───────────────────────────────────────

export interface CardReading { id: string; label: string; status: string; updated?: number }

export function cardMove(before: CardReading | null, after: CardReading | null): { changed: boolean; from: string; to: string } {
  const from = before?.status ?? "";
  const to = after?.status ?? "";
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return { changed: !!before && !!after && !same(from, to), from, to };
}

export function cardSentence(label: string, m: { changed: boolean; from: string; to: string }): string {
  return m.changed
    ? `${label} moved from ${m.from} to ${m.to} while the pull request was closed and reopened. Put it back?`
    : `${label} is still ${m.to || m.from}; nothing moved it.`;
}

// ── the step machine ────────────────────────────────────────────────────────

export type StepId = "check" | "card" | "close" | "closed" | "reopen" | "synced" | "card-after";

export const STEP_LABEL: Record<StepId, string> = {
  "check": "Check it is still stuck",
  "card": "Read the linked card's status",
  "close": "Close the pull request",
  "closed": "Wait until GitHub reports it closed",
  "reopen": "Reopen the pull request",
  "synced": "Wait until it is open and follows its branch",
  "card-after": "Read the card's status again",
};

export type StepStatus = "running" | "done" | "failed" | "skipped";
export interface StepNote { step: StepId; status: StepStatus; text?: string }

export type Look =
  | { ok: true; state: string; headSha: string; refSha: string | null; mergeState: string; facts?: UnstickFacts }
  | { ok: false; error: string };

export interface UnstickDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** One fresh read of the pull request. `full` carries the facts the gate needs. */
  look(full: boolean): Promise<Look>;
  /** Null when no card is linked. */
  card: (() => Promise<{ ok: true; card: CardReading } | { ok: false; error: string }>) | null;
  close(): Promise<{ ok: boolean; error?: string }>;
  reopen(): Promise<{ ok: boolean; error?: string }>;
}

export type PrAfter = "open" | "closed" | "unknown";

export type UnstickOutcome =
  | { ok: true; cardBefore: CardReading | null; cardAfter: CardReading | null; card: ReturnType<typeof cardMove> }
  | { ok: false; at: StepId; sentence: string; pr: PrAfter; /** A close went out, so automations may have fired even when the pull request is open again. */ closeSent: boolean; cardBefore: CardReading | null; cardAfter: CardReading | null; card: ReturnType<typeof cardMove> };

const short = (e: string | undefined) => (e ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given";

/**
 * Run the steps in order, stopping at the first failure. Each step is reported
 * as it starts and as it ends. `pr` in a failure says what state the pull request
 * was last known to be in, because "stopped" is not enough to act on when the
 * state is "closed".
 */
export async function runUnstick(deps: UnstickDeps, note: (n: StepNote) => void): Promise<UnstickOutcome> {
  let cardBefore: CardReading | null = null;
  let cardAfter: CardReading | null = null;
  let pr: PrAfter = "open";
  let closeSent = false;
  const finish = async (at: StepId, sentence: string): Promise<UnstickOutcome> => {
    // Once a close went out, the automations may already have moved the card: look, so the person can restore it.
    if (closeSent) cardAfter = await readCardQuietly();
    return { ok: false, at, sentence, pr, closeSent, cardBefore, cardAfter, card: cardMove(cardBefore, cardAfter) };
  };
  const readCardQuietly = async (): Promise<CardReading | null> => {
    if (!deps.card) return null;
    try { const r = await deps.card(); return r.ok ? r.card : null; } catch { return null; }
  };
  const fail = (at: StepId, sentence: string) => { note({ step: at, status: "failed", text: sentence }); return finish(at, sentence); };

  // 1. Still stuck, against a read taken now and not against the screen.
  note({ step: "check", status: "running" });
  const first = await deps.look(true).catch((e): Look => ({ ok: false, error: String(e) }));
  if (!first.ok) return fail("check", `Could not read the pull request, so nothing was changed. ${short(first.error)}`);
  if (!first.facts) return fail("check", "GitHub did not give the details needed to check it, so nothing was changed.");
  const live = unstickLive(first.facts);
  if (!live.ok) return fail("check", `${NO_WORDS[live.reason]} Nothing was changed.`);
  note({ step: "check", status: "done" });

  // 2. The card, before anything can move it.
  if (deps.card) {
    note({ step: "card", status: "running" });
    const r = await deps.card().catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) return fail("card", `Could not read the linked card's status, so I could not tell you afterwards whether closing moved it. Nothing was changed. ${short(r.error)}`);
    cardBefore = r.card;
    note({ step: "card", status: "done", text: r.card.status });
  } else note({ step: "card", status: "skipped", text: "No linked card." });

  // 3. Close.
  note({ step: "close", status: "running" });
  const closed = await deps.close().catch((e) => ({ ok: false, error: String(e) }));
  if (!closed.ok) {
    // A failed call is not proof nothing happened; the state is read, not assumed.
    const l = await deps.look(false).catch((): Look => ({ ok: false, error: "" }));
    pr = l.ok ? (l.state === "OPEN" ? "open" : "closed") : "unknown";
    closeSent = pr !== "open";
    return fail("close", pr === "open"
      ? `GitHub refused to close it, so nothing was changed. ${short(closed.error)}`
      : `Closing reported a failure (${short(closed.error)}) and the pull request is ${pr === "closed" ? "closed" : "in a state I could not read"}. Check it on github.com.`);
  }
  pr = "unknown";
  closeSent = true;
  note({ step: "close", status: "done" });

  // 4. Closed, as GitHub reports it.
  note({ step: "closed", status: "running" });
  const seenClosed = await waitFor(deps, false, CLOSED_WAIT_MS, CLOSED_POLL_MS, (l) => l.state === "CLOSED");
  if (seenClosed.kind !== "ok") {
    // What the last read said wins over the assumption: OPEN there means the close did not take.
    const l = seenClosed.last;
    pr = l?.ok ? (l.state === "OPEN" ? "open" : "closed") : "unknown";
    return fail("closed", seenClosed.kind === "unreadable"
      ? "The close was accepted but GitHub could not be read to confirm it. Check the pull request on github.com; it may be closed."
      : `GitHub did not report it closed within ${CLOSED_WAIT_MS / 1000} s${pr === "open" ? " and still shows it open" : ""}. Check it on github.com.`);
  }
  pr = "closed";
  note({ step: "closed", status: "done" });

  // 5. Reopen. From here a failure leaves the pull request closed, and says so.
  note({ step: "reopen", status: "running" });
  const reopened = await deps.reopen().catch((e) => ({ ok: false, error: String(e) }));
  if (!reopened.ok) return fail("reopen", `The pull request is closed and could not be reopened: ${short(reopened.error)}. Reopen it here, or on github.com.`);
  note({ step: "reopen", status: "done" });

  // 6. Open, and following its branch.
  note({ step: "synced", status: "running" });
  const synced = await waitFor(deps, false, SYNC_WAIT_MS, SYNC_POLL_MS, (l) => l.state === "OPEN" && !!l.refSha && l.headSha === l.refSha);
  if (synced.kind === "ok") pr = "open";
  else {
    const last = synced.last;
    if (last?.ok && last.state === "OPEN") pr = "open";
    else if (last?.ok) pr = "closed";
    else pr = "unknown";
    return fail("synced", synced.kind === "unreadable"
      ? "The pull request was reopened but GitHub could not be read to confirm it caught up. Check it on github.com."
      : last?.ok && last.state === "OPEN"
        ? `The pull request is open again but GitHub did not point it at the branch within ${SYNC_WAIT_MS / 60_000} min. It may still be catching up; check it on github.com before doing anything else.`
        : `The pull request did not show as open within ${SYNC_WAIT_MS / 60_000} min of reopening. Check it on github.com.`);
  }
  note({ step: "synced", status: "done" });

  // 7. The card again: the automations have had the whole run to fire.
  if (deps.card) {
    note({ step: "card-after", status: "running" });
    const r = await deps.card().catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      note({ step: "card-after", status: "failed", text: `Could not read the card again: ${short(r.error)}. Check its status yourself.` });
    } else {
      cardAfter = r.card;
      note({ step: "card-after", status: "done", text: r.card.status });
    }
  } else note({ step: "card-after", status: "skipped" });

  return { ok: true, cardBefore, cardAfter, card: cardMove(cardBefore, cardAfter) };
}

type Waited = { kind: "ok" } | { kind: "timeout"; last: Look | null } | { kind: "unreadable"; last: Look | null };

async function waitFor(deps: UnstickDeps, full: boolean, forMs: number, everyMs: number, done: (l: Extract<Look, { ok: true }>) => boolean): Promise<Waited> {
  const until = deps.now() + forMs;
  let fails = 0;
  let last: Look | null = null;
  for (;;) {
    last = await deps.look(full).catch((e): Look => ({ ok: false, error: String(e) }));
    if (last.ok) { fails = 0; if (done(last)) return { kind: "ok" }; }
    else if (++fails > READ_FAILS_ALLOWED) return { kind: "unreadable", last };
    if (deps.now() + everyMs > until) return { kind: "timeout", last };
    await deps.sleep(everyMs);
  }
}
