/*
 * A Jira card's description: read as Markdown, and changed in place when the
 * site lets this card's description change and Markdown can hold all of it.
 *
 * Three states, drawn from what the card's edit screen said (lib/jiraEdit.ts,
 * `descriptionMode`): a box to write in; a sentence that says why there is none
 * (the stored text has a table, a panel, an image or a colour that Markdown
 * would flatten) with the way to Jira; or nothing, when writing is off. The
 * pencil sits in the section's header in every state and never moves: in the
 * locked state it is the same button, disabled, with the reason as its title.
 * Saving is one edit, and the line under the header says what it did with Undo.
 *
 * Ceiling: the box is a plain one, without the `@` menu; a person named in the
 * description stays named when the text is saved, and a new @name typed here
 * stays text.
 */
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../lib/markdown.tsx";
import { followLink } from "../../lib/linkRouter.ts";
import { descriptionMode } from "../../lib/jiraEdit.ts";
import type { CardEdit } from "../../../../shared/providers.ts";
import { CommentAction } from "../tasks/CardEdit.tsx";
import { EDGE } from "../workspace/Chrome.tsx";
import { Section } from "./JiraSections.tsx";

const PENCIL = "M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z";
export const LOCKED_SAYS = "This description has parts Markdown cannot keep (a table, a panel, an image or a colour), so it is changed in Jira.";

export function JiraDescription({ text, edit, writes, url, busy, onSave }: {
  text: string;
  edit: CardEdit | undefined;
  writes: boolean;
  /** The card on the site, for the way out when the description cannot be edited here. */
  url: string;
  /** An edit of the description is on its way. */
  busy: boolean;
  /** Save the new Markdown; true when it landed (the box then closes), false when it was refused (the box stays, the line above says why). */
  onSave: (markdown: string) => Promise<boolean>;
}) {
  const mode = writes ? descriptionMode(edit) : "none";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  // The text under the box changed (a read, an Undo): the box is not open on a stale copy.
  useEffect(() => { if (!open) setDraft(text); }, [text, open]);
  useEffect(() => { if (mode !== "edit") setOpen(false); }, [mode]);

  const save = async () => {
    if (busy) return;
    if (draft.trim() === text.trim()) { setOpen(false); return; }
    const landed = await onSave(draft);
    if (landed && !gone.current) setOpen(false);
  };

  return (
    <Section id="description" title="Description" aside={mode === "none" ? undefined : (
      <CommentAction iconOnly label="Edit" busy={mode === "locked"} on={open} tone="var(--primary)"
        title={mode === "locked" ? LOCKED_SAYS : open ? "Close the editor" : "Change the description"} d={PENCIL}
        onClick={() => { if (open) { setOpen(false); } else { setDraft(text); setOpen(true); } }} />
    )}>
      {open ? (
        <div className="flex flex-col gap-1.5">
          <textarea value={draft} autoFocus rows={8} disabled={busy} aria-label="Change the description"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
              // Escape closes the box and nothing else: it must not reach the pane behind it.
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
            }}
            className="w-full text-[11.5px] rounded px-2 py-1.5 outline-none resize-y"
            style={{ background: "var(--bg)", color: "var(--text)", border: EDGE, minHeight: 120 }} />
          <div className="flex items-center gap-2 text-[10.5px]">
            <button className="agx-btn rounded-md px-2 py-0.5" disabled={busy} onClick={() => void save()} style={{ color: "var(--text)", border: EDGE }}>{busy ? "Saving…" : "Save"}</button>
            <button className="agx-btn rounded-md px-2 py-0.5" disabled={busy} onClick={() => setOpen(false)} style={{ color: "var(--text3)" }}>Cancel</button>
            <span style={{ color: "var(--text4)" }}>Markdown · Ctrl+Enter saves</span>
          </div>
        </div>
      ) : (
        <div className="agx-cu-body min-w-0 break-words">
          {text.trim() ? <Markdown text={text} /> : <span style={{ color: "var(--text4)" }}>No description.</span>}
        </div>
      )}
      {mode === "locked" && (
        <div className="flex items-center gap-2 mt-1.5 text-[10.5px] flex-wrap" role="status" style={{ color: "var(--text3)" }}>
          <span>{LOCKED_SAYS}</span>
          {url && <button className="agx-btn rounded-md px-2 py-0.5" onClick={(e) => followLink(url, e)} style={{ color: "var(--text2)", border: EDGE }}>Open in Jira</button>}
        </div>
      )}
    </Section>
  );
}
