// Open chats, held outside React so they survive the panel closing.
//
// A conversation is a live thing — a `claude` process streaming into it — so
// it can't live in component state that unmounts with the panel. Same reasoning
// as the terminal's session store: the panel is a *view* of these, not their
// owner. That's also what lets many exist at once instead of one at a time.

import { api } from "./api.ts";

export type ChatMsg = {
  role: "user" | "assistant";
  text: string;
  tools: string[];
  streaming?: boolean;
  /** Replayed from the session's transcript when this chat adopted an existing
   *  session, rather than said in this panel. Marked so the UI can draw the
   *  seam — and so it's clear these were not sent from here. */
  historical?: boolean;
};

export type Chat = {
  id: string;
  cwd: string;
  model: string;
  mode: string;
  title: string;        // derived from the first message; the tab label
  messages: ChatMsg[];
  sessionId: string;    // claude's own id, for resuming
  sending: boolean;
  draft: string;        // per-chat, so switching tabs doesn't lose what you typed
  createdAt: number;
  abort: AbortController | null;
  unread: boolean;      // replied while you were looking at another chat
};

const chats = new Map<string, Chat>();
const subs = new Set<() => void>();
let seq = 0;

export const DEFAULT_MODEL = "claude-opus-4-8";
export const DEFAULT_MODE = "default";

// A cached snapshot, rebuilt only when something actually changes.
//
// useSyncExternalStore compares snapshots by identity to decide whether to
// re-render, so returning a freshly built array on every read would look like
// an endless stream of changes — React treats that as an infinite loop and
// tears the tree down. The list is rebuilt on emit instead, which is exactly
// when it can differ.
let snapshot: Chat[] = [];
function rebuild() { snapshot = [...chats.values()].sort((a, b) => a.createdAt - b.createdAt); }
function emit() { rebuild(); subs.forEach((fn) => fn()); }
export function subscribe(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn); }

export const listChats = (): Chat[] => snapshot;
export const getChat = (id: string): Chat | undefined => chats.get(id);
export const chatCount = () => chats.size;

/** Open a chat. `resume` adopts an existing claude session instead of starting
 *  a fresh one: the next message goes out with `--resume <id>`, so the model
 *  still has the whole conversation even though this panel has no transcript of
 *  it. That's what turns a finished session in the fleet view into something you
 *  can pick back up, rather than only read. */
export function newChat(
  cwd: string,
  model = DEFAULT_MODEL,
  mode = DEFAULT_MODE,
  resume?: { sessionId: string; title?: string },
): Chat {
  const id = `c${++seq}-${Date.now().toString(36)}`;
  const chat: Chat = {
    id, cwd, model, mode,
    title: resume?.title || "new chat",
    messages: [], sessionId: resume?.sessionId ?? "",
    sending: false, draft: "", createdAt: Date.now(), abort: null, unread: false,
  };
  chats.set(id, chat);
  emit();
  // Resuming leaves `claude` holding the whole conversation while this panel
  // holds none of it, so an adopted session opened as a blank canvas — the
  // model knew everything and the user could see nothing, which reads as the
  // resume having silently failed. Replay the transcript we already store so
  // the thread you are continuing is actually in front of you.
  if (resume?.sessionId) void hydrate(id, resume.sessionId);
  return chat;
}

/** Fill a resumed chat with the session's existing conversation.
 *
 *  Best-effort and non-blocking: the chat is usable the moment it opens, and a
 *  failure here costs history on screen, not the ability to continue — `claude`
 *  still has the real context either way. */
async function hydrate(chatId: string, sessionId: string) {
  try {
    const s = await api.session(sessionId);
    if (!s) return;
    // Oldest-first, matching how the panel reads. Tool runs are left out: this
    // is the conversation view, and the session modal already renders the full
    // interleaved timeline for anyone who wants the machinery.
    const msgs: ChatMsg[] = [...(s.conversation ?? [])]
      .sort((a, b) => a.ts - b.ts)
      .map((c) => ({ role: c.role, text: c.text, tools: [], historical: true }));
    if (!msgs.length) return;
    update(chatId, (c) => {
      // Anything typed while this was in flight stays last — the reply to a
      // resumed thread must not end up above the thread it replies to.
      c.messages = [...msgs, ...c.messages];
    });
  } catch { /* history is a nicety; the resume itself still works */ }
}

/** An existing chat already resuming this claude session, if any — so asking to
 *  resume twice focuses the open tab instead of forking a second writer onto
 *  the same transcript. */
/** How many chats have answered while you were looking elsewhere.
 *
 *  A chat runs on its own clock: you send, switch to the diff, and the reply
 *  lands minutes later against a closed panel. Without a count surfaced outside
 *  the panel, "is anything waiting for me?" is only answerable by opening it. */
export const attentionCount = (): number => snapshot.reduce((n, c) => n + (c.unread ? 1 : 0), 0);

export const chatResuming = (sessionId: string): Chat | undefined =>
  [...chats.values()].find((c) => c.sessionId === sessionId);

export function closeChat(id: string) {
  const c = chats.get(id);
  if (!c) return;
  c.abort?.abort(); // a closed tab must not keep a stream running
  chats.delete(id);
  emit();
}

/** Mutate a chat in place and notify. Chats are big and change often while
 *  streaming; copying the whole list per token would be wasted work. */
export function update(id: string, fn: (c: Chat) => void) {
  const c = chats.get(id);
  if (!c) return;
  fn(c);
  emit();
}

const titleOf = (s: string) => {
  const t = s.trim().split("\n")[0].slice(0, 48);
  return t.length ? t : "new chat";
};

/**
 * Send a message on a chat and stream the reply into it.
 *
 * `activeId` decides whether the reply counts as unread — a chat answering in
 * the background should say so, and the one on screen shouldn't.
 */
export async function send(id: string, text: string, isActive: () => boolean, allowedTools: string[] = []) {
  const chat = chats.get(id);
  const msg = text.trim();
  if (!chat || !msg || chat.sending || !chat.cwd) return;

  update(id, (c) => {
    if (c.messages.length === 0) c.title = titleOf(msg);
    c.messages.push({ role: "user", text: msg, tools: [] });
    c.messages.push({ role: "assistant", text: "", tools: [], streaming: true });
    c.sending = true;
    c.draft = "";
  });

  const ac = new AbortController();
  update(id, (c) => { c.abort = ac; });

  const onEvent = (o: Record<string, unknown>) => {
    const t = o.type;
    if (t === "system" && o.subtype === "init" && typeof o.session_id === "string") {
      update(id, (c) => { c.sessionId = o.session_id as string; });
      return;
    }
    if (t === "assistant") {
      const blocks = (((o.message as Record<string, unknown>)?.content) ?? []) as Array<Record<string, unknown>>;
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (!last || last.role !== "assistant") return;
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") last.text += b.text;
          else if (b.type === "tool_use" && typeof b.name === "string") {
            const inp = (b.input ?? {}) as Record<string, unknown>;
            const hint = typeof inp.command === "string" ? `: ${inp.command.slice(0, 44)}`
              : typeof inp.file_path === "string" ? `: ${String(inp.file_path).split("/").pop()}` : "";
            last.tools.push(String(b.name) + hint);
          }
        }
        if (!isActive()) c.unread = true;
      });
    } else if (t === "agx_error") {
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (last?.role === "assistant") { last.text += `\n[error] ${String(o.error)}`; last.streaming = false; }
      });
    }
  };

  try {
    await api.chatStream({ cwd: chat.cwd, message: msg, model: chat.model, mode: chat.mode, resumeId: chat.sessionId, allowedTools }, onEvent, ac.signal);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) {
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (last?.role === "assistant") last.text += `\n[error] ${String(e)}`;
      });
    }
  } finally {
    update(id, (c) => {
      c.sending = false;
      c.abort = null;
      const last = c.messages[c.messages.length - 1];
      if (last?.role === "assistant") last.streaming = false;
      if (!isActive()) c.unread = true;
    });
  }
}

export function stop(id: string) {
  chats.get(id)?.abort?.abort();
}
