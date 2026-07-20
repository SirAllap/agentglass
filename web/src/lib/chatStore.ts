// Open chats, held outside React so they survive the panel closing.
//
// A conversation is a live thing — a `claude` process streaming into it — so
// it can't live in component state that unmounts with the panel. Same reasoning
// as the terminal's session store: the panel is a *view* of these, not their
// owner. That's also what lets many exist at once instead of one at a time.

import { api, ChatStreamError } from "./api.ts";
import type { ChatImage, WatchEvent } from "../../../shared/types.ts";

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
  /** A Bash tool's own description of its intent, when it gave one. */
  note?: string | null;
  /** The subagent that ran it, when it wasn't the main thread. This is what
   *  lets the chat fold a fleet's work back under the call that spawned it,
   *  instead of interleaving four agents into one unreadable run. */
  agentId?: string | null;
  agentType?: string | null;
};

/** What a tool acted on: a file path, a command, a URL, a query.
 *
 *  Mirrors the per-tool choice the server makes for the session timeline
 *  (`target()` in db.ts). Both the streamed reply and the live socket land
 *  here, so a tool call reads the same however it reached us. */
const strv = (v: unknown) => (typeof v === "string" && v ? v : null);
export function toolTarget(name: string, inp: Record<string, unknown>): string | null {
  return name === "Bash"
    ? strv(inp.command)
    : strv(inp.file_path) ?? strv(inp.path) ?? strv(inp.url) ?? strv(inp.query) ?? strv(inp.pattern) ?? strv(inp.description) ?? strv(inp.command);
}

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
  /**
   * The model's reasoning, when it was thinking out loud.
   *
   * Arrives as its own block type on the stream and was being dropped on the
   * floor — so a turn that spent two minutes reasoning and then said one line
   * looked like a model that had very little to say. Kept separate from `text`
   * rather than concatenated: it's a different register, it's usually much
   * longer than the answer, and it belongs behind a fold.
   */
  thinking?: string;
};

/** What a turn cost. Every field is already on the stream's `usage` object;
 *  none of it was being read. */
export type ChatUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The whole prompt as re-sent on the last turn — input + both caches. That
   *  sum *is* the context window in use, which is the number worth showing. */
  contextTokens: number;
  costUsd: number;
};

/** A message typed during someone else's turn, waiting for its own. */
export type QueuedTurn = { id: string; text: string; images: ChatImage[] };

export type Chat = {
  id: string;
  cwd: string;
  /** What we ask for: the dropdown's pick, sent with every turn. */
  model: string;
  /** What the CLI reported running, off the `init` frame. Differs from `model`
   *  whenever an alias expands or a fallback takes over, and it is the only
   *  place the window suffix (`[1m]`) is guaranteed to survive — so it, not
   *  `model`, is what the context meter measures against. Absent until the
   *  first turn has started. */
  resolvedModel?: string;
  mode: string;
  title: string;        // derived from the first message; the tab label
  messages: ChatMsg[];
  sessionId: string;    // claude's own id, for resuming
  sending: boolean;
  draft: string;        // per-chat, so switching tabs doesn't lose what you typed
  attachments: Attachment[]; // pasted images, per-chat for the same reason as the draft
  /** Turns typed while the model was still replying, sent in order as it frees
   *  up. A turn is one `claude -p` subprocess reading a single message off
   *  stdin, so there is nothing to interrupt mid-flight — the CLI does the same
   *  thing, holding what you type until the turn boundary. Without this the
   *  composer is dead for the length of a reply, which for a long tool-running
   *  turn is minutes of watching and not being able to answer. */
  queued: QueuedTurn[];
  createdAt: number;
  abort: AbortController | null;
  unread: boolean;      // replied while you were looking at another chat
  renamed?: boolean;    // titled by hand, so the first message must not overwrite it
  blockedTool?: string; // a tool the allowlist refused, so the UI can offer to add it
  /** Why this chat wants you, if it does.
   *
   *  Distinct from `unread`, which flips on every streamed chunk and so only
   *  ever meant "something moved". These are the two states worth walking back
   *  to the panel for: `blocked` — it hit a tool it may not run and has given
   *  up on it, which nothing but you can resolve — and `done`, the turn is over.
   *  `blocked` outranks `done`: a turn that ends after a refusal finished only
   *  in the sense that it stopped. */
  attention: "none" | "done" | "blocked";
  /** Running totals for this chat, accumulated from each turn's `usage`. */
  usage?: ChatUsage;
  /** The CLI never got going and named what would fix it — almost always a
   *  `claude` that has never been logged in. Distinct from a failed turn:
   *  retrying changes nothing until the command is run. */
  setupNeeded?: { command: string; why: string };
  /** Timestamp of the newest thing already on screen from the session's own
   *  transcript. The live socket replays a window of recent events on every
   *  connect, so without a watermark reopening the panel would re-append the
   *  history the replay had just finished drawing. */
  liveFrom?: number;
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
    sending: false, draft: "", attachments: [], queued: [], createdAt: Date.now(), abort: null, unread: false,
    attention: "none",
  };
  chats.set(id, chat);
  emit();
  // Resuming leaves `claude` holding the whole conversation while this panel
  // holds none of it, so an adopted session opened as a blank canvas — the
  // model knew everything and the user could see nothing, which reads as the
  // resume having silently failed. Replay the transcript we already store so
  // the thread you are continuing is actually in front of you.
  // Live starts now, not at the dawn of the session. `hydrate` is async and the
  // socket is already delivering, so without a watermark set up front the two
  // race and the replay lands on top of history the live path had just drawn.
  // hydrate only ever raises this, never lowers it.
  if (resume?.sessionId) { chat.liveFrom = Date.now(); void hydrate(id, resume.sessionId); }
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
    /*
     * The same timeline the session modal renders — messages *and* the tools
     * that ran between them.
     *
     * This used to replay `conversation` alone, on the theory that a chat is
     * for talking and the modal is for the machinery. In practice it made a
     * resumed session unreadable: an agent that spends twenty minutes editing
     * files says almost nothing while doing it, so stripping the tools left a
     * handful of one-line preambles — "Applying the two fixes.", "Now lint and
     * type checks:" — with every fix, command and file they referred to gone.
     * You resumed a conversation and were handed its table of contents.
     *
     * Tools attach to the message above them, which is how the live path
     * already groups them, so a replayed turn renders identically to one that
     * just happened.
     */
    const entries = [...(s.timeline ?? [])].sort((a, b) => a.ts - b.ts);
    const msgs: ChatMsg[] = [];
    for (const e of entries) {
      if (e.kind === "message") {
        // `role` is optional on the wire (it only applies to message entries),
        // so an entry that somehow lost it reads as the agent rather than
        // silently becoming a message the user never sent.
        msgs.push({ role: e.role ?? "assistant", text: e.text ?? "", tools: [], ts: e.ts, historical: true });
      } else if (e.kind === "tool") {
        const tool: ChatTool = {
          id: e.tool_use_id || `h${e.ts}-${msgs.length}`,
          name: e.tool ?? "tool",
          target: e.target ?? null,
          output: e.output ?? null,
          error: !!e.is_error,
          ts: e.ts,
          note: e.note ?? null,
          agentId: e.agent_id ?? null,
          agentType: e.agent_type ?? null,
        };
        const last = msgs[msgs.length - 1];
        // A tool that ran before anything was said still has to appear, or the
        // first thing a resumed session did is invisible.
        if (last && last.role === "assistant") last.tools.push(tool);
        else msgs.push({ role: "assistant", text: "", tools: [tool], ts: e.ts, historical: true });
      }
    }
    // Older servers answer with `conversation` only.
    if (!msgs.length) {
      msgs.push(...[...(s.conversation ?? [])]
        .sort((a, b) => a.ts - b.ts)
        .map((c) => ({ role: c.role, text: c.text, tools: [], ts: c.ts, historical: true })));
    }
    if (!msgs.length) return;
    update(chatId, (c) => {
      // Anything typed while this was in flight stays last — the reply to a
      // resumed thread must not end up above the thread it replies to.
      c.messages = [...msgs, ...c.messages];
      // Everything up to here is now drawn, so the live stream picks up from
      // the far side of it rather than replaying it back on top.
      c.liveFrom = Math.max(c.liveFrom ?? 0, msgs[msgs.length - 1]?.ts ?? 0);
    });
  } catch { /* history is a nicety; the resume itself still works */ }
}

// Live events already folded in. The socket replays a window on every connect
// and can redeliver, and a chat may be adopted long after its session started,
// so identity of the event is the only reliable "have I drawn this".
const applied = new Set<number>();
const APPLIED_MAX = 8000;

/**
 * Fold one live hook event into the chat watching that session.
 *
 * The chat panel had no live subscription at all: `hydrate()` ran once when the
 * tab was created and nothing ever updated it again. So a resumed session was a
 * photograph — you picked up a conversation, the agent carried on working in
 * the terminal, and the panel sat on whatever had been true at the moment you
 * clicked. The only streaming path was the response body of your own
 * `POST /chat/send`, which exists for exactly as long as a turn you typed.
 *
 * The socket already carries everything needed to keep it honest —
 * `UserPromptSubmit` has the prompt, `Stop` the assistant's reply, and the
 * tool pair the call and its output — so this is a matter of routing, not of
 * new plumbing. Called from the one place `useLive` is consumed.
 */
export function applyLiveEvent(ev: WatchEvent) {
  if (applied.has(ev.id)) return;
  // Walk the map rather than spreading it into an array to call .find(). Most
  // events belong to no open chat at all, so this is the hot path and the
  // allocation was the whole cost of it.
  if (!ev.session_id) return;
  let chat: Chat | undefined;
  for (const c of chats.values()) {
    if (c.sessionId === ev.session_id) { chat = c; break; }
  }
  if (!chat) return;

  applied.add(ev.id);
  if (applied.size > APPLIED_MAX) {
    // Bounded, and trimmed to the newest half: ids only ever grow, so the ones
    // dropped are far behind anything the server would still be sending.
    const keep = [...applied].sort((a, b) => a - b).slice(-APPLIED_MAX / 2);
    applied.clear();
    for (const id of keep) applied.add(id);
  }

  // Our own turn is already being streamed into this chat over the send()
  // response, so taking the main thread's work off the socket as well would
  // print every tool call and every reply twice.
  //
  // Subagents are the exception, and the reason this isn't a blanket skip:
  // `stream-json` reports a spawned agent as a single `Task` call and its final
  // answer, so the twenty minutes it spent reading the codebase are invisible
  // until it is over. The socket carries every one of those calls. Nothing
  // sidechained ever comes down the send stream, so there is nothing to
  // duplicate — the two sources are disjoint.
  if (chat.sending && !ev.agent_id) return;
  // Already on screen from the transcript replay. The watermark marks where we
  // attached and then stays put — `applied` is what catches redelivery. Moving
  // it forward per event would drop any second event sharing a millisecond with
  // the one before it, which a Stop and the tool call after it routinely do.
  if (ev.timestamp <= (chat.liveFrom ?? 0)) return;

  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const id = chat.id;
  const ts = ev.timestamp;

  switch (ev.hook_event_type) {
    case "UserPromptSubmit": {
      const text = strv(p.prompt);
      if (!text) return;
      update(id, (c) => {
        c.messages.push({ role: "user", text, tools: [], ts });
      });
      return;
    }
    case "Stop": {
      // A Stop with nothing said is just the turn ending — the tools that ran
      // during it are already their own rows, and a blank bubble under them
      // reads as the agent having answered with silence.
      const text = strv(p.last_assistant_message);
      if (!text) return;
      update(id, (c) => {
        c.messages.push({ role: "assistant", text, tools: [], ts });
      });
      return;
    }
    case "PreToolUse": {
      const name = ev.tool_name || strv(p.tool_name);
      if (!name) return;
      const inp = (p.tool_input ?? {}) as Record<string, unknown>;
      const tool: ChatTool = {
        id: ev.tool_use_id || strv(p.tool_use_id) || `l${ev.id}`,
        name,
        target: toolTarget(name, inp),
        output: null,
        error: false,
        ts,
        note: name === "Bash" ? strv(inp.description) : null,
        agentId: ev.agent_id ?? strv(p.agent_id),
        agentType: ev.agent_type ?? strv(p.agent_type),
      };
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        // Tools attach to the turn above them, the way both the replay and the
        // streamed path already group them. A tool that ran before anything was
        // said still needs somewhere to live.
        if (last && last.role === "assistant") last.tools.push(tool);
        else c.messages.push({ role: "assistant", text: "", tools: [tool], ts });
      });
      return;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const useId = ev.tool_use_id || strv(p.tool_use_id);
      if (!useId) return;
      const resp = (p.tool_response ?? {}) as Record<string, unknown>;
      const text = strv(resp.content);
      update(id, (c) => {
        // Newest first: a long session can reuse nothing, but scanning from the
        // end finds the call that just ran in a step or two instead of walking
        // the whole transcript.
        for (let i = c.messages.length - 1; i >= 0; i--) {
          const row = c.messages[i].tools.find((t) => t.id === useId);
          if (!row) continue;
          if (text) row.output = text.trimEnd();
          row.error = ev.is_error === 1 || resp.is_error === true;
          break;
        }
      });
      return;
    }
  }
}

/** How many chats are asking for you — finished, or stuck on a refused tool.
 *
 *  A chat runs on its own clock: you send, switch to the diff, and the reply
 *  lands minutes later against a closed panel. Without a count surfaced outside
 *  the panel, "is anything waiting for me?" is only answerable by opening it. */
export const attentionCount = (): number => snapshot.reduce((n, c) => n + (c.attention !== "none" ? 1 : 0), 0);

/** Drop a chat's claim on your attention. Called when it comes on screen —
 *  looking at it *is* the acknowledgement, so nothing else has to dismiss it. */
export function clearAttention(id: string) {
  const c = chats.get(id);
  if (!c || (c.attention === "none" && !c.unread)) return; // no emit for a no-op
  update(id, (x) => { x.unread = false; x.attention = "none"; });
}

/** An existing chat already resuming this claude session, if any — so asking to
 *  resume twice focuses the open tab instead of forking a second writer onto
 *  the same transcript. */
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
export async function send(id: string, text: string, isActive: () => boolean, allowedTools: string[] = [], queuedImages?: ChatImage[]) {
  const chat = chats.get(id);
  const msg = text.trim();
  // An image alone is a complete turn, so the draft may be empty when something
  // is attached.
  //
  // A queued turn carries its own images: it left the composer when it was
  // typed, so by the time it is sent the attachments there belong to whatever
  // is being written next.
  const images: ChatImage[] = queuedImages ?? (chat ? chat.attachments.map((a) => ({ mediaType: a.mediaType, data: a.data })) : []);
  if (!chat || (!msg && !images.length) || chat.sending || !chat.cwd) return;

  update(id, (c) => {
    // A name you chose outranks one derived from the first message.
    if (c.messages.length === 0 && !c.renamed) c.title = titleOf(msg || `${images.length} image${images.length > 1 ? "s" : ""}`);
    c.messages.push({ role: "user", text: msg, tools: [], ts: Date.now(), images: images.length ? images : undefined });
    c.messages.push({ role: "assistant", text: "", tools: [], ts: Date.now(), streaming: true });
    c.sending = true;
    // A queued turn was taken out of the composer when it was typed. Whatever
    // is in there now is the *next* message being written, and clearing it
    // would delete it out from under the cursor.
    if (!queuedImages) {
      c.draft = "";
      // The thumbnails belong to the composer, not the sent message, so their
      // object URLs are released as the attachments leave it.
      for (const a of c.attachments) URL.revokeObjectURL(a.url);
      c.attachments = [];
    }
  });

  const ac = new AbortController();
  update(id, (c) => { c.abort = ac; });

  const toolNames = new Map<string, string>();
  const onEvent = (o: Record<string, unknown>) => {
    const t = o.type;
    if (t === "system" && o.subtype === "init" && typeof o.session_id === "string") {
      // `claude --resume` forks a new id, so this is usually a different session
      // from the one we adopted. Rebase the live watermark with it: nothing that
      // session did before this moment is ours to draw.
      //
      // The same frame reports the model the CLI actually resolved, which is not
      // always the one we asked for — an alias (`opus`) expands, a fallback may
      // have taken over, and the id carries the window suffix (`[1m]`) that
      // decides how much context this chat really has.
      update(id, (c) => {
        c.sessionId = o.session_id as string;
        c.liveFrom = Date.now();
        if (typeof o.model === "string" && o.model) c.resolvedModel = o.model;
      });
      return;
    }
    if (t === "assistant") {
      const blocks = (((o.message as Record<string, unknown>)?.content) ?? []) as Array<Record<string, unknown>>;
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (!last || last.role !== "assistant") return;
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") last.text += b.text;
          // Reasoning, kept apart from the answer. Streams in chunks like text.
          else if (b.type === "thinking" && typeof b.thinking === "string") {
            last.thinking = (last.thinking ?? "") + b.thinking;
          }
          else if (b.type === "tool_use" && typeof b.name === "string") {
            // The result comes back later keyed only by id, so remember which
            // tool it was — both to name a refusal and to attach the output.
            if (typeof b.id === "string") toolNames.set(b.id, String(b.name));
            const inp = (b.input ?? {}) as Record<string, unknown>;
            const name = String(b.name);
            last.tools.push({
              id: String(b.id ?? `${Date.now()}`),
              name,
              // Same per-tool notion of "what it acted on" the server uses for
              // the session timeline, so the two views agree.
              target: toolTarget(name, inp),
              output: null,
              error: false,
              ts: Date.now(),
              note: name === "Bash" ? strv(inp.description) : null,
            });
          }
        }
        /*
         * What the turn cost, straight off the message.
         *
         * Input and output accumulate — they're spend. Context does NOT: every
         * API call re-sends the whole conversation, so the latest turn's prompt
         * size *is* the current context, and summing it would produce a number
         * several times the window within a few turns.
         */
        const u = (o.message as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
        if (u) {
          const n = (k: string) => Number(u[k]) || 0;
          const inTok = n("input_tokens"), cr = n("cache_read_input_tokens"), cw = n("cache_creation_input_tokens");
          const prev = c.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, costUsd: 0 };
          c.usage = {
            input: prev.input + inTok,
            output: prev.output + n("output_tokens"),
            cacheRead: prev.cacheRead + cr,
            cacheWrite: prev.cacheWrite + cw,
            contextTokens: inTok + cr + cw,
            costUsd: prev.costUsd,
          };
        }
        if (!isActive()) c.unread = true;
      });
    } else if (t === "result" && typeof o.total_cost_usd === "number") {
      // The final frame carries the turn's real cost, priced by the CLI — far
      // better than pricing tokens ourselves against a model table that drifts.
      update(id, (c) => {
        const prev = c.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, costUsd: 0 };
        c.usage = { ...prev, costUsd: prev.costUsd + (o.total_cost_usd as number) };
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
        // Raised even while this chat is on screen: the composer's banner is
        // only visible if you are actually watching, and switching away must
        // not silently drop the flag. Focusing the chat is what clears it.
        if (tool) update(id, (c) => { c.blockedTool = tool; c.attention = "blocked"; });
      }
    } else if (t === "agx_error") {
      update(id, (c) => {
        const last = c.messages[c.messages.length - 1];
        if (last?.role === "assistant") { last.text += `\n[error] ${String(o.error)}`; last.streaming = false; }
        // A setup failure isn't a turn that went wrong — it's a turn that never
        // started, and it will fail identically every time until you do the one
        // thing it names. Raise it as attention so the chat says it needs you
        // rather than just going quiet.
        if (typeof o.setupCommand === "string") {
          c.setupNeeded = { command: o.setupCommand, why: String(o.error ?? "") };
          c.attention = "blocked";
        }
      });
    }
  };

  let broke = false;
  try {
    await api.chatStream({ cwd: chat.cwd, message: msg, model: chat.model, mode: chat.mode, resumeId: chat.sessionId, allowedTools, images }, onEvent, ac.signal);
  } catch (e) {
    // A queue must not keep firing into a turn that failed or one you just
    // interrupted — the rest of it stays put, visible, for you to decide on.
    broke = true;
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
    // Read before the update, because draining pops it.
    const next = broke ? undefined : chats.get(id)?.queued[0];
    update(id, (c) => {
      c.sending = false;
      c.abort = null;
      if (next) c.queued = c.queued.filter((q) => q.id !== next.id);
      // This turn is fully drawn from the stream. The transcript scanner will
      // publish the same work on the socket moments from now, once it has read
      // the JSONL back off disk — move the watermark past it so the turn you
      // just watched does not arrive a second time.
      c.liveFrom = Date.now();
      const last = c.messages[c.messages.length - 1];
      if (last?.role === "assistant") last.streaming = false;
      if (!isActive()) {
        c.unread = true;
        // A refusal already asked for you by name; "done" must not overwrite it
        // with the weaker claim.
        // With a queue behind it the chat isn't done either, it's between
        // turns — calling you back for that would cry wolf on every message
        // you queued yourself.
        if (c.attention !== "blocked" && !next) c.attention = "done";
      }
    });
    if (next) void send(id, next.text, isActive, allowedTools, next.images);
  }
}

/** Hold a turn until the current one ends. Same shape as `send`: it takes the
 *  draft and the composer's attachments and empties both, so typing and Enter
 *  feel identical whether or not something is already running. */
export function enqueue(id: string, text: string) {
  const chat = chats.get(id);
  const msg = text.trim();
  if (!chat) return;
  const images: ChatImage[] = chat.attachments.map((a) => ({ mediaType: a.mediaType, data: a.data }));
  if (!msg && !images.length) return;
  update(id, (c) => {
    c.queued.push({ id: `q${++seq}`, text: msg, images });
    c.draft = "";
    for (const a of c.attachments) URL.revokeObjectURL(a.url);
    c.attachments = [];
  });
}

/** Take a queued turn back out — either to drop it or, with `toDraft`, to put
 *  it back in the composer and reword it. `toDraft` restores the text only, so
 *  the panel offers it for text-only turns; an image would be silently lost. */
export function unqueue(id: string, qid: string, toDraft = false) {
  update(id, (c) => {
    const q = c.queued.find((x) => x.id === qid);
    if (!q) return;
    c.queued = c.queued.filter((x) => x.id !== qid);
    // Appended, not assigned: whatever is half-typed in there is still wanted.
    if (toDraft && q.text) c.draft = c.draft ? `${c.draft}\n${q.text}` : q.text;
  });
}

export function stop(id: string) {
  // Stopping means stopping, not "stop this one and start the next" — a queue
  // that survived the interrupt would fire the moment the stream tore down.
  update(id, (c) => { c.queued = []; });
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
