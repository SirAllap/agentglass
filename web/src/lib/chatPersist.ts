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
  | "id" | "cwd" | "model" | "resolvedModel" | "mode" | "title" | "sessionId" | "draft"
  | "queued" | "createdAt" | "unread" | "renamed" | "attention" | "usage" | "liveFrom">
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
    id: c.id, cwd: c.cwd, model: c.model,
    // The window the CLI actually resolved, which is what the context meter
    // measures against. Without it a restored chat measures a 1M session against
    // the 200k default until its next turn re-reports one.
    resolvedModel: c.resolvedModel,
    mode: c.mode, title: c.title,
    sessionId: c.sessionId, draft: c.draft, queued: c.queued, createdAt: c.createdAt,
    unread: c.unread, renamed: c.renamed, attention: c.attention, usage: c.usage,
    liveFrom: c.liveFrom,
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
    messages: (s.messages ?? []).map((m) => ({ ...m, streaming: undefined })),
    sending: false,
    abort: null,
    attachments: [],
    queued: s.queued ?? [],
  };
}

/**
 * Write the open chats.
 *
 * Trims oldest-first when the payload is too large rather than failing the whole
 * save: losing the chat you opened a week ago is a far better outcome than
 * losing the one you are in the middle of.
 */
export function saveChats(chats: Chat[], activeId: string) {
  try {
    const packed = chats.map(pack).sort((a, b) => a.createdAt - b.createdAt);
    let body: Stored = { v: 1, activeId, chats: packed };
    let json = JSON.stringify(body);
    while (json.length > MAX_BYTES && body.chats.length > 1) {
      body = { ...body, chats: body.chats.slice(1) };
      json = JSON.stringify(body);
    }
    localStorage.setItem(KEY, json);
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
