import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ChatStreamError } from "../lib/api.ts";
import { toolTarget } from "../lib/chatStore.ts";
import { pollWhileVisible } from "../lib/poll.ts";
import { fmtUsd, fmtAgo, sessionTitle, modelLabelOf } from "../lib/format.ts";
import { sessionIsLive } from "../lib/derive.ts";
import { scopeSessions, openingScope, type ChatScope } from "./chatList.ts";
import { MODELS, resumeModel } from "./resumeModel.ts";
import { recentTurns } from "./transcript.ts";
import type { SessionDetail, SessionRollup, GitRepoRef } from "../../../shared/types.ts";

/**
 * Agents you can actually talk to, from a phone.
 *
 * Monitoring from the sofa is only half of it: seeing that an agent has stopped
 * and being unable to say "yes, carry on" is the same as not knowing. So this
 * is the part that talks back — read what a session has been doing, send it
 * another turn, take one over that was started at the desk, or start a new one.
 *
 * A chat here is a **session**, not a browser-local object. The desktop panel
 * keeps its chats in localStorage, which is per-origin and per-device: a phone
 * could never see them. Sessions are the server's own truth, they cover every
 * agent — the ones started from the app, from a terminal, from anywhere — and
 * resuming one by id is exactly what "take over from the phone" means. It also
 * means the conversation you continue on the phone is the same conversation
 * when you sit back down.
 */

/** How long a stream may say nothing before we stop trusting it and let the
 *  transcript speak again. Long enough for a slow tool call, short enough that
 *  a connection that died quietly does not leave you watching a dead screen. */
const STALL_MS = 45_000;

/** The three ranges the list offers, narrowest first. */
const SCOPES: [ChatScope, string][] = [["live", "Working"], ["today", "Today"], ["all", "All"]];

/** A turn being streamed right now, before the transcript catches up. */
type Live = { text: string; tools: string[]; error: string | null };

export function MobileChats({ sessions, onRefresh, onImmersive }: {
  sessions: SessionRollup[];
  onRefresh: () => void;
  /**
   * Tell the shell a conversation has the screen.
   *
   * Not decoration: `main` carries `z-index: 1`, which makes it a stacking
   * context, and a conversation rendered inside it cannot rise above the app
   * header however high its own z-index goes. The header painted straight over
   * the chat's bar, and the tab bar sat on top of the composer. A chat takes
   * the whole screen, so the shell puts its own chrome away rather than
   * fighting it.
   */
  onImmersive?: (on: boolean) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  /**
   * Where the open conversation runs, as far as this screen already knows.
   *
   * The session detail carries the same thing, but it takes a fetch to arrive,
   * and a chat started here is seconds old — the row the scanner writes may not
   * have a directory yet. Without this the composer replaced itself with "this
   * session did not record where it ran", which is a claim about the session
   * when the truth was "the answer has not come back yet". We picked the repo,
   * so we can simply say so.
   */
  const [openCwd, setOpenCwd] = useState("");
  /** Null until the first list arrives, so the opening scope is chosen from
   *  real sessions rather than from the empty array of the first render. */
  const [picked, setPicked] = useState<ChatScope | null>(null);
  const scope = picked ?? openingScope(sessions);
  const setScope = (s: ChatScope) => setPicked(s);
  const shown = useMemo(() => scopeSessions(sessions, scope), [sessions, scope]);
  const liveCount = useMemo(() => scopeSessions(sessions, "live").length, [sessions]);

  const open = (id: string, cwd: string) => { setOpenCwd(cwd); setOpenId(id); };

  // Leaving the tab, or the app, must give the chrome back.
  useEffect(() => {
    onImmersive?.(!!openId);
    return () => onImmersive?.(false);
  }, [openId, onImmersive]);

  if (composing) return <NewChat onCancel={() => setComposing(false)} onStarted={(id, cwd) => { setComposing(false); open(id, cwd); onRefresh(); }} />;
  if (openId) return <Conversation id={openId} knownCwd={openCwd} onBack={() => { setOpenId(null); onRefresh(); }} />;

  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => setComposing(true)}
        className="rounded-xl text-[15px] font-medium"
        style={{ minHeight: 52, color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
        + New chat
      </button>

      {/* Working, today, everything. The tab opens on the narrowest of these
          that has anything in it, so the first screen is the agents you could
          speak to rather than a scroll through the archive. */}
      <div className="flex gap-1.5">
        {SCOPES.map(([id, label]) => {
          const on = scope === id;
          return (
            <button key={id} onClick={() => setScope(id)}
              className="flex-1 rounded-lg text-[12px]"
              style={{
                minHeight: 38,
                color: on ? "var(--primary-hover)" : "var(--text3)",
                background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                border: `1px solid color-mix(in srgb, var(--border) ${on ? 55 : 26}%, transparent)`,
              }}>
              {label}{id === "live" && liveCount ? ` ${liveCount}` : ""}
            </button>
          );
        })}
      </div>

      {!shown.length && (
        <div className="rounded-2xl px-5 py-12 text-center" style={{ background: "color-mix(in srgb, var(--bg2) 45%, transparent)", border: "1px dashed color-mix(in srgb, var(--border) 45%, transparent)" }}>
          <div className="text-[14px]">{sessions.length ? "Nothing here" : "No agents yet"}</div>
          <div className="text-[12px] mt-1.5" style={{ color: "var(--text2)" }}>
            {sessions.length ? "Try a wider range above." : "Start one and it keeps running on your machine."}
          </div>
        </div>
      )}

      {shown.map((s) => {
        const running = !s.ended_at && Date.now() - s.last_seen < 120_000;
        return (
          <button key={s.session_id} onClick={() => open(s.session_id, s.cwd_path || s.project_path || "")}
            className="w-full text-left rounded-xl px-3.5 py-3 flex flex-col gap-1.5"
            style={{ background: "color-mix(in srgb, var(--bg2) 60%, transparent)", border: `1px solid color-mix(in srgb, var(--border) ${running ? 55 : 32}%, transparent)` }}>
            <div className="flex items-center gap-2">
              <span className="inline-block rounded-full shrink-0" style={{ width: 8, height: 8, background: running ? "var(--success)" : s.error_count ? "var(--error)" : "var(--text3)" }} />
              <span className="text-[13.5px] leading-tight truncate">{sessionTitle(s)}</span>
              <span className="ml-auto text-[10.5px] shrink-0" style={{ color: "var(--text3)" }}>{fmtAgo(s.last_seen)}</span>
            </div>
            <div className="flex items-center gap-x-3 text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>
              <span className="truncate">{baseName(s.cwd_path || s.project_path || s.source_app)}</span>
              <span className="ml-auto shrink-0">{modelLabelOf(s.model_name)}</span>
              <span className="shrink-0">{fmtUsd(s.cost_usd)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One session: what it has done, and a box to answer it.
 *
 * Laid out like every other chat application on the phone, because that is what
 * it is: one bar at the top carrying back, title and status, the thread filling
 * everything below it, the composer at the bottom. No app header above it and
 * no tab bar under it — inside a conversation neither is doing anything, and
 * between them they were taking 130 of 660 pixels and colliding while they did
 * it. The screen is its own scroll container rather than a slice of a scrolling
 * page, which is what stops the composer from drifting off when the browser's
 * URL bar collapses.
 */
function Conversation({ id, knownCwd, onBack }: { id: string; knownCwd: string; onBack: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  /** Typed while the agent was busy, waiting its turn. See `deliver`. */
  const [queued, setQueued] = useState<string[]>([]);
  /** Turns that arrived while you were reading further up. */
  const [behind, setBehind] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const handover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** Whether the thread is parked at the bottom. While it is, new turns follow
   *  the conversation down; while it is not, they must not move the page. */
  const pinned = useRef(true);

  // Leaving mid-turn must not leave a request or a timer running behind the
  // screen you just left.
  useEffect(() => () => {
    abort.current?.abort();
    if (handover.current) clearTimeout(handover.current);
  }, []);

  const load = useCallback(() => {
    api.session(id).then(setDetail).catch(() => { /* keep what is on screen */ });
  }, [id]);

  /**
   * Whether a turn of ours is streaming, readable from the interval without
   * being a dependency of it.
   *
   * This was `live` itself, in the effect's dependency array — which meant
   * every token that arrived tore the interval down, re-ran the effect, and
   * called `load()` on the way in. A long answer fired one full transcript
   * fetch per streamed chunk, which is the opposite of the "do not poll while
   * streaming" the guard inside was written to achieve, and it is what made
   * replying from the phone crawl.
   */
  const streaming = useRef(false);
  /** When the stream last said anything. A turn that has gone silent for a
   *  long time may have died in a way the socket never reported, so the
   *  transcript takes back over rather than leaving you on a dead screen. */
  const lastEvent = useRef(0);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    load();
    return pollWhileVisible(() => {
      // While our own turn is streaming the transcript is a scan behind, so
      // polling would paint a stale copy of what is already on screen. Once it
      // has gone quiet past the threshold that stops being true.
      const quiet = streaming.current && Date.now() - lastEvent.current > STALL_MS;
      if (!streaming.current || quiet) load();
      if (streaming.current) setStalled(quiet);
    }, 5000);
  }, [load]);

  /** The newest turns, oldest at the top and the latest one last — see
   *  transcript.ts for why the server's order is the other way round. */
  const turns = useMemo(() => recentTurns(detail?.conversation), [detail?.conversation]);

  /** Jump the thread to the newest turn. */
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    pinned.current = true;
    setBehind(0);
  }, []);

  /** Track whether you are reading the bottom of the thread or somewhere above
   *  it. 60px of slack: a thumb rarely lands exactly at the end. */
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (pinned.current) setBehind(0);
  };

  /**
   * Follow the conversation down, unless you are reading further up.
   *
   * Both halves matter. A chat that does not follow leaves you looking at an
   * old turn while the answer you are waiting for lands off-screen; one that
   * always follows snatches the page away mid-sentence whenever a poll brings
   * something in. So: pinned to the bottom, stay pinned; scrolled up, count
   * what arrived and offer it as a tap.
   *
   * Keyed on the newest timestamp as well as the count, because the transcript
   * is capped by a size budget on the server — a long session can gain a turn
   * and drop its oldest in the same poll without ever changing length.
   */
  const newestTs = turns.length ? turns[turns.length - 1]!.ts : 0;
  useEffect(() => {
    if (!newestTs) return;
    if (pinned.current) toBottom();
    else setBehind((n) => n + 1);
  }, [newestTs, turns.length, toBottom]);

  // Your own turn, streaming: always follow it. You just sent this.
  useEffect(() => { if (pinned.current) toBottom(); }, [live?.text, sent, queued.length, toBottom]);

  // The transcript's first arrival: land at the bottom with no animation, the
  // way opening a chat should.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !detail) return;
    landed.current = true;
    requestAnimationFrame(() => toBottom());
  }, [detail, toBottom]);

  const cwd = detail?.cwd_path || detail?.project_path || knownCwd;
  const running = !!detail && sessionIsLive(detail);

  /**
   * Whether this agent has a writer other than us right now.
   *
   * A session has exactly one writer. Sending into one that is already running
   * — in a terminal, or from the desktop app — puts a second `claude` on the
   * same transcript, and what comes back is the turn being interrupted: the
   * reply is cut off and the message is lost. The desktop has refused to resume
   * a live session since it learned this; the phone was still doing it.
   *
   * `owned` is what keeps that from freezing the composer for two minutes after
   * every reply: once a turn of ours has completed, the session is only "live"
   * because of the events we just caused, and the next turn is ours to send.
   */
  const owned = useRef(false);
  const busyElsewhere = running && !owned.current && !live;
  const busy = !!live || busyElsewhere;

  const deliver = async (message: string) => {
    if (!cwd) return;
    setSent(message);
    setLive({ text: "", tools: [], error: null });
    setStalled(false);
    streaming.current = true;
    lastEvent.current = Date.now();
    const ac = new AbortController();
    abort.current = ac;
    try {
      await api.chatStream(
        { cwd, message, model: resumeModel(detail?.model_name), mode: "default", resumeId: id },
        (o) => { lastEvent.current = Date.now(); setStalled(false); setLive((prev) => reduce(prev, o)); },
        ac.signal
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        // A dropped connection is not a failed turn: the agent is very likely
        // still working, and telling someone their message failed when it did
        // not is how they end up sending it twice.
        const why = e instanceof ChatStreamError ? e.message : String(e);
        setLive((p) => ({ text: p?.text ?? "", tools: p?.tools ?? [], error: why }));
      }
    } finally {
      streaming.current = false;
      abort.current = null;
      setStalled(false);
      // We have now written to this session, so its liveness from here on is
      // our own echo rather than someone else holding it. See `owned`.
      owned.current = true;
      // Let the transcript take over: it is the same turn, written by the
      // scanner, and keeping our copy as well would show it twice. Held in a
      // ref so leaving the conversation cancels it rather than waking a
      // component that is gone.
      handover.current = setTimeout(() => { setLive(null); setSent(null); load(); }, 1200);
    }
  };

  // `deliver` closes over this render's state, and the queue drains from an
  // effect that must not re-run every time any of it changes. A ref keeps the
  // effect stable and the call current.
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  /**
   * Send, or get in line.
   *
   * The CLI queues what you type while it is working and sends it when the turn
   * ends; typing at a busy agent should not mean losing the message, and it
   * certainly should not mean interrupting it.
   */
  const send = () => {
    const message = draft.trim();
    if (!message || !cwd) return;
    setDraft("");
    if (busy) { setQueued((q) => [...q, message]); return; }
    void deliverRef.current(message);
  };

  /** Drain the queue as soon as the agent is free, one turn at a time. */
  useEffect(() => {
    if (busy || !cwd || !queued.length) return;
    const next = queued[0]!;
    setQueued((q) => q.slice(1));
    void deliverRef.current(next);
  }, [busy, cwd, queued]);

  return (
    <div className="mb-screen mb-chat on">
      <div className="hd">
        <button className="back" onClick={onBack} aria-label="Back to chats">←</button>
        <div className="t">
          <b>{detail ? sessionTitle(detail) : "…"}</b>
          <span>
            {baseName(cwd) || "…"}
            {detail ? ` · ${detail.tools} tools · ${fmtUsd(detail.cost_usd)}` : ""}
            {detail?.errors ? ` · ${detail.errors} errors` : ""}
          </span>
        </div>
        <span className="inline-block rounded-full shrink-0" title={running ? "Working" : "Idle"}
          style={{ width: 9, height: 9, background: running ? "var(--success)" : "var(--text3)" }} />
      </div>

      <div className="bd mb-thread" ref={scroller} onScroll={onScroll}>
        {!detail && <div className="text-[12px] py-6 text-center" style={{ color: "var(--text3)" }}>Loading the conversation…</div>}

        {turns.map((m, i) => <Bubble key={`${m.ts}-${i}`} role={m.role} text={m.text} ts={m.ts} />)}
        {sent && <Bubble role="user" text={sent} />}
        {live && (
          <Bubble role="assistant" text={live.text || "…"} streaming tools={live.tools} error={live.error} />
        )}
        {queued.map((q, i) => <Bubble key={`q${i}`} role="user" text={q} pending />)}
        {stalled && !live?.error && (
          // Silence is ambiguous — a long tool call and a dead socket look
          // identical. Say which one we cannot tell rather than leaving a
          // spinner turning over nothing.
          <div className="text-[11px] px-1" style={{ color: "var(--warning)" }}>
            Nothing for a while. The turn may still be running — the transcript below is live again.
          </div>
        )}
        <div ref={foot} />
      </div>

      {/* Only while you are reading further up: the thread stays where you put
          it, and this says what you would otherwise have been yanked to. */}
      {behind > 0 && (
        <button className="mb-jump" onClick={() => toBottom(true)}>
          ↓ {behind} newer
        </button>
      )}

      <div className="ft" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        {busyElsewhere && (
          <div className="text-[10.5px]" style={{ color: "var(--warning)" }}>
            This agent is running somewhere else. What you send waits until it stops.
          </div>
        )}
        {detail && !cwd ? (
          <div className="text-[11px]" style={{ color: "var(--text3)" }}>
            This session did not record where it ran, so it cannot be resumed from here.
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder={busy ? "Send when it is free…" : "Reply to this agent"}
              rows={1}
              className="flex-1 rounded-xl px-3 py-2.5 resize-none"
              style={{ fontSize: 16, minHeight: 48, maxHeight: 140, color: "var(--text)", background: "color-mix(in srgb, var(--bg2) 80%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}
            />
            {live ? (
              <button onClick={() => abort.current?.abort()}
                className="rounded-xl px-4 text-[14px]"
                style={{ minHeight: 48, color: "var(--error)", background: "color-mix(in srgb, var(--error) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
                Stop
              </button>
            ) : (
              <button onClick={send} disabled={!draft.trim()}
                className="rounded-xl px-4 text-[14px] font-medium"
                style={{ minHeight: 48, opacity: draft.trim() ? 1 : 0.4, color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
                {busy ? "Queue" : "Send"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ role, text, ts, streaming, tools, error, pending }: {
  role: "user" | "assistant"; text: string; ts?: number; streaming?: boolean; tools?: string[]; error?: string | null;
  /** Typed, accepted, not sent yet: waiting for the agent to be free. */
  pending?: boolean;
}) {
  const mine = role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[86%] rounded-2xl px-3.5 py-2.5" style={{
        background: mine ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "color-mix(in srgb, var(--bg2) 70%, transparent)",
        border: `1px ${pending ? "dashed" : "solid"} color-mix(in srgb, var(--border) ${mine ? 45 : 32}%, transparent)`,
        opacity: pending ? 0.66 : 1,
      }}>
        {pending && <div className="text-[9.5px] pb-1" style={{ color: "var(--warning)" }}>Queued</div>}
        {/* Tool runs are named, not expanded: on a phone the useful signal is
            "it is editing files / running commands", not the diff. */}
        {!!tools?.length && (
          <div className="text-[10.5px] pb-1.5 flex flex-col gap-0.5" style={{ color: "var(--text3)" }}>
            {tools.slice(-4).map((t, i) => <span key={i} className="truncate">· {t}</span>)}
          </div>
        )}
        <div className="text-[13.5px] leading-snug whitespace-pre-wrap break-words">{text}</div>
        {streaming && <span className="inline-block ml-0.5 animate-pulse">▍</span>}
        {error && <div className="text-[11px] pt-1" style={{ color: "var(--error)" }}>{error}</div>}
        {ts && <div className="text-[9.5px] pt-1" style={{ color: "var(--text3)" }}>{fmtAgo(ts)}</div>}
      </div>
    </div>
  );
}

/** Start something new: a repo and a first message is the whole form. */
function NewChat({ onCancel, onStarted }: { onCancel: () => void; onStarted: (sessionId: string, cwd: string) => void }) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState(MODELS[0]!.id);
  const [message, setMessage] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    api.gitRepos()
      .then((r) => { setRepos(r.repos); if (r.repos[0]) setCwd(r.repos[0].root); })
      .catch(() => setRepos([]));
  }, []);

  const start = async () => {
    const text = message.trim();
    if (!text || !cwd) return;
    setFailed(null);
    setLive({ text: "", tools: [], error: null });
    try {
      await api.chatStream({ cwd, message: text, model, mode: "default", resumeId: "" }, (o) => {
        // The first frame carries the session id claude assigned. That id is
        // the chat from here on: it is what the list shows and what a reply
        // resumes, on this phone or at the desk.
        if (!started.current && o.type === "system" && typeof o.session_id === "string") {
          started.current = true;
          // Hand the directory over with the id. The session row does not have
          // it yet, and the conversation screen would otherwise announce that
          // this brand new chat cannot be resumed.
          onStarted(o.session_id, cwd);
        }
        setLive((prev) => reduce(prev, o));
      });
    } catch (e) {
      const why = e instanceof ChatStreamError ? e.message : String(e);
      setFailed(why);
      setLive(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 -mt-1">
        <button onClick={onCancel} className="text-[13px] px-2 py-2" style={{ color: "var(--text2)", minHeight: 44 }}>← Chats</button>
        <span className="ml-auto text-[12.5px]">New chat</span>
      </div>

      <label className="text-[10.5px] px-0.5" style={{ color: "var(--text3)" }}>Where it runs</label>
      <select value={cwd} onChange={(e) => setCwd(e.target.value)}
        className="rounded-xl px-3"
        style={{ fontSize: 16, minHeight: 48, color: "var(--text)", background: "color-mix(in srgb, var(--bg2) 80%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
        {!repos.length && <option value="">No repos found</option>}
        {repos.map((r) => <option key={r.root} value={r.root}>{baseName(r.root)}{r.branch ? ` · ${r.branch}` : ""}</option>)}
      </select>

      <label className="text-[10.5px] px-0.5" style={{ color: "var(--text3)" }}>Model</label>
      <div className="flex gap-1.5">
        {MODELS.map((m) => (
          <button key={m.id} onClick={() => setModel(m.id)}
            className="flex-1 rounded-lg text-[12px]"
            style={{
              minHeight: 42,
              color: model === m.id ? "var(--primary-hover)" : "var(--text2)",
              background: model === m.id ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
              border: `1px solid color-mix(in srgb, var(--border) ${model === m.id ? 60 : 30}%, transparent)`,
            }}>
            {m.label}
          </button>
        ))}
      </div>

      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
        placeholder="What should it do?"
        className="rounded-xl px-3 py-2.5 resize-none"
        style={{ fontSize: 16, color: "var(--text)", background: "color-mix(in srgb, var(--bg2) 80%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }} />

      {failed && <div className="text-[11.5px]" style={{ color: "var(--error)" }}>{failed}</div>}

      <button onClick={start} disabled={!message.trim() || !cwd || !!live}
        className="rounded-xl text-[15px] font-medium"
        style={{ minHeight: 52, opacity: message.trim() && cwd && !live ? 1 : 0.45, color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
        {live ? "Starting…" : "Start"}
      </button>

      {live && <Bubble role="assistant" text={live.text || "…"} streaming tools={live.tools} error={live.error} />}
    </div>
  );
}

/** Fold one ndjson frame into what is on screen. */
function reduce(prev: Live | null, o: Record<string, unknown>): Live {
  const cur: Live = prev ?? { text: "", tools: [], error: null };
  const t = o.type;
  if (t === "assistant") {
    const blocks = (((o.message as Record<string, unknown>)?.content) ?? []) as Array<Record<string, unknown>>;
    let text = cur.text;
    const tools = [...cur.tools];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      else if (b.type === "tool_use") {
        const name = String(b.name ?? "tool");
        const target = toolTarget(name, (b.input ?? {}) as Record<string, unknown>);
        tools.push(target ? `${name} ${target}` : name);
      }
    }
    return { ...cur, text, tools };
  }
  if (t === "agx_error") return { ...cur, error: String(o.error ?? "something went wrong") };
  return cur;
}

const baseName = (p: string) => (p ? p.split("/").filter(Boolean).pop() || p : "");
