import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ChatStreamError } from "../lib/api.ts";
import { toolTarget } from "../lib/chatStore.ts";
import { fmtUsd, fmtAgo, sessionTitle, modelLabelOf } from "../lib/format.ts";
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

const MODELS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

/** A turn being streamed right now, before the transcript catches up. */
type Live = { text: string; tools: string[]; error: string | null };

export function MobileChats({ sessions, onRefresh }: { sessions: SessionRollup[]; onRefresh: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  if (composing) return <NewChat onCancel={() => setComposing(false)} onStarted={(id) => { setComposing(false); setOpenId(id); onRefresh(); }} />;
  if (openId) return <Conversation id={openId} onBack={() => { setOpenId(null); onRefresh(); }} />;

  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => setComposing(true)}
        className="rounded-xl text-[15px] font-medium"
        style={{ minHeight: 52, color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
        + New chat
      </button>

      {!sessions.length && (
        <div className="rounded-2xl px-5 py-12 text-center" style={{ background: "color-mix(in srgb, var(--bg2) 45%, transparent)", border: "1px dashed color-mix(in srgb, var(--border) 45%, transparent)" }}>
          <div className="text-[14px]">No agents yet</div>
          <div className="text-[12px] mt-1.5" style={{ color: "var(--text2)" }}>Start one above and it keeps running on your machine.</div>
        </div>
      )}

      {sessions.map((s) => {
        const running = !s.ended_at && Date.now() - s.last_seen < 120_000;
        return (
          <button key={s.session_id} onClick={() => setOpenId(s.session_id)}
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

/** One session: what it has done, and a box to answer it. */
function Conversation({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api.session(id).then(setDetail).catch(() => { /* keep what is on screen */ });
  }, [id]);

  useEffect(() => {
    load();
    // While a turn of ours is streaming the transcript is behind by a scan, so
    // polling then would show a stale copy of what is already on screen.
    const t = setInterval(() => { if (!live) load(); }, 5000);
    return () => clearInterval(t);
  }, [load, live]);

  useEffect(() => { foot.current?.scrollIntoView({ block: "end" }); }, [detail?.conversation.length, live?.text, sent]);

  const cwd = detail?.cwd_path || detail?.project_path || "";
  const running = !!detail && !detail.ended_at && Date.now() - detail.last_seen < 120_000;

  const send = async () => {
    const message = draft.trim();
    if (!message || !cwd) return;
    setDraft("");
    setSent(message);
    setLive({ text: "", tools: [], error: null });
    const ac = new AbortController();
    abort.current = ac;
    try {
      await api.chatStream(
        { cwd, message, model: detail?.model_name && MODELS.some((m) => detail.model_name!.includes(m.id.split("-")[1]!)) ? MODELS[0]!.id : MODELS[0]!.id, mode: "default", resumeId: id },
        (o) => setLive((prev) => reduce(prev, o)),
        ac.signal
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        const why = e instanceof ChatStreamError ? e.message : String(e);
        setLive((p) => ({ text: p?.text ?? "", tools: p?.tools ?? [], error: why }));
      }
    } finally {
      abort.current = null;
      // Let the transcript take over: it is the same turn, written by the
      // scanner, and keeping our copy as well would show it twice.
      setTimeout(() => { setLive(null); setSent(null); load(); }, 1200);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-11 z-10 flex items-center gap-2 -mx-4 px-4 py-1.5"
        style={{ background: "var(--bg)", borderBottom: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
        <button onClick={onBack} className="text-[13px] px-2 py-2" style={{ color: "var(--text2)", minHeight: 44 }}>← Chats</button>
        <div className="min-w-0 flex-1 text-right">
          <div className="text-[12.5px] truncate">{detail ? sessionTitle(detail) : "…"}</div>
          <div className="text-[10.5px] truncate" style={{ color: "var(--text3)" }}>{baseName(cwd)}</div>
        </div>
        <span className="inline-block rounded-full shrink-0" style={{ width: 8, height: 8, background: running ? "var(--success)" : "var(--text3)" }} />
      </div>

      {detail && (
        <div className="flex items-center gap-x-3 text-[10.5px] tabular-nums px-0.5" style={{ color: "var(--text3)" }}>
          <span>{detail.tools} tools</span>
          {!!detail.errors && <span style={{ color: "var(--error)" }}>{detail.errors} errors</span>}
          <span>{fmtUsd(detail.cost_usd)}</span>
          {!!detail.changes.length && <span>{detail.changes.length} files touched</span>}
        </div>
      )}

      <div className="flex flex-col gap-2.5 pb-2">
        {detail?.conversation.slice(-40).map((m, i) => <Bubble key={`${m.ts}-${i}`} role={m.role} text={m.text} ts={m.ts} />)}
        {sent && <Bubble role="user" text={sent} />}
        {live && (
          <Bubble role="assistant" text={live.text || "…"} streaming tools={live.tools} error={live.error} />
        )}
        <div ref={foot} />
      </div>

      {/* Sticky, thumb-height, 16px type so iOS does not zoom the page when it
          takes focus. */}
      {/* Sits directly on top of the tab bar rather than under it: the nav is
          fixed, so a composer at bottom-0 would be hidden behind it exactly
          when the keyboard is open and it matters most. */}
      <div className="sticky -mx-4 px-4 pt-2 pb-2 z-10"
        style={{ bottom: "calc(56px + env(safe-area-inset-bottom))", background: "var(--bg)", borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
        {!cwd ? (
          <div className="text-[11px] px-1 pb-2" style={{ color: "var(--text3)" }}>
            This session did not record where it ran, so it cannot be resumed from here.
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder={live ? "Working…" : "Reply to this agent"}
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
                Send
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ role, text, ts, streaming, tools, error }: {
  role: "user" | "assistant"; text: string; ts?: number; streaming?: boolean; tools?: string[]; error?: string | null;
}) {
  const mine = role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[86%] rounded-2xl px-3.5 py-2.5" style={{
        background: mine ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "color-mix(in srgb, var(--bg2) 70%, transparent)",
        border: `1px solid color-mix(in srgb, var(--border) ${mine ? 45 : 32}%, transparent)`,
      }}>
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
function NewChat({ onCancel, onStarted }: { onCancel: () => void; onStarted: (sessionId: string) => void }) {
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
          onStarted(o.session_id);
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
