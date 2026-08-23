import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { Select } from "./Select.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { Spinner } from "./Spinner.tsx";
import { MERGE_OPTION, mergeBody, mergeSubject, type MergeMethod, type MergeCommit } from "../../../shared/mergeMethod.ts";
import { LEAVE_ALONE, movesCard, statusColor, statusOptions, type CardMove } from "../lib/cardMove.ts";
import { api } from "../lib/api.ts";
import { MOD_KEY } from "../lib/format.ts";

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
  card?: { label: string; query: string } | null;
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
};

/** What the dialog resolves to. `null` is a cancel. */
export type MergeChoice = {
  subject?: string;
  body?: string;
  deleteBranch: boolean;
  /** Set only when a status other than the card's own was picked. Absent means
   *  "leave the board alone", which is what the dialog opens on. */
  card?: { id: string; label: string; to: string; updated: number };
};

type Pending = MergeSpec & { resolve: (v: MergeChoice | null) => void };

const FIELD = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--text)",
} as const;

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
  const [card, setCard] = useState<CardState>({ kind: "none" });
  const [status, setStatus] = useState("");
  const subjectRef = useRef<HTMLInputElement>(null);
  const rebase = pending?.method === "rebase";

  // The commits are what a squash quotes, and the count is what the header
  // states. Computed once per question rather than per keystroke.
  const real = useMemo(() => (pending?.commits ?? []).filter((c) => !c.isMerge), [pending]);

  useEffect(() => {
    if (!pending) return;
    setSubject(mergeSubject(pending.method, pending) ?? "");
    setBody(mergeBody(pending.method, pending, pending.commits) ?? "");
    // Only offered when the repository is not already doing it — and then on
    // by default, which is what this app has always done. The difference is
    // that now it says so.
    setDeleteBranch(!pending.repoDeletesBranch);
    const t = setTimeout(() => { subjectRef.current?.focus(); subjectRef.current?.select(); }, 40);
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
      const meta = task.listId ? await api.clickupList(task.listId).catch(() => null) : null;
      if (!alive()) return;
      const move: CardMove = {
        id: task.id, label: ref.label, title: task.title,
        status: task.status, statusColor: task.statusColor, updated: task.updated,
        statuses: meta?.ok ? (meta.statuses ?? []) : [],
      };
      setStatus(LEAVE_ALONE);
      // Read-only is not a failure and not a thing to hide: the card and where
      // it is are still worth seeing, with the reason nothing can be done about
      // it from here.
      setCard({ kind: boards?.writeEnabled ? "ready" : "readonly", card: move });
    }
  };

  useEffect(() => {
    const ref = pending?.card;
    if (!pending || !ref) { setCard({ kind: "none" }); setStatus(""); return; }
    let live = true;
    setCard({ kind: "loading" });
    void lookUp(ref, () => live);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

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
    await lookUp(ref, () => true);
  };

  /** One answer, built in one place, so the button and the chord cannot drift.
   *  The card travels only when the pick actually moves it — see movesCard. */
  const answer = (): MergeChoice => {
    const on = card.kind === "ready" ? card.card : null;
    return {
      subject: rebase ? undefined : subject.trim() || undefined,
      body: rebase ? undefined : body.trim() || undefined,
      deleteBranch,
      card: on && movesCard(on.status, status)
        ? { id: on.id, label: on.label, to: status, updated: on.updated }
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
        if (rebase || subject.trim()) submit();
      }
    };
    // Capture, because the panel's single-letter shortcuts listen on window
    // too and a dialog owns the keyboard until it is answered.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, subject, body, deleteBranch, rebase, card, status]);

  const how = pending ? MERGE_OPTION[pending.method] : null;

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
              // Wide, because the subject is the thing being checked and a
              // branch name plus a number plus "Merge pull request from" is
              // longer than any 520px box. Capped at the viewport so a long
              // squash body scrolls inside the dialog, not off the screen.
              className="pointer-events-auto w-full max-w-[760px] max-h-[86vh] flex flex-col rounded-xl overflow-hidden"
              style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
              role="dialog" aria-modal="true" aria-label={`${how.label} #${pending.number}`}
            >
              {/* What is landing, and where. GitHub says this above its own
                  form ("wants to merge 21 commits into base from head") and it
                  is the one line that makes the rest of the dialog checkable. */}
              <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="text-[13px] font-medium flex items-baseline gap-2 flex-wrap" style={{ color: "var(--text)" }}>
                  <span>{how.label}</span>
                  <span className="text-[11px] font-normal" style={{ color: "var(--text3)" }}>#{pending.number} · {how.hint}</span>
                </div>
                <div className="text-[11px] mt-1.5 flex items-center gap-1.5 flex-wrap" style={{ color: "var(--text3)" }}>
                  {/* Every commit on the branch, merges included — the number
                      the Commits tab shows and the number that is landing. The
                      filtered list below is only about what a squash quotes. */}
                  <span className="tabular-nums" style={{ color: "var(--text2)" }}>
                    {pending.commits.length} commit{pending.commits.length === 1 ? "" : "s"}
                  </span>
                  <span>from</span>
                  <Ref>{pending.headRefName}</Ref>
                  <span>into</span>
                  <Ref>{pending.baseRefName}</Ref>
                </div>
              </div>

              {(pending.awaitingReview?.length ?? 0) > 0 && (
                <div className="px-4 py-2.5 text-[11.5px] leading-relaxed flex items-start gap-2"
                  style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    borderBottom: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>
                  <span aria-hidden style={{ fontSize: 14, lineHeight: "18px", color: "var(--warning)" }}>⚠</span>
                  <span>
                    <b style={{ color: "var(--text)", fontWeight: 500 }}>
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

              <div className="px-4 py-3.5 flex flex-col gap-3 min-h-0 overflow-y-auto agx-scroll">
                {rebase ? (
                  /* No fields, because there is no commit to name. What there
                     is instead is the consequence, which is the part people
                     get wrong about rebase. */
                  <div className="text-[11.5px] leading-relaxed" style={{ color: "var(--text2)" }}>
                    <div style={{ color: "var(--text)" }}>{pending.title}</div>
                    <div className="mt-2">
                      Every commit is replayed onto <Ref>{pending.baseRefName}</Ref> with a new SHA, and no merge
                      commit is written. Nothing here asks for a message because a rebase does not write one.
                    </div>
                  </div>
                ) : (
                  <>
                    <Field label="Commit subject" hint="this is what lands on the base branch, for ever">
                      <input
                        ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)}
                        spellCheck={false}
                        className="w-full text-[12px] px-2.5 py-1.5 rounded outline-none"
                        style={FIELD}
                      />
                    </Field>
                    <Field
                      label="Extended description"
                      hint={pending.method === "squash"
                        ? (real.length > 1 ? "the commit messages this squash replaces" : "the commit's own body")
                        : "shown under the subject in the log"}
                    >
                      <textarea
                        value={body} onChange={(e) => setBody(e.target.value)}
                        spellCheck={false} rows={pending.method === "squash" ? 8 : 4}
                        placeholder="Optional"
                        className="w-full text-[12px] px-2.5 py-1.5 rounded outline-none resize-y agx-scroll"
                        style={FIELD}
                      />
                    </Field>
                  </>
                )}

                {/* The branch. This has been happening silently on every merge
                    from here; a thing that deletes a branch should say so
                    where the deciding is done. */}
                {pending.repoDeletesBranch ? (
                  <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
                    <Ref>{pending.headRefName}</Ref> is deleted by the repository itself once this merges.
                  </div>
                ) : (
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none" style={{ color: "var(--text2)" }}>
                    <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                    <span>Delete <Ref>{pending.headRefName}</Ref> after merging</span>
                  </label>
                )}

                {/* The card, where the deciding already is.
                    Merging here and then moving the card by hand on the board
                    is two places for one decision, and the second one is the
                    one that gets forgotten — the card sits in Code Review for
                    days after the work shipped. The select opens on where the
                    card IS, so leaving it alone writes nothing at all; moving
                    it is a deliberate pick, made once, here. */}
                {card.kind !== "none" && (
                  <div className="pt-2.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
                    {card.kind === "loading" && (
                      <Spinner label={`Looking up ${pending.card?.label} on ClickUp…`} className="" />
                    )}
                    {card.kind === "failed" && (
                      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
                        {pending.card?.label} — {card.why}. The merge is unaffected.
                      </div>
                    )}
                    {(card.kind === "ready" || card.kind === "readonly") && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Ref>{card.card.label}</Ref>
                        <span className="text-[11px] truncate max-w-[240px]" style={{ color: "var(--text3)" }} title={card.card.title}>
                          {card.card.title}
                        </span>
                        <span className="text-[11px]" style={{ color: "var(--text3)" }}>is in</span>
                        <StatusPill status={card.card.status}
                          color={statusColor(card.card.statuses, card.card.status) ?? card.card.statusColor} />
                        {movesCard(card.card.status, status) && (
                          <span className="text-[11px]" style={{ color: "var(--text3)" }}>→</span>
                        )}
                        {card.kind === "readonly" ? (
                          <>
                            <select disabled value={LEAVE_ALONE} title="This app is read-only on ClickUp"
                              className="text-[11px] px-2 py-1 rounded outline-none opacity-50"
                              style={FIELD}>
                              <option value={LEAVE_ALONE}>Leave it there</option>
                            </select>
                            <button onClick={allowWrites}
                              title="Let this app change cards on your ClickUp board. The same switch the Tasks panel owns."
                              className="text-[10.5px] px-2 py-1 rounded"
                              style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
                              Allow ClickUp changes
                            </button>
                            <span className="text-[10px]" style={{ color: "var(--text4)" }}>— read-only until you do</span>
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
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderTop: "1px solid var(--border)" }}>
                <span className="text-[10px]" style={{ color: "var(--text4)" }}>{MOD_KEY}↵ to confirm · Esc to cancel</span>
                <span className="ml-auto flex items-center gap-2">
                  <button onClick={() => pending.resolve(null)}
                    className="text-[11px] px-2.5 py-1 rounded"
                    style={{ color: "var(--text2)", border: "1px solid var(--border)" }}>Cancel</button>
                  <button
                    onClick={() => pending.resolve(answer())}
                    disabled={!rebase && !subject.trim()}
                    className="text-[11px] px-2.5 py-1 rounded font-medium disabled:opacity-40"
                    style={{ color: "var(--bg)", background: "var(--primary)" }}>{how.label}</button>
                </span>
              </div>
            </motion.div>
          </div>
        </Portal>
      )}
    </AnimatePresence>
  );
}

/** A branch name, set in the code face so it cannot be mistaken for prose —
 *  the same treatment the panel gives refs everywhere else. */
function Ref({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1 py-px rounded text-[10.5px]"
      style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text2)" }}>{children}</code>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10.5px] mb-1 flex items-baseline gap-1.5">
        <span style={{ color: "var(--text2)" }}>{label}</span>
        {hint && <span style={{ color: "var(--text4)" }}>— {hint}</span>}
      </div>
      {children}
    </label>
  );
}

/**
 * `const { askMerge, dialog } = useMergeDialog()` — render `dialog`, await the
 * rest. One question at a time, like `useDialogs`.
 */
export function useMergeDialog() {
  const [pending, setPending] = useState<Pending | null>(null);
  const askMerge = (spec: MergeSpec): Promise<MergeChoice | null> =>
    new Promise<MergeChoice | null>((resolve) =>
      setPending({ ...spec, resolve: (v) => { setPending(null); resolve(v); } }));
  return { askMerge, dialog: <MergeDialog pending={pending} /> };
}
