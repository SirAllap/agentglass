// Chats, written down so they outlive the page.
//
// The store's Map was the only copy of a conversation, which made it as durable
// as the tab holding it. Two entirely ordinary things destroyed it: the app
// crashing, and switching projects, since that path deliberately calls
// `location.reload()` to rescope every view. Either way you came back to an
// empty panel with no way to tell what had been open.
//
// localStorage rather than the server's sqlite, because what is being saved is
// tab state: which conversations you had open, what you had half-typed in each,
// what you had queued. That belongs to the window, the same way the tool
// allowlist and the terminal's root already do. The conversations themselves are
// also on disk in claude's own transcript, but the *set of open tabs* is known
// nowhere but here.

import { asAgent } from "./chatStore.ts";
import type { Chat, ChatMsg, ChatTool } from "./chatStore.ts";

const KEY = "agentglass.chats.v1";

/** Per chat. Enough to scroll back through a conversation, not so much that a
 *  handful of long tool-running sessions exhausts the 5MB quota. */
const MAX_MESSAGES = 60;
/** Tool output is the single largest thing in a chat: one `cat` of a big file
 *  outweighs the entire conversation around it. */
const MAX_OUTPUT = 2000;
const MAX_TEXT = 20000;
/** Well under the ~5MB localStorage quota, leaving room for the settings and
 *  view state that share it. */
const MAX_BYTES = 2_000_000;

/** What actually gets written. Everything absent from here is either not
 *  serializable or not true after a reload. */
type StoredChat = Pick<Chat,
  | "id" | "cwd" | "agent" | "model" | "resolvedModel" | "mode" | "title" | "sessionId" | "draft"
  | "queued" | "createdAt" | "unread" | "renamed" | "attention" | "usage" | "liveFrom"
  | "engine" | "attachCommand" | "effort">
  & { messages: ChatMsg[] };

type Stored = { v: 1; activeId: string; chats: StoredChat[] };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n[trimmed]" : s);

function packTool(t: ChatTool): ChatTool {
  return { ...t, output: t.output === null ? null : clip(t.output, MAX_OUTPUT) };
}

function packMsg(m: ChatMsg): ChatMsg {
  const { images, ...rest } = m;
  return {
    ...rest,
    text: clip(m.text, MAX_TEXT),
    thinking: m.thinking === undefined ? undefined : clip(m.thinking, MAX_TEXT),
    // A streaming message is only streaming while the process writing it is
    // alive, and by definition it is not.
    streaming: undefined,
    tools: m.tools.map(packTool),
    // Images are base64 in memory. A couple of screenshots is megabytes, which
    // is the whole quota, so the turn is kept and the pixels are not.
    imagesDropped: images?.length || undefined,
  };
}

function pack(c: Chat): StoredChat {
  // A turn interrupted by the crash left a trailing empty assistant message
  // waiting for text that will never arrive. Restoring it would show a reply
  // that is permanently mid-thought.
  let messages = c.messages;
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && !last.text && !last.tools.length) messages = messages.slice(0, -1);

  return {
    id: c.id, cwd: c.cwd, agent: c.agent, model: c.model,
    // The window the CLI actually resolved, which is what the context meter
    // measures against. Without it a restored chat measures a 1M session against
    // the 200k default until its next turn re-reports one.
    resolvedModel: c.resolvedModel,
    mode: c.mode, title: c.title,
    sessionId: c.sessionId, draft: c.draft, queued: c.queued, createdAt: c.createdAt,
    unread: c.unread, renamed: c.renamed, attention: c.attention, usage: c.usage,
    liveFrom: c.liveFrom,
    // Which engine this chat runs on has to survive a reload, or a warm tmux
    // chat silently becomes a `-p` chat after a refresh and the terminal command
    // the user was shown stops matching anything.
    engine: c.engine, attachCommand: c.attachCommand, effort: c.effort,
    messages: messages.slice(-MAX_MESSAGES).map(packMsg),
  };
}

/** Rebuild a live chat from a stored one. The fields left out are the ones a
 *  fresh page has no business inheriting: there is no stream in flight, no
 *  AbortController to cancel, and no pasted attachment, since its object URL
 *  died with the document that minted it. */
function unpack(s: StoredChat): Chat {
  return {
    ...s,
    // Written down since chats gained a second agent. Everything saved before
    // that was a Claude chat, so a missing field is not corruption — it is an
    // older payload saying what it knew. Defaulting it costs nothing and means
    // the version number does not have to move, which would have thrown those
    // tabs away instead.
    agent: asAgent(s.agent),
    messages: (s.messages ?? []).map((m) => ({ ...m, streaming: undefined })),
    sending: false,
    abort: null,
    attachments: [],
    queued: s.queued ?? [],
  };
}

/**
 * Which chats survive when they do not all fit.
 *
 * Called only when the whole set is over budget, because measuring every chat
 * separately is wasted work on the ordinary save where it fits.
 *
 * Two rules, in this order:
 *
 * 1. **The chat you are in is never dropped.** Not even when it is the oldest,
 *    and not even when it alone is over budget. This is what the old code said
 *    it did and did not: it shed strictly oldest-first, so opening one chat on
 *    Monday, leaving it active, and starting five more would delete the one on
 *    screen and keep the five you were not looking at.
 * 2. Then newest first, stopping at the first that does not fit — so what
 *    survives is a recent run rather than a set with holes in it.
 */
function fit(packed: StoredChat[], activeId: string): StoredChat[] {
  // Each chat measured once. An element of an array serialises identically on
  // its own, so these lengths are the real contribution, not an estimate.
  const sizes = packed.map((c) => JSON.stringify(c).length);
  const envelope = JSON.stringify({ v: 1, activeId, chats: [] } satisfies Stored).length;

  const keep = new Set<number>();
  let used = envelope;
  // The separating comma belongs to every chat after the first.
  const cost = (i: number) => sizes[i]! + (keep.size ? 1 : 0);
  const take = (i: number) => { used += cost(i); keep.add(i); };

  const active = packed.findIndex((c) => c.id === activeId);
  if (active >= 0) take(active);

  for (let i = packed.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    // `keep.size` is 0 only when activeId matched nothing, and then the newest
    // is taken unconditionally — a save that stores nothing is worse than one
    // that stores a single oversized chat.
    if (keep.size && used + cost(i) > MAX_BYTES) break;
    take(i);
  }
  return packed.filter((_, i) => keep.has(i));
}

/**
 * Write the open chats.
 *
 * Sheds rather than failing the whole save when the payload is too large:
 * losing the chat you opened a week ago is a far better outcome than losing the
 * one you are in the middle of.
 *
 * The shed used to drop one chat and re-serialise everything that was left,
 * over and over — quadratic in the number of chats, on the main thread, at most
 * every 500ms while a reply streams. Forty long chats cost 40 passes over an
 * average of 23MB, which is nearly a gigabyte of JSON for one save and about
 * 1.5 seconds of frozen UI. The whole set is now serialised once, and only if
 * that does not fit does anything else happen — so the ordinary save, where it
 * does fit, does exactly the work it always did and no more.
 */
export function saveChats(chats: Chat[], activeId: string) {
  try {
    const packed = chats.map(pack).sort((a, b) => a.createdAt - b.createdAt);
    const whole = JSON.stringify({ v: 1, activeId, chats: packed } satisfies Stored);
    if (whole.length <= MAX_BYTES || packed.length <= 1) {
      localStorage.setItem(KEY, whole);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify({ v: 1, activeId, chats: fit(packed, activeId) } satisfies Stored));
  } catch {
    // Private mode, a full quota, or a value we could not serialize. Persistence
    // is a convenience; nothing here is allowed to break the panel.
  }
}

/** Read back what was open. Returns an empty list on anything unexpected, so a
 *  corrupt or older payload costs the tabs, never the app. */
export function loadChats(): { chats: Chat[]; activeId: string } {
  const empty = { chats: [], activeId: "" };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.chats)) return empty;
    const chats = parsed.chats.filter((c) => c && typeof c.id === "string" && typeof c.cwd === "string").map(unpack);
    return { chats, activeId: typeof parsed.activeId === "string" ? parsed.activeId : "" };
  } catch {
    return empty;
  }
}

export function clearChats() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
