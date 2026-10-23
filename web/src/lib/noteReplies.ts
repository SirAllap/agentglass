import { REPLY_MAX_CHARS, type NoteReply, type NoteStatus } from "../../../shared/pluginUi.ts";

/**
 * The decisions behind replying to a plugin's finding, out of the screen so
 * they can be asserted without a renderer.
 */

export { REPLY_MAX_CHARS };

/** Over this many replies, a resolved or dismissed finding shows them behind
 *  one "n replies" button instead of unrolling the thread. */
export const COLLAPSE_OVER = 2;

export interface ReplyDraft { text: string }

/** The composer when it opens, and again after every use. */
export const FRESH_DRAFT: ReplyDraft = { text: "" };

export function draftState(text: string): { counter: string; over: boolean; empty: boolean; canSend: boolean } {
  const n = text.length;
  const empty = text.trim().length === 0;
  const over = n > REPLY_MAX_CHARS;
  return { counter: `${n} / ${REPLY_MAX_CHARS}`, over, empty, canSend: !empty && !over };
}

/** Esc closes, Ctrl+Enter (or Cmd+Enter) saves; anything else is typing. */
export function composerKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean }): "close" | "save" | null {
  if (e.key === "Escape") return "close";
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return "save";
  return null;
}

export function authorLabel(by: string): string {
  return by === "user" ? "You" : by.startsWith("agent:") ? by.slice("agent:".length) : by;
}

/** The tags after the author and time: what the reply did. */
export function replyTags(r: Pick<NoteReply, "withStatus">): string[] {
  const out: string[] = [];
  if (r.withStatus === "resolved") out.push("resolved with this reply");
  if (r.withStatus === "dismissed") out.push("dismissed with this reply");
  return out;
}

/** Whether the thread is folded behind its count: only a finding somebody
 *  closed, and only when there is more to read than a glance. Reopening it
 *  unfolds it; the thread itself is never touched. */
export function threadFolded(status: NoteStatus, count: number, expanded: boolean): boolean {
  return status !== "open" && count > COLLAPSE_OVER && !expanded;
}

export function replyCountLabel(n: number): string {
  return `${n} ${n === 1 ? "reply" : "replies"}`;
}

/** Which buttons the composer offers. A closed finding takes a reply and
 *  nothing else: its status is not this form's to change. */
export function composerActions(status: NoteStatus): ("save" | "resolve" | "dismiss")[] {
  return status === "open" ? ["save", "resolve", "dismiss"] : ["save"];
}
