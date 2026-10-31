import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useOwnedQuestion } from "../lib/layerOwner.ts";
import { preparedLine, useStageHold } from "../lib/stageHold.ts";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { Select } from "./Select.tsx";
import { listMembers } from "../lib/listMembers.ts";
import { AssignPicker, useAskAssign } from "./AssignPicker.tsx";
import { hasExtras, planOf } from "../../../shared/stepBlocks.ts";
import { AskedExtras } from "./AskedExtras.tsx";
import { prContext, type ExtraItem } from "../lib/stepExtras.ts";
import { Spinner } from "./Spinner.tsx";
import { ALL_METHODS, MERGE_OPTION, mergeBody, mergeSubject, type MergeMethod, type MergeCommit } from "../../../shared/mergeMethod.ts";
import { LEAVE_ALONE, mergePreselect, movesCard, statusColor, statusOptions, type CardMove } from "../lib/cardMove.ts";
import { useClickupPrefs } from "../lib/clickupPrefs.ts";
import { resolveEnsure, stepChanges, type CardWrite, type Ensure, type PrAuthor } from "../lib/stepAssign.ts";
import { api } from "../lib/api.ts";
import { __forgetClickupSetup } from "../lib/clickupSetup.ts";
import { CardFrame, MergeJiraCard, MovePills } from "./MergeJiraCard.tsx";
import { jiraMergeMove, type JiraMergeCard } from "../lib/mergeJira.ts";
import { MOD_KEY } from "../lib/format.ts";
import { ArrowRightIcon, BranchIcon, CommitIcon, DoneIcon, InfoIcon, MergeIcon, SparkleIcon, UserIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { CLEANUP_KIND_ROWS, type CleanupKind } from "../lib/cleanupSettings.ts";
import { splitTail } from "../lib/cleanupPr.ts";
import { KIND_ICON } from "./CleanupSettings.tsx";
import "./mergeDialog.css";
import { ICON } from "../lib/iconSize.ts";
import { Button, Checkbox, INPUT, INPUT_STYLE, EDGE, Textarea } from "./workspace/Chrome.tsx";

/**
 * The last question before a pull request lands.
 *
 * It used to be the generic one-line prompt — a 520px box with a single input
 * labelled "Commit subject", into which a subject like
 * `Merge pull request #482 from acme/release-checkout-rounding-boundary` does
 * not fit, so the one thing you were being asked to check was scrolled out of
 * its own field.
 * Everything else the merge decides was invisible: the extended description
 * was never offered and landed empty, and the head branch was deleted without
 * ever being mentioned.
 *
 * GitHub's form is the shape to match, because it is the one people already
 * know and because every field in it is a decision that is permanent:
 *
 *   - what is landing, and where — stated, not assumed
 *   - the subject, in a field wide enough to read it
 *   - the extended description, prefilled the way GitHub prefills it
 *   - what happens to the branch afterwards
 *
 * Rebase has no commit of its own, so it gets the same frame with the message
 * fields replaced by what it will actually do — the same dialog, telling the
 * truth about a different operation, rather than a second one that looks
 * nothing like it.
 */

export type MergeSpec = {
  number: number;
  /** The pull request's address, for a comment's {pr_url}. */
  url?: string;
  title: string;
  method: MergeMethod;
  baseRefName: string;
  headRefName: string;
  headRepoOwner?: string;
  commits: MergeCommit[];
  /** The repository deletes the head branch itself, so we must not offer to. */
  repoDeletesBranch: boolean;
  /** The card this pull request came from, when it has one — see cardRef. The
   *  dialog resolves it against ClickUp itself, because the panel should not
   *  pay a round trip before it can open. */
  card?: { label: string; query: string; tracker?: "clickup" | "jira" } | null;
  /** Who opened the pull request, for the merge option's "Also assign: the pull request's author". */
  author?: PrAuthor | null;
  /**
   * Who was asked for a review and has not answered.
   *
   * Reported from a real pull request: an automation approved it, GitHub called
   * it mergeable, and the panel said "Ready to merge — nothing is standing in
   * the way" while a named person sat in "1 pending review". Nothing was wrong
   * about the mechanics — branch protection was satisfied — but the sentence
   * was about GitHub's rules and the reader was asking about their colleague.
   *
   * A warning and not a block, deliberately. There are good reasons to land
   * ahead of a review you asked for, and the panel does not know which day this
   * is; what it must not do is let the press happen without the fact on screen.
   */
  awaitingReview?: string[];
  /** Whether any of the approvals came from a person. An approval by automation
   *  is worth having and is not what "somebody looked at it" means. */
  humanApproved?: boolean;
  /** And whether one came from a machine. Both are needed, not one: `false` on
   *  the flag above also covers "nobody and nothing approved", and a sentence
   *  built from it alone told the reader a bot had signed off on a pull request
   *  no one had looked at. */
  botApproved?: boolean;
  /** Set when an agent staged this merge: the text it wrote and the name it gave
   *  itself. The fields open on it, editable, under a "prepared by" line, and the
   *  merge button (and the chord) stay dead for a moment. Nothing merges until the
   *  person presses it; the method on the spec is the one the agent named. */
  prefill?: { by: string; subject?: string; body?: string };
  /** The project's cleanup mode is "Offer at merge time": draw the tick "Clean up local leftovers". */
  offerCleanup?: boolean;
  /** With the tick: the kinds the project's settings include (shown as chips) and the safety blocks already in force (shown as reasons). Both absent = the card says nothing about them. */
  cleanupKinds?: CleanupKind[];
  cleanupHeld?: { title: string; why: string }[];
  /** The strategies the repository allows; the others are drawn off. Absent = all three. */
  allowed?: MergeMethod[];
};

/** What the dialog resolves to. `null` is a cancel. */
export type MergeChoice = {
  /** The strategy picked in the dialog; absent means the one the question named. */
  method?: MergeMethod;
  subject?: string;
  body?: string;
  deleteBranch: boolean;
  /** The tick "Clean up local leftovers" was on: the caller opens the dry run once the merge lands. */
  cleanup?: boolean;
  /** A step's comment and fields, as the dialog showed them, to send after the merge (each is a request of its own). */
  extras?: { id: string; label: string; items: ExtraItem[] };
  /** Set only when a status other than the card's own was picked. Absent means
   *  "leave the board alone", which is what the dialog opens on. */
  card?: {
    id: string; label: string; to: string; updated: number;
    /** What "Also assign" adds to the status write. Absent: the status alone is sent, as before. */
    write?: CardWrite;
    /** Said after the write: who was put on, and why nobody was when the author could not be told. */
    note?: string;
    /** A Jira card: `id` is its key and `to` the id of the move, not a status name. */
    tracker?: "jira";
    /** A Jira move that comes from the merge step: run as the step, so what the step also does rides on it. */
    step?: true;
    /** Jira only: the status's own name (what a step resolves), and a step told to leave the card where it is. */
    toStatus?: string;
    stay?: true;
    /** Jira only: the card store's key, and the status the move leads to, in the site's words. */
    query?: string;
    toLabel?: string;
  };
};

type Pending = MergeSpec & { resolve: (v: MergeChoice | null) => void };

const FIELD = {
  background: "var(--bg)",
  border: EDGE,
  color: "var(--text)",
} as const;

/** The subject length past which git log and most tools cut the line. */
const SUBJECT_SOFT = 72;

/** One line each on what the method does to the history, beside its name. */
const MEANING: Record<MergeMethod, string> = {
  merge: "Keeps every commit and adds a merge commit on top.",
  squash: "Folds the whole branch into a single new commit.",
  rebase: "Replays each commit onto the base. No merge commit.",
};

/** The confirm button is named after the strategy. */
const BUTTON_LABEL: Record<MergeMethod, string> = { merge: "Create merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

/** The card row's state machine, named rather than spelled out in booleans:
 *  every one of these draws something different, including the reasons it
 *  cannot offer anything, which are worth saying out loud. */
type CardState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; card: CardMove }
  | { kind: "readonly"; card: CardMove }
  | { kind: "failed"; why: string };

export function MergeDialog({ pending }: { pending: Pending | null }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const [card, setCard] = useState<CardState>({ kind: "none" });
  const [status, setStatus] = useState("");
  /* A Jira card: the row reads the card itself and reports what it found and what was picked. */
  const [jira, setJira] = useState<{ card: JiraMergeCard | null; pick: string }>({ card: null, pick: LEAVE_ALONE });
  const jiraCard = pending?.card?.tracker === "jira" ? pending.card : null;
  useEffect(() => { setJira({ card: null, pick: LEAVE_ALONE }); }, [pending]);
  /* The card choice is a step the workspace adds: absent until it is, and
     unknown prefs read as absent so the row never flashes in and out. */
  const mergePrefs = useClickupPrefs()?.merge;
  const mergeOn = mergePrefs?.enabled === true;
  const mergeNames = mergePrefs?.statusNames.join("\u0000") ?? "";
  const mergeAssign = mergePrefs?.assign;
  const assignKey = JSON.stringify(mergeAssign ?? null);
  /* Who "Also assign" means for this card, worked out while the form opens so the press itself is one write. */
  const [fixedEnsure, setEnsure] = useState<Ensure>({ kind: "none" });
  /* An assign block that asks when it runs: the picker starts where Settings says and the person chooses here. */
  const askAssign = mergePrefs ? planOf("merge", mergePrefs).askAssign : null;
  const readyCard = card.kind === "ready" ? card.card : null;
  const asked = useAskAssign({ on: mergeOn && !!askAssign && !!readyCard, ...(readyCard?.listId ? { listId: readyCard.listId } : null), ...(askAssign ? { start: askAssign } : null), author: pending?.author ?? null, onCard: readyCard?.people });
  const ensure: Ensure = askAssign ? asked.ensure : fixedEnsure;
  /* A comment or a field: shown here, asked where it asks, sent after the merge. */
  const [extraItems, setExtraItems] = useState<ExtraItem[]>([]);
  useEffect(() => { setExtraItems([]); }, [pending]);
  const mergeExtras = !!mergePrefs && mergeOn && hasExtras(planOf("merge", mergePrefs));
  const fid = useId();
  const subjectRef = useRef<HTMLTextAreaElement>(null);
  /* The extended description is folded away while it is empty; one click opens it. */
  const [descOpen, setDescOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /* The strategy being asked about: it opens on the one the question named, and the cards change it. */
  const [method, setMethod] = useState<MergeMethod>(pending?.method ?? "merge");
  const rebase = method === "rebase";
  const held = useStageHold(!!pending?.prefill, pending);

  // The commits are what a squash quotes, and the count is what the header
  // states. Computed once per question rather than per keystroke.
  const real = useMemo(() => (pending?.commits ?? []).filter((c) => !c.isMerge), [pending]);

  useEffect(() => {
    if (!pending) return;
    setMethod(pending.method);
    setSubject(pending.prefill?.subject ?? mergeSubject(pending.method, pending) ?? "");
    setBody(pending.prefill?.body ?? mergeBody(pending.method, pending, pending.commits) ?? "");
    // Only offered when the repository is not already doing it — and then on
    // by default, which is what this app has always done. The difference is
    // that now it says so.
    setDeleteBranch(!pending.repoDeletesBranch);
    setCleanup(true);
    setDescOpen(false);
    // A prepared dialog opens on Cancel: the subject is the agent's to be read, and a
    // selected subject is one keystroke from being replaced by whatever the person
    // was typing when it arrived.
    const t = setTimeout(() => {
      if (pending.prefill) { cancelRef.current?.focus(); return; }
      subjectRef.current?.focus(); subjectRef.current?.select();
    }, 40);
    return () => clearTimeout(t);
  }, [pending]);

  /**
   * Look the card up while the form is already on screen.
   *
   * Three calls, and the dialog opens before any of them: whether this app is
   * allowed to write to the board at all, the card itself (which is what
   * carries its list), and that list's own statuses. The list matters — a card
   * that lives on a different board has different columns, and offering the
   * board on screen instead is how a status picker ends up writing a status the
   * card's own list has never heard of.
   *
   * `alive` because a dialog can be cancelled mid-flight, and because Escape
   * followed by a second merge would otherwise land the first answer in the
   * second question.
   */
  const lookUp = async (ref: { label: string; query: string }, alive: () => boolean) => {
    {
      const [boards, found] = await Promise.all([
        api.clickupViews().catch(() => null),
        api.clickupFind(ref.query).catch(() => null),
      ]);
      if (!alive()) return;
      const task = found?.ok ? found.task : undefined;
      if (!task) { setCard({ kind: "failed", why: found?.error || "ClickUp could not find it" }); return; }
      /* The team is read only for the author choice, and from the list the server already
         holds members for; "me" and a named person need no read at all. */
      const [meta, team] = await Promise.all([
        task.listId ? api.clickupList(task.listId).catch(() => null) : null,
        mergeAssign?.who === "author" && task.listId ? listMembers(task.listId).catch(() => null) : null,
      ]);
      if (!alive()) return;
      setEnsure(resolveEnsure(mergeAssign, { author: pending?.author, members: team?.ok ? (team.members ?? []) : null }));
      const move: CardMove = {
        id: task.id, label: ref.label, title: task.title, ...(task.listId ? { listId: task.listId } : null),
        status: task.status, statusColor: task.statusColor, updated: task.updated,
        statuses: meta?.ok ? (meta.statuses ?? []) : [],
        ...(meta?.ok && meta.fields ? { fields: meta.fields } : null),
        people: task.people ?? [],
      };
      setStatus(mergePreselect(move.statuses, move.status, mergeNames ? mergeNames.split("\u0000") : []));
      // Read-only is not a failure and not a thing to hide: the card and where
      // it is are still worth seeing, with the reason nothing can be done about
      // it from here.
      setCard({ kind: boards?.writeEnabled ? "ready" : "readonly", card: move });
    }
  };

  useEffect(() => {
    const ref = pending?.card;
    // A Jira card has no ClickUp setting to wait for and no ClickUp list to read.
    if (!pending || !ref || ref.tracker === "jira" || !mergeOn) { setCard({ kind: "none" }); setStatus(""); return; }
    let live = true;
    setCard({ kind: "loading" });
    void lookUp(ref, () => live);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, mergeOn, mergeNames, assignKey]);

  /**
   * Turn ClickUp writes on from here.
   *
   * The blocker used to be announced in this dialog and fixable only in another
   * panel — "turn writes on in Tasks", read at the exact moment somebody is
   * merging and has no interest in going anywhere. A permission you are being
   * stopped by should be grantable where it stopped you. It is the same switch
   * the Tasks panel owns, so turning it off again is where it always was.
   */
  const allowWrites = async () => {
    const ref = pending?.card;
    if (!ref) return;
    setCard({ kind: "loading" });
    await api.clickupSetWrites(true).catch(() => null);
    __forgetClickupSetup();
    await lookUp(ref, () => true);
  };

  /** One answer, built in one place, so the button and the chord cannot drift.
   *  The card travels only when the pick actually moves it — see movesCard. */
  const answer = (): MergeChoice => {
    const base = answerClickUp();
    // A Jira card: the move picked in its own row, never ClickUp's.
    return jiraCard && jira.card ? { ...base, card: jiraMergeMove(jira.card, jira.pick) } : base;
  };
  const answerClickUp = (): MergeChoice => {
    const on = card.kind === "ready" ? card.card : null;
    const moves = !!on && movesCard(on.status, status);
    /* Only when the card actually moves: the assignment rides on the move, never on its own. */
    const plan = moves ? stepChanges({ status, people: on.people, unassign: "none", ensure }) : null;
    const note = plan?.named ? `assigned ${plan.named}` : ensure.kind === "unmapped" ? ensure.why : undefined;
    return {
      method,
      subject: rebase ? undefined : subject.trim() || undefined,
      body: rebase ? undefined : body.trim() || undefined,
      deleteBranch,
      ...(pending?.offerCleanup && cleanup ? { cleanup: true } : null),
      ...(on && extraItems.length ? { extras: { id: on.id, label: on.label, items: extraItems } } : null),
      card: on && moves
        ? {
          id: on.id, label: on.label, to: status, updated: on.updated,
          ...(plan?.named ? { write: plan.write } : null),
          ...(note ? { note } : null),
        }
        : undefined,
    };
  };

  useEffect(() => {
    if (!pending) return;
    const submit = () => pending.resolve(answer());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); pending.resolve(null); return; }
      // Plain Enter belongs to the description, which is multi-line and is the
      // field most likely to have focus. The chord is the one every commit
      // box uses, and it works from anywhere in the dialog.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); e.stopPropagation();
        if (!held && (rebase || subject.trim())) submit();
      }
    };
    // Capture, because the panel's single-letter shortcuts listen on window
    // too and a dialog owns the keyboard until it is answered.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, method, subject, body, deleteBranch, cleanup, rebase, card, status, ensure, held, jira]);

  /* The subject grows to three lines and then scrolls inside its own box: never one clipped line. */
  useEffect(() => {
    const el = subjectRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? "auto" : "hidden";
  }, [subject, pending]);

  const how = pending ? MERGE_OPTION[method] : null;

  /* Switching keeps what was typed: a text still equal to the default of the method being left takes the new one's default; an edited text, or an agent's prepared one, is never touched. */
  const pickMethod = (m: MergeMethod) => {
    if (!pending || m === method) return;
    if (!pending.prefill) {
      if (subject === (mergeSubject(method, pending) ?? "")) setSubject(mergeSubject(m, pending) ?? "");
      if (body === (mergeBody(method, pending, pending.commits) ?? "")) setBody(mergeBody(m, pending, pending.commits) ?? "");
    }
    setMethod(m);
  };

  const subjectLen = subject.length;
  const subjectLong = subjectLen > SUBJECT_SOFT;
  const [headStart, headEnd] = pending ? splitTail(pending.headRefName) : ["", ""];
  /* Why the confirm button is dead, said next to it: a greyed button with no sentence is a guess. */
  const blockedWhy = !pending ? "" : held ? "Read the prepared message first" : !rebase && !subject.trim() ? "Write a subject to continue" : "";
  const assignText = (e: Ensure, people: { id?: number | null; me?: boolean }[] | undefined) => assignLine(e, people).replace(/^and /, "Also ");

  return (
    <AnimatePresence>
      {pending && how && (
        <Portal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }}
            onClick={() => pending.resolve(null)} />
          <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
              // Wide, because the subject is the thing being checked. Capped at
              // the viewport so a long body scrolls inside the dialog, not off
              // the screen (mergeDialog.css).
              className="pointer-events-auto agx-mg" data-method={method}
              role="dialog" aria-modal="true" aria-label={`${how.label} #${pending.number}`}
            >
              {/* What is landing, and where: the PR's title, its number, how many
                  commits, and head into base. The head branch gives up its middle
                  (the full name is in the tooltip); the base is always whole. */}
              <div className="agx-mg-head">
                <span className="agx-mg-tile" aria-hidden><MergeIcon size={ICON.lg} /></span>
                <div className="agx-mg-ttl">
                  <b>{how.label}</b>
                  <p className="agx-mg-pr" data-tip={pending.title}>{pending.title}</p>
                  <div className="agx-mg-chips">
                    <span className="agx-mg-chip">#{pending.number}</span>
                    {/* Every commit on the branch, merges included — the number
                        the Commits tab shows and the number that is landing. The
                        filtered list is only about what a squash quotes. */}
                    <span className="agx-mg-chip tabular-nums"><CommitIcon size={ICON.xs} />&nbsp;{pending.commits.length} commit{pending.commits.length === 1 ? "" : "s"}</span>
                    <span className="agx-mg-chip" data-ref="" data-head="" data-tip={pending.headRefName} tabIndex={0} aria-label={`from ${pending.headRefName}`}>
                      <span>{headStart}</span>{headEnd && <span>{headEnd}</span>}
                    </span>
                    <ArrowRightIcon size={ICON.sm} />
                    <span className="agx-mg-chip" data-ref="" data-base="" aria-label={`into ${pending.baseRefName}`}>{pending.baseRefName}</span>
                  </div>
                </div>
              </div>

              {pending.prefill && (
                <div className="agx-mg-note agx-mg-note-w text-[11.5px]" data-prepared-by="" data-prepared="" role="status">{preparedLine(pending.prefill.by)}</div>
              )}

              {(pending.awaitingReview?.length ?? 0) > 0 && (
                <div className="agx-mg-note agx-mg-note-w text-[11.5px] leading-relaxed">
                  <span aria-hidden className="flex" style={{ height: 18, alignItems: "center" }}><WarningIcon size={ICON.sm} /></span>
                  <span>
                    <b style={{ display: "inline", color: "var(--text)", fontWeight: 500 }}>
                      {pending.awaitingReview!.slice(0, 3).join(", ")}
                      {pending.awaitingReview!.length > 3 ? ` +${pending.awaitingReview!.length - 3}` : ""}
                    </b>{" "}
                    {pending.awaitingReview!.length === 1 ? "was" : "were"} asked to review and
                    {pending.awaitingReview!.length === 1 ? " has" : " have"} not.
                    {pending.humanApproved === false && pending.botApproved === true
                      && " The approval that unblocked this came from automation."}
                    {" "}Merging now lands it without them.
                  </span>
                </div>
              )}

              <div className="agx-mg-body agx-scroll">
                {/* The way it lands: the real control. The merge button's menu still
                    sets the default that is remembered per repository; this is the
                    choice for this merge. */}
                <div className="agx-mg-sec">
                  <div className="agx-mg-cap">How it lands</div>
                  <div className="agx-mg-strat" role="radiogroup" aria-label="Merge method">
                    {ALL_METHODS.map((m) => {
                      const ok = !pending.allowed || pending.allowed.includes(m);
                      return (
                        <button key={m} type="button" role="radio" aria-checked={m === method} aria-current={m === method ? "true" : undefined}
                          data-method={m} disabled={!ok} className="agx-mg-opt" onClick={() => pickMethod(m)}
                          {...(ok ? null : { "data-tip": "This repository does not allow it" })}>
                          <b>{MERGE_OPTION[m].label}</b>
                          <span>{MEANING[m]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {rebase ? (
                  /* No fields, because there is no commit to name. What there
                     is instead is the consequence, which is the part people
                     get wrong about rebase. */
                  <div className="agx-mg-note" data-tone="info">
                    <InfoIcon size={ICON.sm} />
                    <span>
                      <b>{pending.title}</b>
                      Every commit is replayed onto <Ref>{pending.baseRefName}</Ref> with a new SHA, and no merge
                      commit is written. Nothing here asks for a message because a rebase does not write one.
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="agx-mg-sec">
                      <label className="agx-mg-cap" htmlFor={`${fid}-subject`}>
                        <span>Commit subject</span>
                        <span className="agx-mg-count" data-warn={subjectLong ? "" : undefined} aria-live="polite">
                          {subjectLen} / {SUBJECT_SOFT}{subjectLong ? " · too long" : ""}
                        </span>
                      </label>
                      <textarea
                        id={`${fid}-subject`} ref={subjectRef} value={subject} rows={1}
                        onChange={(e) => setSubject(e.target.value.replace(/\r?\n/g, " "))}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault(); }}
                        spellCheck={false}
                        className={`agx-mg-subj agx-scroll ${INPUT}`}
                        style={INPUT_STYLE}
                      />
                      <p className="agx-mg-why" data-warn={subjectLong ? "" : undefined}>
                        {subjectLong
                          ? `Past ${SUBJECT_SOFT} characters git log and most tools cut the line off; keep the subject short and put the rest in the description.`
                          : "Why it matters: this one line is what the base branch shows for ever, in git log, blame and release notes."}
                      </p>
                    </div>
                    <div className="agx-mg-sec">
                      {descOpen || body.trim() ? (
                        <>
                          <label className="agx-mg-cap" htmlFor={`${fid}-body`}>
                            <span>Extended description</span>
                            <span>
                              {method === "squash"
                                ? (real.length > 1 ? "the commit messages this squash replaces" : "the commit's own body")
                                : "shown under the subject in the log"}
                            </span>
                          </label>
                          <Textarea
                            id={`${fid}-body`} value={body} onChange={(e) => setBody(e.target.value)}
                            spellCheck={false} rows={method === "squash" ? 8 : 4}
                            placeholder="Optional"
                            className="w-full agx-scroll"
                          />
                        </>
                      ) : (
                        <button type="button" className="agx-mg-add" onClick={() => setDescOpen(true)}>+ Add an extended description</button>
                      )}
                    </div>
                  </>
                )}

                {/* After it lands: the branch, which has been deleted silently on
                    every merge from here and so says so where the deciding is
                    done, and "Offer at merge time" (Settings, After a PR is
                    merged), whose dry run opens when the merge lands. Nothing is
                    removed by that tick; the dialog it opens asks again. */}
                <div className="agx-mg-sec">
                  <div className="agx-mg-cap">After it lands</div>
                  <div className="agx-mg-card">
                    <div className="agx-mg-row">
                      <span className="agx-mg-sm" aria-hidden><BranchIcon size={ICON.sm} /></span>
                      <div className="agx-mg-rt">
                        {pending.repoDeletesBranch ? (
                          <span className="text-[11px]">
                            <Ref>{pending.headRefName}</Ref> is deleted by the repository itself once this merges.
                          </span>
                        ) : (
                          <Checkbox checked={deleteBranch} onChange={setDeleteBranch}>
                            <span>Delete <Ref>{pending.headRefName}</Ref> after merging</span>
                          </Checkbox>
                        )}
                      </div>
                    </div>
                    {pending.offerCleanup && (
                      <div className="agx-mg-row" data-merge-cleanup="">
                        <span className="agx-mg-sm" aria-hidden><SparkleIcon size={ICON.sm} /></span>
                        <div className="agx-mg-rt">
                          <Checkbox checked={cleanup} onChange={setCleanup}>
                            <span>Clean up local leftovers after merging</span>
                          </Checkbox>
                          <span className="text-[11px]">A dry run opens once it lands. Nothing is removed until you confirm there.</span>
                          {pending.cleanupKinds && pending.cleanupKinds.length > 0 && (
                            <div className="agx-mg-kinds" aria-label="What it will look for">
                              {CLEANUP_KIND_ROWS.filter((k) => pending.cleanupKinds!.includes(k.id)).map((k) => {
                                const Ic = KIND_ICON[k.icon];
                                return <span key={k.id} className="agx-mg-kind" data-cl-kind={k.id} data-tip={k.text}><Ic size={ICON.xs} />{k.name}</span>;
                              })}
                            </div>
                          )}
                          {(pending.cleanupHeld?.length ?? 0) > 0 && (
                            <div className="agx-mg-held" data-merge-held="">
                              {pending.cleanupHeld!.map((h) => (
                                <div key={h.title} className="agx-mg-note">
                                  <WarningIcon size={ICON.sm} />
                                  <span><b>Held back: {h.title}</b>{h.why}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* The card, where the deciding already is.
                    Merging here and then moving the card by hand on the board
                    is two places for one decision, and the second one is the
                    one that gets forgotten — the card sits in review for
                    days after the work shipped. The select opens on where the
                    card IS, so leaving it alone writes nothing at all; moving
                    it is a deliberate pick, made once, here. */}
                {(jiraCard || card.kind !== "none") && (
                  <div className="agx-mg-sec">
                    <div className="agx-mg-cap">Tracker card</div>
                    {jiraCard && <MergeJiraCard card={jiraCard} pick={jira.pick} onPick={(c, pick) => setJira({ card: c, pick })} />}
                    {card.kind === "loading" && (
                      <CardFrame label={pending.card?.label ?? ""}>
                        <Spinner label={`Looking up ${pending.card?.label} on ClickUp…`} className="" />
                      </CardFrame>
                    )}
                    {card.kind === "failed" && (
                      <CardFrame label={pending.card?.label ?? ""}>
                        <div className="agx-mg-quiet">{card.why}. The merge is unaffected.</div>
                      </CardFrame>
                    )}
                    {(card.kind === "ready" || card.kind === "readonly") && (
                      <CardFrame label={card.card.label} title={card.card.title}>
                        <div className="agx-mg-trk-move">
                          <MovePills from={card.card.status} fromColor={statusColor(card.card.statuses, card.card.status) ?? card.card.statusColor}
                            to={movesCard(card.card.status, status) ? status : undefined} toColor={statusColor(card.card.statuses, status)} />
                          <span className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                            {card.kind === "readonly" ? (
                              <>
                                <Select disabled value={LEAVE_ALONE} onChange={() => {}} title="This app is read-only on ClickUp"
                                  className="text-[11px]" style={FIELD}
                                  options={[{ value: LEAVE_ALONE, label: "Leave it there" }]} />
                                <Button size="compact" onClick={allowWrites}
                                  title="Let this app change cards on your ClickUp board. The same switch the Tasks panel owns.">
                                  Allow ClickUp changes
                                </Button>
                              </>
                            ) : (
                              /* "Leave it alone" is an option with a name, not a
                                 status that happens to be inert. Offering the card's
                                 OWN status as the default read as a promise to set
                                 the status it already had. */
                              <Select
                                value={status}
                                onChange={setStatus}
                                align="left"
                                title="Where this card goes when the merge lands"
                                className="text-[11px]"
                                style={{
                                  // The board's own colour for wherever this is
                                  // about to go: the thing that makes a status
                                  // recognisable before it is read.
                                  borderColor: movesCard(card.card.status, status)
                                    ? (statusColor(card.card.statuses, status) ?? "var(--border)")
                                    : "var(--border)",
                                }}
                                options={[
                                  { value: LEAVE_ALONE, label: "Leave it there" },
                                  ...statusOptions(card.card.statuses, card.card.status).map((s) => ({
                                    value: s.status, label: s.status, tint: s.color || undefined,
                                    pill: true, dim: s.type === "done" || s.type === "closed",
                                  })),
                                ]}
                              />
                            )}
                          </span>
                        </div>
                        {card.kind === "readonly" && <span className="agx-mg-quiet" style={{ fontSize: 10.5 }}>Read-only until you allow changes.</span>}
                        {card.kind === "ready" && mergeExtras && (
                          <div>
                            <AskedExtras blocks={mergePrefs?.blocks ?? []} fields={card.card.fields ?? null} listId={card.card.listId} onChange={setExtraItems}
                              ctx={prContext({ pr: { number: pending.number, title: pending.title, ...(pending.url ? { url: pending.url } : null) }, author: pending.author, status: movesCard(card.card.status, status) ? status : card.card.status })} />
                          </div>
                        )}
                        {card.kind === "ready" && movesCard(card.card.status, status) && askAssign && (
                          <span className="agx-mg-trk-who" data-merge-ask="">
                            <span>Assign to</span><AssignPicker state={asked} label="Assign to" />
                          </span>
                        )}
                        {card.kind === "ready" && movesCard(card.card.status, status) && ensure.kind !== "none" && (
                          <span className="agx-mg-trk-who" data-merge-assign="" role="status"
                            {...(ensure.kind === "unmapped" ? { "data-warn": "" } : /already on the card/.test(assignLine(ensure, card.card.people)) ? { "data-ok": "" } : null)}>
                            {ensure.kind === "unmapped" ? <WarningIcon size={ICON.sm} /> : /already on the card/.test(assignLine(ensure, card.card.people)) ? <DoneIcon size={ICON.sm} /> : <UserIcon size={ICON.sm} />}
                            {ensure.kind === "unmapped" ? ensure.why : assignText(ensure, card.card.people)}
                          </span>
                        )}
                      </CardFrame>
                    )}
                  </div>
                )}
              </div>

              <div className="agx-mg-foot">
                <span className="agx-mg-keys"><span><kbd>{MOD_KEY}↵</kbd>confirms</span><span><kbd>Esc</kbd>cancels</span></span>
                <span className="agx-mg-act">
                  {blockedWhy && <span className="agx-mg-reason" id={`${fid}-why`} role="status">{blockedWhy}</span>}
                  <Button buttonRef={cancelRef} onClick={() => pending.resolve(null)}>Cancel</Button>
                  <Button tone="primary" title={blockedWhy || undefined}
                    aria-describedby={blockedWhy ? `${fid}-why` : undefined}
                    onClick={() => pending.resolve(answer())}
                    disabled={(!rebase && !subject.trim()) || held}>{BUTTON_LABEL[method]}</Button>
                </span>
              </div>
            </motion.div>
          </div>
        </Portal>
      )}
    </AnimatePresence>
  );
}

/** What the move will do about "Also assign", said before it is pressed. */
function assignLine(e: Ensure, people: { id?: number | null; me?: boolean }[] | undefined): string {
  if (e.kind === "me") return people?.some((p) => p.me) ? "You are already on the card." : "and puts you on the card.";
  if (e.kind === "person") return people?.some((p) => p.id === e.id) ? `${e.name} is already on the card.` : `and puts ${e.name} on the card.`;
  if (e.kind === "many") {
    const missing = e.list.filter((x) => (x.kind === "me" ? !people?.some((p) => p.me) : !people?.some((p) => p.id === x.id))).map((x) => (x.kind === "me" ? "you" : x.name));
    return missing.length ? `and puts ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`} on the card.` : "Everyone picked is already on the card.";
  }
  return "";
}

/** A branch name, set in the code face so it cannot be mistaken for prose —
 *  the same treatment the panel gives refs everywhere else. */
function Ref({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1 py-px rounded text-[10.5px]"
      style={{ overflowWrap: "anywhere", background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text2)" }}>{children}</code>
  );
}

/**
 * `const { askMerge, dialog } = useMergeDialog()` — render `dialog`, await the
 * rest. One question at a time, like `useDialogs`.
 */
export function useMergeDialog() {
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useRef<Pending | null>(null);
  // Cancelled, never merged, when the bench it was asked from is hidden.
  const noteAsker = useOwnedQuestion(pending, () => open.current?.resolve(null));
  const askMerge = (spec: MergeSpec): Promise<MergeChoice | null> =>
    new Promise<MergeChoice | null>((resolve) => {
      // A question on screen is answered "no" before another takes its place.
      open.current?.resolve(null);
      noteAsker();
      const next: Pending = { ...spec, resolve: (v) => { open.current = null; setPending(null); resolve(v); } };
      open.current = next;
      setPending(next);
    });
  return { askMerge, open: pending !== null, dialog: <MergeDialog pending={pending} /> };
}
