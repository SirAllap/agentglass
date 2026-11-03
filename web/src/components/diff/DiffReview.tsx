/*
 * The review half of the Diff view: the box a line comment is written in, the
 * comment as it sits under its line, and the tray the comments collect in until
 * they go to the agent as one prompt. The rules — what a snippet is, when a
 * comment is stale, what the prompt says — are in lib/diffReview.ts, where they
 * are tested; this is only how they look.
 */

import { useEffect, useRef, useState } from "react";
import { anchorLabel, failedSendNote, inReviewOrder, type Review, type ReviewComment, type StaleFile } from "../../lib/diffReview.ts";
import { MOD_KEY } from "../../lib/format.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { Badge, Button, EDGE, NoteRow } from "../workspace/Chrome.tsx";

const CARD = {
  background: "var(--surface-card)",
  border: EDGE,
  boxShadow: "var(--surface-lift)",
  fontFamily: "var(--font-sans, inherit)",
} as const;

/** The box under a line. ⌘/Ctrl-Enter adds, Escape cancels — the pull request
 *  composer's keys, so a hand that learned one does not have to learn two. */
export function CommentBox({ label, initial = "", onText, onSave, onCancel, saveLabel = "Add to review" }: {
  label: string; initial?: string;
  /** Every keystroke, for a caller that has to survive this box remounting. */
  onText?: (text: string) => void;
  onSave: (body: string) => void; onCancel: () => void; saveLabel?: string;
}) {
  const [text, setText] = useState(initial);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ta.current?.focus(); }, []);
  const save = () => { if (text.trim()) onSave(text.trim()); };
  return (
    <div className="mx-3 my-1.5 rounded-xl p-2 text-[11px] whitespace-normal" style={{ ...CARD, width: "min(640px, calc(100cqw - 24px))" }}>
      <p className="mb-1 text-[10px] truncate" style={{ color: "var(--text3)" }}>{label}</p>
      <textarea ref={ta} value={text} rows={3} placeholder="What should the agent change here?"
        aria-label={`Comment on ${label}`}
        onChange={(e) => { setText(e.target.value); onText?.(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="w-full resize-y rounded px-2 py-1.5 text-[11.5px] outline-none"
        style={{ background: "var(--surface-inset)", color: "var(--text)", border: EDGE }} />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>{MOD_KEY}↵ to add · Esc to cancel</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="compact" onClick={onCancel}>Cancel</Button>
          <Button size="compact" tone="primary" onClick={save} disabled={!text.trim()} title={!text.trim() ? "Write something first" : undefined}>{saveLabel}</Button>
        </span>
      </div>
    </div>
  );
}

/** A pending comment, under the line it is about. */
export function CommentCard({ c, stale, onEdit, onRemove }: {
  c: ReviewComment; stale: boolean; onEdit: (body: string) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <CommentBox label={anchorLabel(c)} initial={c.body} saveLabel="Save"
      onSave={(b) => { onEdit(b); setEditing(false); }} onCancel={() => setEditing(false)} />;
  }
  return (
    <div data-review-comment={c.id} className="mx-3 my-1.5 rounded-xl px-2.5 py-2 text-[11px] whitespace-normal"
      style={{ ...CARD, width: "min(640px, calc(100cqw - 24px))", ...(stale ? { border: "1px solid color-mix(in srgb, var(--warning) 55%, transparent)" } : null) }}>
      <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--text3)" }}>
        <span className="truncate">Pending · {anchorLabel(c)}</span>
        {stale && <StaleTag />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <Button size="compact" onClick={() => setEditing(true)}>Edit</Button>
          <Button size="compact" onClick={onRemove}>Remove</Button>
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap" style={{ color: "var(--text)" }}>{c.body}</p>
    </div>
  );
}

function StaleTag() {
  return (
    <span className="shrink-0 px-1.5 rounded text-[10px]"
      title="The code at this line has changed since the comment was written. The review still sends the code it was written against."
      style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>
      stale
    </span>
  );
}

/** Where the review's last Send stands. The review itself is never touched by it. */
export type SendOutcome = { state: "waiting" | "sent" | "failed"; label: string; where: string; error?: string };

/** The bench button's corner: the tray keeps this much clear on the right, so the
 *  round button never sits on Remove or Send. A fixed margin, because the button is
 *  always in that corner; measuring it moved the bar's content between renders. */
const BENCH_CORNER = 64;

/**
 * The pending review for one checkout, in a drawer under the diff.
 *
 * Closed it is one line — how many comments, and the button that sends them —
 * so it never takes the diff's room while you are still reading. Open, it holds
 * the intro and outro the prompt is framed with and every comment in the tree,
 * including the ones on files not on screen, each one a jump back to its line.
 * It grows to 46% of the column at most and scrolls inside that.
 *
 * Sending does not empty it: the answer is said here, in a note, and the comments
 * stay until you discard them, so a window that never started the agent costs you
 * a second press, not the review.
 */
export function ReviewTray({ where, review, staleIds, staleFiles, checking, target, outcome, onShowWindow, onFrame, onJump, onRemove, onSend, onDiscard }: {
  /** The branch, or the checkout's path when it has none. */
  where: string;
  review: Review;
  staleIds: ReadonlySet<string>;
  /** What the last press of Send found in files not on screen: set, the send
   *  stopped to say so, and the next press sends anyway. */
  staleFiles: readonly StaleFile[] | null;
  checking: boolean;
  /** Where Send opens a window, said before the button is pressed. */
  target: string;
  outcome: SendOutcome | null;
  onShowWindow: () => void;
  onFrame: (f: { intro?: string; outro?: string }) => void;
  onJump: (c: ReviewComment) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(false);
  /* Discard asks twice: it throws away every comment in the checkout, and there
     is nothing to undo it with. The second press has to come within a few
     seconds, so an armed button left behind does not fire on a later stray click. */
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  const n = review.comments.length;
  const stale = review.comments.filter((c) => staleIds.has(c.id)).length;
  const field = "w-full resize-y rounded-lg px-2 py-1.5 text-[11px] outline-none";
  const fieldStyle = { background: "var(--surface-inset)", color: "var(--text)", border: EDGE } as const;
  const gutter = { marginRight: BENCH_CORNER } as const;
  return (
    <div className="shrink-0 flex flex-col min-h-0 border-t" data-review-tray
      style={{ borderColor: "var(--surface-line)", background: "var(--surface-card)", maxHeight: "46%" }}>
      <div className="flex items-center gap-2 pl-3.5 pr-3 py-1.5 shrink-0" style={{ ...gutter, minHeight: 46 }}>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="min-w-0 flex-1 flex items-center gap-2 text-left text-[12px] font-semibold" style={{ height: 28, color: "var(--text)" }}>
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
            style={{ transform: open ? "none" : "rotate(180deg)", transition: "transform .12s" }}>
            <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="shrink-0">Review</span>
          <Badge tint="var(--primary)">{n} {n === 1 ? "comment" : "comments"}</Badge>
          {stale > 0 && <Badge tint="var(--warning)">{stale} stale</Badge>}
          <span className="truncate font-normal text-[10.5px]" style={{ color: "var(--text3)" }}>in {where}</span>
        </button>
        <Button tone="danger" onClick={() => { if (armed) { setArmed(false); onDiscard(); } else setArmed(true); }} title="Throw the whole review away">{armed ? `Discard ${n}?` : "Discard"}</Button>
        <Button tone="primary" onClick={onSend} pending={checking} title={`Checks every commented file, then opens ${target} with an agent already working through it`}>
          {checking ? "Checking…" : staleFiles ? "Send anyway" : "Send review"}
        </Button>
      </div>
      <div className="agx-scroll flex flex-col gap-2.5 overflow-auto min-h-0 pl-3.5 pr-3 pb-3" style={gutter}>
        {outcome && (
          <NoteRow tint={outcome.state === "failed" ? "var(--error)" : outcome.state === "sent" ? "var(--success)" : undefined} role="status">
            <span className="flex flex-col items-start gap-1.5 text-[11px] font-normal" style={{ color: "var(--text2)" }}>
              {outcome.state === "waiting" && <span>Opening a tmux window…</span>}
              {outcome.state === "failed" && (() => {
                const note = failedSendNote(outcome.error, n);
                return (
                  <>
                    <span><b>{note.title}</b> {note.body}</span>
                    {note.kind === "missing-cli" && <Button size="compact" onClick={() => openSettings("engines")}>Open Settings</Button>}
                  </>
                );
              })()}
              {outcome.state === "sent" && (
                <>
                  <span><b>Claude is on it in a tmux window</b> — "{outcome.label}", in {outcome.where}. The review stays here until you discard it.</span>
                  <Button size="compact" onClick={onShowWindow}>Show the window</Button>
                </>
              )}
            </span>
          </NoteRow>
        )}
        {staleFiles && (
          <div role="alert" className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--warning-ink)" }}>
            <span>Changed since you commented — the review says so beside each stale comment:</span>
            {staleFiles.map((f) => (
              <span key={`${f.mode}\0${f.path}`} className="truncate pl-2">
                {f.path}{f.mode === "committed" ? " (last commit)" : ""} · {f.unknown
                  ? `could not be checked (${f.of} ${f.of === 1 ? "comment" : "comments"})`
                  : `${f.stale} of ${f.of} ${f.of === 1 ? "comment" : "comments"} stale`}
              </span>
            ))}
          </div>
        )}
        {open && (
          <>
            <textarea value={review.intro} rows={2} aria-label="Review intro" className={field} style={fieldStyle}
              placeholder="Intro (optional) — the review starts with a line saying which checkout it is about"
              onChange={(e) => onFrame({ intro: e.target.value })} />
            <ol className="flex flex-col gap-1.5">
              {inReviewOrder(review.comments).map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-[11px] rounded-lg px-2 py-1.5"
                  style={{ background: "var(--bg)", boxShadow: `inset 0 0 0 1px var(--surface-line)` }}>
                  <button onClick={() => onJump(c)} className="min-w-0 flex-1 text-left" title="Show this line">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{anchorLabel(c)}</span>
                      {staleIds.has(c.id) && <StaleTag />}
                    </span>
                    <span className="block truncate" style={{ color: "var(--text)" }}>{c.body}</span>
                  </button>
                  <Button size="compact" tone="quiet" onClick={() => onRemove(c.id)} title="Take this comment out of the review">Remove</Button>
                </li>
              ))}
            </ol>
            <textarea value={review.outro} rows={2} aria-label="Review outro" className={field} style={fieldStyle}
              placeholder="Outro (optional) — e.g. run the tests when you are done"
              onChange={(e) => onFrame({ outro: e.target.value })} />
          </>
        )}
      </div>
    </div>
  );
}
