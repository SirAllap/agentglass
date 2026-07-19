// Multi-chat — drive many Claude Code sessions from the browser at once.
//
// Each chat picks a repo/worktree, a model and a permission mode, then streams
// its reply; every one also shows up in the live fleet. Conversations live in
// a module-level store rather than in this component, so closing the panel
// leaves them running and reopening finds them where they were.
//
// The sidebar is a list rather than a tab strip on purpose: tabs stop being
// usable somewhere around a dozen, and this is meant to hold far more than
// that. It filters, and it says which chats answered while you were elsewhere.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { GitRepoRef } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { Select } from "./Select.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./ChangesModal.tsx";
import {
  listChats, getChat, newChat, closeChat, update, send, stop, subscribe,
  DEFAULT_MODEL, DEFAULT_MODE, type Chat,
} from "../lib/chatStore.ts";

const MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];
// These run through `claude -p`, which has no terminal to prompt from: a tool
// that would raise a permission dialog is refused outright, and there is no
// way to grant it mid-chat. "Ask" therefore does not ask — it declines. The
// labels say so, because a mode that silently denies while claiming to prompt
// is what sends you hunting for a bug that isn't there.
const MODES = [
  { id: "default", label: "Ask (denies un-allowed)" },
  { id: "plan", label: "Plan (no edits)" },
  { id: "acceptEdits", label: "Auto-accept edits" },
  { id: "bypassPermissions", label: "⚡ Bypass (runs all)" },
];
const CWD_KEY = "agentglass.chatCwd";
const ALLOW_KEY = "agentglass.chatAllowedTools";
// A starting point that covers the reading and inspection an assistant reaches
// for constantly, without granting anything that writes or leaves the machine.
const ALLOW_DEFAULT = "Read Glob Grep Bash(git status) Bash(git log:*) Bash(git diff:*) Bash(gh pr view:*)";
const repoName = (p: string) => p.split("/").pop() || p;

const selCls = "text-[10.5px] px-2 py-1 rounded-md outline-none";
const selStyle = { background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text2)" };

/** One row in the chat list. */
function ChatRow({ chat, active, onPick, onClose }: { chat: Chat; active: boolean; onPick: () => void; onClose: () => void }) {
  return (
    <div
      onClick={onPick}
      role="option"
      aria-selected={active}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}
      className="group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer shrink-0"
      style={active
        ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }
        : { border: "1px solid transparent" }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
        background: chat.sending ? "var(--success)" : chat.unread ? "var(--primary)" : "color-mix(in srgb, var(--text4) 50%, transparent)",
      }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px]" style={{ color: active ? "var(--text)" : "var(--text2)" }}>{chat.title}</div>
        <div className="truncate text-[9.5px] t-dim2">{repoName(chat.cwd) || "no repo"}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 text-[13px] leading-none px-1 t-dim2 hover:opacity-70 shrink-0"
        title="close chat"
        aria-label={`close chat: ${chat.title}`}
      >✕</button>
    </div>
  );
}

export function ChatPanel({ open, onClose, focusId }: { open: boolean; onClose: () => void; focusId?: string }) {
  const chats = useSyncExternalStore(subscribe, listChats, listChats);
  const [activeId, setActiveId] = useState("");
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [enabled, setEnabled] = useState(true);
  // The server silently downgrades bypassPermissions unless the operator opted
  // in (AGENTGLASS_CHAT_BYPASS=1) — don't offer a mode that wouldn't stick.
  const [bypassAllowed, setBypassAllowed] = useState(false);
  // Shared by every chat and remembered across launches: the set of tools you
  // trust is a property of how you work, not of one conversation.
  const [allowed, setAllowed] = useState(() => {
    try { return localStorage.getItem(ALLOW_KEY) ?? ALLOW_DEFAULT; } catch { return ALLOW_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem(ALLOW_KEY, allowed); } catch { /* private mode */ } }, [allowed]);
  const [query, setQuery] = useState("");
  const [defaultCwd, setDefaultCwd] = useState<string>(() => { try { return localStorage.getItem(CWD_KEY) || ""; } catch { return ""; } });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stuckBottom = useRef(true);

  const active = getChat(activeId);
  // Read through a ref so the streaming callback always asks about the chat on
  // screen *now*, not the one that was active when the send started.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // Whether the chat is *visible*, not merely selected: the panel stays mounted
  // when closed, so without this a reply that lands while it's shut is treated
  // as read and never flags the row.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      setDefaultCwd((c) => c || repos[0]?.root || "");
    }).catch(() => {});
    api.chatEnabled().then((r) => { setEnabled(r.enabled); setBypassAllowed(!!r.bypass); }).catch(() => {});
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Opening with nothing to show should land on something usable, not an empty
  // frame asking to be clicked.
  // Only seeds a chat when the panel is opened with none — not on every change
  // to the count, which made closing the last chat instantly resurrect it.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) { seeded.current = false; return; }
    if (!seeded.current && !chats.length && defaultCwd) {
      seeded.current = true;
      setActiveId(newChat(defaultCwd).id);
      return;
    }
    if (!getChat(activeId) && chats.length) setActiveId(chats[chats.length - 1].id);
  }, [open, chats, defaultCwd, activeId]);

  // Opened to continue a specific session (from the fleet view): show that tab
  // rather than whichever was last active, or the request looks ignored.
  useEffect(() => { if (focusId && getChat(focusId)) setActiveId(focusId); }, [focusId]);

  useEffect(() => { if (defaultCwd) { try { localStorage.setItem(CWD_KEY, defaultCwd); } catch { /* ignore */ } } }, [defaultCwd]);

  // Clear the unread mark for whatever is on screen.
  useEffect(() => { if (open && active?.unread) update(active.id, (c) => { c.unread = false; }); }, [open, active?.id, active?.unread]);

  // Depends on scalars that actually change. `messages` is mutated in place by
  // the store, so its identity is stable for the life of a chat — depending on
  // it meant this only ever ran on chat switch, and a streaming reply scrolled
  // off the bottom without the view following.
  const lastLen = active?.messages[active.messages.length - 1]?.text.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckBottom.current) el.scrollTop = el.scrollHeight;
  }, [active?.id, active?.messages.length, lastLen]);

  const add = useCallback(() => {
    const cwd = active?.cwd || defaultCwd || repos[0]?.root || "";
    const c = newChat(cwd, active?.model ?? DEFAULT_MODEL, active?.mode ?? DEFAULT_MODE);
    setActiveId(c.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [active, defaultCwd, repos]);

  const drop = useCallback((id: string) => {
    const rest = listChats().filter((c) => c.id !== id);
    closeChat(id);
    if (activeIdRef.current === id) setActiveId(rest[rest.length - 1]?.id ?? "");
  }, []);

  const submit = () => {
    if (!active) return;
    const text = active.draft;
    send(active.id, text, () => openRef.current && activeIdRef.current === active.id, allowed.split(/\s+/).filter(Boolean));
  };
  const [hint, setHint] = useState("");
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // A focused textarea can swallow Escape before it reaches the global
    // handler, stranding the panel open. Close it here instead.
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    // send() returns early in both these cases; without saying so, Enter just
    // looks broken and the draft sits there.
    if (!active?.cwd) { setHint("pick a repo first"); return; }
    if (active.sending) { setHint("still replying — press stop to interrupt"); return; }
    setHint("");
    submit();
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => (c.title + " " + repoName(c.cwd)).toLowerCase().includes(q));
  }, [chats, query]);

  const repoOptions = useMemo(
    () => repos.map((r) => ({ value: r.root, label: repoName(r.root), hint: r.branch })),
    [repos]
  );

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[min(1400px,96vw)] h-[94vh] rounded-2xl flex pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
                <style>{SCROLLBAR_CSS}</style>

                {/* ---- sidebar: every open chat ---- */}
                <div className="w-[236px] shrink-0 flex flex-col border-r" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", background: "color-mix(in srgb, var(--bg) 40%, transparent)" }}>
                  <div className="flex items-center gap-2 px-3 py-3 shrink-0">
                    <span className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>💬 Chats</span>
                    <span className="text-[10px] t-dim2 tabular-nums">{chats.length}</span>
                    <button onClick={add} className="ml-auto text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }} title="new chat">+ new</button>
                  </div>
                  {chats.length > 6 && (
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter chats…"
                      className="mx-2.5 mb-2 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                      style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text)" }} />
                  )}
                  <div role="listbox" aria-label="open chats" className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5">
                    {shown.map((c) => (
                      <ChatRow key={c.id} chat={c} active={c.id === activeId} onPick={() => setActiveId(c.id)} onClose={() => drop(c.id)} />
                    ))}
                    {!shown.length && <div className="px-2.5 py-3 text-[11px] t-dim2">no chats match</div>}
                  </div>
                </div>

                {/* ---- the active conversation ---- */}
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    {active ? (
                      <>
                        <Select value={active.cwd} onChange={(v) => { update(active.id, (c) => { c.cwd = v; }); setDefaultCwd(v); }}
                          className={selCls} style={selStyle} options={repoOptions} placeholder="pick a repo" />
                        <Select value={active.model} onChange={(v) => update(active.id, (c) => { c.model = v; })}
                          className={selCls} style={selStyle} options={MODELS.map((m) => ({ value: m.id, label: m.label }))} />
                        <Select value={active.mode} onChange={(v) => update(active.id, (c) => { c.mode = v; })}
                          className={selCls} style={selStyle} title="Permission mode for tool use"
                          options={MODES.filter((m) => bypassAllowed || m.id !== "bypassPermissions").map((m) => ({ value: m.id, label: m.label }))} />
                        {active.mode !== "bypassPermissions" && (
                          <input
                            value={allowed}
                            onChange={(e) => setAllowed(e.target.value)}
                            placeholder="allowed tools…"
                            title={"Tools that may run without asking — space-separated.\n\nExamples: Read  Edit  Bash(git status)  Bash(gh pr view:*)\n\nWithout this, `claude -p` refuses anything that would normally prompt, because there is no terminal to prompt from."}
                            className="text-[10px] px-2 py-1 rounded-md outline-none min-w-0 flex-1 max-w-[280px]"
                            style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}
                          />
                        )}
                        {active.sessionId && <span className="text-[9.5px] t-dim2 tabular-nums" title="resuming this session">↻ {active.sessionId.slice(0, 8)}</span>}
                      </>
                    ) : <span className="text-[12px] t-dim2">no chat selected</span>}
                    <button onClick={onClose} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                  </div>

                  {/* Bottom-anchored: a short conversation sits above the input
                      where a chat belongs, instead of stranding it at the top of
                      a tall empty panel. */}
                  <div ref={scrollRef}
                    onScroll={(e) => { const el = e.currentTarget; stuckBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
                    className="agx-scroll flex-1 min-h-0 overflow-y-auto px-5 py-4">
                    <div className="min-h-full flex flex-col justify-end gap-3">
                      {active && !active.messages.length && (
                        <div className="grid place-items-center text-center t-dim2 text-[12px] py-10">
                          {enabled
                            ? <div>Chat with a Claude session in <b style={{ color: "var(--text2)" }}>{repoName(active.cwd) || "a repo"}</b>.<br />It runs there, appears in your fleet, and follow-ups keep the context.</div>
                            : <div>No local <code>claude</code> CLI found — install Claude Code to chat.</div>}
                        </div>
                      )}
                      {active?.messages.map((m, i) => (
                        <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className="max-w-[86%] rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words"
                            style={{ ...CODE_FONT_STYLE, fontFamily: undefined, background: m.role === "user" ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--text)" }}>
                            {m.tools.length > 0 && (
                              <div className="flex flex-wrap gap-1 mb-1.5">
                                {m.tools.map((t, j) => <span key={j} className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ ...CODE_FONT_STYLE, color: "var(--info)", background: "color-mix(in srgb, var(--info) 12%, transparent)" }}>⚙ {t}</span>)}
                              </div>
                            )}
                            {m.text || (m.streaming ? <span className="t-dim2">▍</span> : "")}
                            {m.streaming && m.text && <span className="t-dim2">▍</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="shrink-0 border-t p-3" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <div className="flex items-end gap-2">
                      <textarea ref={inputRef} value={active?.draft ?? ""} disabled={!enabled || !active} rows={2}
                        onChange={(e) => active && update(active.id, (c) => { c.draft = e.target.value; })}
                        onKeyDown={onKey}
                        placeholder={!enabled ? "chat unavailable" : active?.sessionId ? "reply… (Enter to send, Shift+Enter newline)" : "message a new session… (Enter to send)"}
                        className="agx-scroll flex-1 px-3 py-2 rounded-lg text-[12px] outline-none resize-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                      {active?.sending
                        ? <button onClick={() => stop(active.id)} className="shrink-0 px-3.5 py-2 rounded-lg text-[11.5px] font-semibold" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>■ stop</button>
                        : <button onClick={submit} disabled={!active?.draft.trim() || !active?.cwd || !enabled} className="shrink-0 px-4 py-2 rounded-lg text-[11.5px] font-semibold" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", opacity: (!active?.draft.trim() || !active?.cwd) ? 0.45 : 1 }}>send ↵</button>}
                    </div>
                    <div className="mt-1.5 text-[9.5px] t-dim2">
                      {hint
                        ? <span style={{ color: "var(--warning)" }}>{hint}</span>
                        : <>runs claude in {active ? repoName(active.cwd) || "the repo" : "the repo"} · {MODES.find((x) => x.id === active?.mode)?.label} · tools appear as ⚙ chips</>}
                      {active?.mode === "bypassPermissions" && <span style={{ color: "var(--warning)" }}> · ⚡ runs tools unattended</span>}
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
