// Open chats, held outside React so they survive the panel closing.
//
// A conversation is a live thing — a `claude` process streaming into it — so
// it can't live in component state that unmounts with the panel. Same reasoning
// as the terminal's session store: the panel is a *view* of these, not their
// owner. That's also what lets many exist at once instead of one at a time.

import { api, ChatStreamError } from "./api.ts";
import type { ChatImage } from "../../../shared/types.ts";

/** A pasted image waiting in the composer. `url` is an object URL for the
 *  thumbnail; it is revoked when the attachment is dropped or sent, since
 *  otherwise every paste leaks a blob for the life of the tab. */
export type Attachment = ChatImage & { id: string; name: string; bytes: number; url: string };

/** A tool the agent ran inside a turn. Shaped like the session timeline's rows
 *  so both render through the same component — the chat used to keep only the
 *  name, which lost the command, its output and whether it failed. */
export type ChatTool = {
  id: string;
  name: string;
  target: string | null;
  output: string | null;
  error: boolean;
  ts: number;
};

export type ChatMsg = {
  role: "user" | "assistant";
  text: string;
  tools: ChatTool[];
  /** When it was said — the session view has always shown this and the chat
   *  hasn't, which is most of why they read as different products. */
  ts: number;
  streaming?: boolean;
  /** Images sent with this turn, shown back in the transcript so the message
   *  reads the way it was written. */
  images?: ChatImage[];
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
  attachments: Attachment[]; // pasted images, per-chat for the same reason as the draft
  createdAt: number;
  abort: AbortController | null;
  unread: boolean;      // replied while you were looking at another chat
  renamed?: boolean;    // titled by hand, so the first message must not overwrite it
  blockedTool?: string; // a tool the allowlist refused, so the UI can offer to add it
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
    sending: false, draft: "", attachments: [], createdAt: Date.now(), abort: null, unread: false,
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
      .map((c) => ({ role: c.role, text: c.text, tools: [], ts: c.ts, historical: true }));
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


/** Name a chat by hand. The derived title is a fallback for chats you never
 *  named; once you have, nothing should quietly replace it. */
export function renameChat(id: string, title: string) {
  const t = title.trim().slice(0, 60);
  update(id, (c) => { c.title = t || c.title; c.renamed = !!t; });
}

export function closeChat(id: string) {
  const c = chats.get(id);
  if (!c) return;
  c.abort?.abort(); // a closed tab must not keep a stream running
  for (const a of c.attachments) URL.revokeObjectURL(a.url);
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
  // An image alone is a complete turn, so the draft may be empty when something
  // is attached.
  const images: ChatImage[] = chat ? chat.attachments.map((a) => ({ mediaType: a.mediaType, data: a.data })) : [];
  if (!chat || (!msg && !images.length) || chat.sending || !chat.cwd) return;

  update(id, (c) => {
    // A name you chose outranks one derived from the first message.
    if (c.messages.length === 0 && !c.renamed) c.title = titleOf(msg || `${images.length} image${images.length > 1 ? "s" : ""}`);
    c.messages.push({ role: "user", text: msg, tools: [], ts: Date.now(), images: images.length ? images : undefined });
    c.messages.push({ role: "assistant", text: "", tools: [], ts: Date.now(), streaming: true });
    c.sending = true;
    c.draft = "";
    // The thumbnails belong to the composer, not the sent message, so their
    // object URLs are released as the attachments leave it.
    for (const a of c.attachments) URL.revokeObjectURL(a.url);
    c.attachments = [];
  });

  const ac = new AbortController();
  update(id, (c) => { c.abort = ac; });

  const toolNames = new Map<string, string>();
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
            // The result comes back later keyed only by id, so remember which
            // tool it was — both to name a refusal and to attach the output.
            if (typeof b.id === "string") toolNames.set(b.id, String(b.name));
            const inp = (b.input ?? {}) as Record<string, unknown>;
            const str = (v: unknown) => (typeof v === "string" && v ? v : null);
            // Same per-tool notion of "what it acted on" the server uses for
            // the session timeline, so the two views agree.
            const target = String(b.name) === "Bash" ? str(inp.command)
              : str(inp.file_path) ?? str(inp.url) ?? str(inp.query) ?? str(inp.pattern) ?? str(inp.description);
            last.tools.push({
              id: String(b.id ?? `${Date.now()}`),
              name: String(b.name),
              target,
              output: null,
              error: false,
              ts: Date.now(),
            });
          }
        }
        if (!isActive()) c.unread = true;
      });
    } else if (t === "user") {
      // `claude -p` has no terminal to prompt from, so a tool outside the
      // allowlist is refused and the turn simply carries on without it. The
      // model reports being "blocked" and the user, who never saw a dialog,
      // has no way to know an allowlist exists — let alone which entry to add.
      const blocks = (((o.message as Record<string, unknown>)?.content) ?? []) as Array<Record<string, unknown>>;
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.map((x: Record<string, unknown>) => (typeof x?.text === "string" ? x.text : "")).join(" ")
          : "";
        const useId = String(b.tool_use_id ?? "");
        // Attach the answer to the row that asked for it, so the chat shows
        // what came back rather than only what was run.
        update(id, (c) => {
          for (const m of c.messages) {
            const row = m.tools.find((t) => t.id === useId);
            if (!row) continue;
            row.output = text.trimEnd() || null;
            row.error = b.is_error === true;
            break;
          }
        });
        if (!/permission|requires approval|not allowed|denied/i.test(text)) continue;
        const tool = toolNames.get(useId);
        if (tool) update(id, (c) => { c.blockedTool = tool; });
      }
    } else if (t === "agx_error") {
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (last?.role === "assistant") { last.text += `\n[error] ${String(o.error)}`; last.streaming = false; }
      });
    }
  };

  try {
    await api.chatStream({ cwd: chat.cwd, message: msg, model: chat.model, mode: chat.mode, resumeId: chat.sessionId, allowedTools, images }, onEvent, ac.signal);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) {
      // A ChatStreamError already carries a sentence written for this spot;
      // anything else is unexpected and its own text is the best there is.
      const why = e instanceof ChatStreamError ? e.message : String(e);
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (last?.role === "assistant") last.text += `\n[error] ${why}`;
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

// Mirrors the server's caps in server/src/chat.ts. The server is what actually
// enforces them — this copy exists only so an oversized paste is refused with a
// message in the composer instead of a failed request after the upload.
export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 10 * 1024 * 1024;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const toBase64 = (buf: ArrayBuffer) => {
  // Chunked because String.fromCharCode(...bytes) on a multi-megabyte image
  // blows the argument limit and throws.
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Attach images to a chat's composer. Returns a message to show the user when
 *  something was refused, or "" when everything was taken. */

/** A non-image file, quoted into the draft so it reaches the conversation.
 *
 *  Bounded because this becomes part of the prompt: a 5MB log pasted whole
 *  would be billed as tokens and drown the question being asked. Binary files
 *  return null — inlining their bytes as text helps nobody. */
const TEXT_FILE_MAX = 128 * 1024;
async function quoteTextFile(f: File): Promise<string | null> {
  if (f.size > TEXT_FILE_MAX) return null;
  let text: string;
  try { text = await f.text(); } catch { return null; }
  // A NUL byte is the cheap, reliable tell that this isn't text.
  if (!text || text.includes("\u0000")) return null;
  return `${f.name}:\n\n\u0060\u0060\u0060\n${text.trimEnd()}\n\u0060\u0060\u0060`;
}

export async function addAttachments(id: string, files: File[]): Promise<string> {
  const chat = chats.get(id);
  if (!chat) return "";
  let rejected = "";
  for (const f of files) {
    const c = chats.get(id);
    if (!c) break;
    if (!MEDIA_TYPES.has(f.type)) {
      // Anything that isn't an image claude can look at directly still has a
      // useful path: quote it into the message. `claude` runs with tools in the
      // project, so a file that lives there it can simply read — but a file
      // picked from anywhere else (a download, another disk) it cannot, and the
      // picker deliberately doesn't expose real paths. Inlining the text is the
      // only way that file reaches the conversation at all.
      const note = await quoteTextFile(f);
      if (note) update(id, (cc) => { cc.draft = cc.draft ? `${cc.draft}\n\n${note}` : note; });
      else rejected = `${f.name} isn't an image or a text file`;
      continue;
    }
    if (c.attachments.length >= MAX_IMAGES) { rejected = `at most ${MAX_IMAGES} images per message`; continue; }
    if (f.size > MAX_IMAGE_BYTES) { rejected = `each image must be under ${MAX_IMAGE_BYTES / 1024 / 1024}MB`; continue; }
    if (c.attachments.reduce((n, a) => n + a.bytes, 0) + f.size > MAX_IMAGES_TOTAL_BYTES) {
      rejected = `attachments must total under ${MAX_IMAGES_TOTAL_BYTES / 1024 / 1024}MB`;
      continue;
    }
    const data = toBase64(await f.arrayBuffer());
    update(id, (cc) => {
      cc.attachments.push({
        id: `a${++seq}-${Date.now().toString(36)}`,
        name: f.name || "pasted image",
        bytes: f.size,
        mediaType: f.type as Attachment["mediaType"],
        data,
        url: URL.createObjectURL(f),
      });
    });
  }
  return rejected;
}

export function dropAttachment(id: string, attId: string) {
  update(id, (c) => {
    const a = c.attachments.find((x) => x.id === attId);
    if (a) URL.revokeObjectURL(a.url);
    c.attachments = c.attachments.filter((x) => x.id !== attId);
  });
}
