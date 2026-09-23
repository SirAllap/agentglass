/*
 * The review half of the Diff view: the box a line comment is written in, the
 * comment as it sits under its line, and the tray the comments collect in until
 * they go to the agent as one prompt. The rules — what a snippet is, when a
 * comment is stale, what the prompt says — are in lib/diffReview.ts, where they
 * are tested; this is only how they look.
 */

import { useEffect, useRef, useState } from "react";
import { anchorLabel, inReviewOrder, type Review, type ReviewComment, type StaleFile } from "../../lib/diffReview.ts";
import { MOD_KEY } from "../../lib/format.ts";
import { Btn } from "../PrPanel.tsx";

const CARD = {
  background: "var(--surface-card)",
  border: "1px solid var(--surface-line)",
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
    <div className="mx-3 my-1.5 rounded-lg p-2 text-[11px] whitespace-normal" style={{ ...CARD, width: "min(640px, calc(100cqw - 24px))" }}>
      <p className="mb-1 text-[10px] truncate" style={{ color: "var(--text3)" }}>{label}</p>
      <textarea ref={ta} value={text} rows={3} placeholder="What should the agent change here?"
        aria-label={`Comment on ${label}`}
        onChange={(e) => { setText(e.target.value); onText?.(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="w-full resize-y rounded px-2 py-1.5 text-[11.5px] outline-none"
        style={{ background: "var(--surface-inset)", color: "var(--text)", border: "1px solid var(--surface-line)" }} />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>{MOD_KEY}↵ to add · Esc to cancel</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Btn small onClick={onCancel}>Cancel</Btn>
          <Btn small onClick={save} disabled={!text.trim()} primary title={!text.trim() ? "Write something first" : undefined}>{saveLabel}</Btn>
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
    <div data-review-comment={c.id} className="mx-3 my-1.5 rounded-lg px-2.5 py-2 text-[11px] whitespace-normal"
      style={{ ...CARD, width: "min(640px, calc(100cqw - 24px))", borderLeft: `3px solid ${stale ? "var(--warning)" : "var(--primary)"}` }}>
      <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--text3)" }}>
        <span className="truncate">Pending · {anchorLabel(c)}</span>
        {stale && <StaleTag />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <Btn small onClick={() => setEditing(true)}>Edit</Btn>
          <Btn small onClick={onRemove}>Remove</Btn>
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
      style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>
      stale
    </span>
  );
}

/**
 * The pending review for one checkout, along the bottom of the diff.
 *
 * Closed it is one line — how many comments, and the button that sends them —
 * so it never takes the diff's room while you are still reading. Open, it holds
 * the intro and outro the prompt is framed with and every comment in the tree,
 * including the ones on files not on screen, each one a jump back to its line.
 */
export function ReviewTray({ where, review, staleIds, staleFiles, checking, target, onFrame, onJump, onRemove, onSend, onDiscard }: {
  /** The branch, or the checkout's path when it has none. */
  where: string;
  review: Review;
  staleIds: ReadonlySet<string>;
  /** What the last press of Send found in files not on screen: set, the send
   *  stopped to say so, and the next press sends anyway. */
  staleFiles: readonly StaleFile[] | null;
  checking: boolean;
  /** Which chat will get it, said before the button is pressed. */
  target: string;
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
  const field = "w-full resize-y rounded px-2 py-1.5 text-[11px] outline-none";
  const fieldStyle = { background: "var(--surface-inset)", color: "var(--text)", border: "1px solid var(--surface-line)" } as const;
  return (
    <div className="shrink-0 border-t" style={{ borderColor: "var(--surface-line)", background: "var(--surface-nav)" }}>
      {open && (
        <div className="agx-scroll px-4 pt-3 pb-1 flex flex-col gap-2 overflow-auto" style={{ maxHeight: "45vh" }}>
          <textarea value={review.intro} rows={2} aria-label="Review intro" className={field} style={fieldStyle}
            placeholder="Intro (optional) — the review starts with a line saying which checkout it is about"
            onChange={(e) => onFrame({ intro: e.target.value })} />
          <ol className="flex flex-col gap-1">
            {inReviewOrder(review.comments).map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-[11px]">
                <button onClick={() => onJump(c)} className="agx-btn min-w-0 flex-1 text-left rounded px-1.5 py-1"
                  title="Show this line">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{anchorLabel(c)}</span>
                    {staleIds.has(c.id) && <StaleTag />}
                  </span>
                  <span className="block truncate" style={{ color: "var(--text)" }}>{c.body}</span>
                </button>
                <Btn small onClick={() => onRemove(c.id)} title="Take this comment out of the review">Remove</Btn>
              </li>
            ))}
          </ol>
          <textarea value={review.outro} rows={2} aria-label="Review outro" className={field} style={fieldStyle}
            placeholder="Outro (optional) — e.g. run the tests when you are done"
            onChange={(e) => onFrame({ outro: e.target.value })} />
        </div>
      )}
      {staleFiles && (
        <div role="alert" className="px-4 pt-2 flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--warning)" }}>
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
      <div className="flex items-center gap-2 px-4 py-2 text-[11px]">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="agx-btn min-w-0 flex items-center gap-1.5 rounded px-1.5 py-0.5" style={{ color: "var(--text)" }}>
          <span aria-hidden style={{ color: "var(--text3)" }}>{open ? "▾" : "▸"}</span>
          <span className="truncate">Review · {n} {n === 1 ? "comment" : "comments"} in {where}</span>
          {stale > 0 && <span className="shrink-0" style={{ color: "var(--warning)" }}>· {stale} stale</span>}
        </button>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <Btn small onClick={() => { if (armed) { setArmed(false); onDiscard(); } else setArmed(true); }}
            title="Throw the whole review away">{armed ? `Discard ${n}?` : "Discard"}</Btn>
          <Btn small onClick={onSend} primary pending={checking}
            title={`Checks every commented file, then puts the review in ${target}'s composer as one prompt — nothing runs until you send it there`}>
            {checking ? "Checking…" : staleFiles ? "Send anyway" : "Send review"}
          </Btn>
        </span>
      </div>
    </div>
  );
}
