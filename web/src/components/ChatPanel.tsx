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
import type { GitRepoRef, SessionRollup } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { Select } from "./Select.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./ChangesModal.tsx";
import { fmtAgo, fmtUsd, modelLabelOf, modelColor, providerOf } from "../lib/format.ts";
import { sessionIsLive } from "../lib/derive.ts";
import {
  listChats, getChat, newChat, closeChat, update, send, stop, subscribe, chatResuming,
  DEFAULT_MODEL, DEFAULT_MODE, addAttachments, dropAttachment, renameChat, type Chat,
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const commit = () => { renameChat(chat.id, draft); setEditing(false); };
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
        {/* Double-click to rename. The derived title is whatever you happened to
            type first, which is rarely what the conversation turns out to be
            about — and with several chats open that is the only thing telling
            them apart. */}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              // Escape restores the old name rather than saving a half-edit.
              if (e.key === "Escape") { e.preventDefault(); setDraft(chat.title); setEditing(false); }
            }}
            className="w-full px-1 py-0.5 rounded text-[11.5px] outline-none"
            style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }}
          />
        ) : (
          <div className="truncate text-[11.5px]" title="double-click to rename"
            onDoubleClick={(e) => { e.stopPropagation(); setDraft(chat.title); setEditing(true); }}
            style={{ color: active ? "var(--text)" : "var(--text2)" }}>{chat.title}</div>
        )}
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

/** Why a session can't be picked up, or `null` if it can.
 *
 *  Three different refusals with three different remedies — "wait for it to
 *  finish", "nothing we can do", "it's already open over there" — so the row
 *  has to say which one applies rather than just going grey. */
type Blocked = "live" | "no-dir" | null;
const blockedReason = (s: SessionRollup): Blocked =>
  sessionIsLive(s) ? "live" : s.project_path ? null : "no-dir";

/** One resumable session in the picker. */
function ResumeRow({ s, openChatId, onPick }: { s: SessionRollup; openChatId?: string; onPick: () => void }) {
  const why = blockedReason(s);
  const model = modelLabelOf(s.model_name);
  const label = s.project_path ? repoName(s.project_path) : s.source_app;
  const note = why === "live"
    ? "This session is still running. A claude session has a single owner — a second one writing to the same transcript would corrupt its history. Resume it once it stops."
    : why === "no-dir"
    ? "No directory was recorded for this session, so there's nowhere to run the resumed conversation."
    : openChatId
    ? "Already open in this panel — picking it focuses that tab."
    : `Continue this conversation in ${s.project_path}`;

  return (
    <button
      onClick={onPick}
      disabled={!!why}
      role="option"
      aria-selected={false}
      title={note}
      className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 ${why ? "cursor-default opacity-55" : "cursor-pointer hover:bg-white/5"}`}
      style={{ border: "1px solid transparent" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="truncate text-[11.5px]" style={{ color: "var(--text2)" }}>{label}</span>
          <span className="text-[9.5px] tabular-nums t-dim2 shrink-0">{s.session_id.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[9.5px] t-dim2">
          <span style={{ color: modelColor(model) }}>{model}</span>
          <span>· {fmtAgo(s.last_seen)} ago</span>
          <span>· {fmtUsd(s.cost_usd)}</span>
        </div>
      </div>
      {why === "live"
        ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--success)" }}>● running</span>
        : why === "no-dir"
        ? <span className="text-[9.5px] shrink-0 t-dim2">no dir</span>
        : openChatId
        ? <span className="text-[9.5px] shrink-0 t-dim2">open ↗</span>
        : <span className="text-[10px] shrink-0" style={{ color: "var(--primary-hover)" }}>↩</span>}
    </button>
  );
}

/**
 * Pick up a claude session that already exists.
 *
 * The panel could always *start* conversations, but the ones worth continuing
 * are usually the ones started somewhere else — in a terminal, or by an earlier
 * run — and until now there was no way to reach them from here. This lists what
 * the fleet has seen, most recent first, and hands the chosen session to the
 * store to resume.
 *
 * Running sessions are listed rather than hidden: their absence would read as
 * a bug ("I just used that one, where is it?"), where a greyed row that says
 * "running" answers the question.
 */
function ResumePicker({ onPick, onClose }: { onPick: (s: SessionRollup) => void; onClose: () => void }) {
  const [rows, setRows] = useState<SessionRollup[] | null>(null);
  const [q, setQ] = useState("");

  // Fetched once per opening rather than polled: this is a menu the user is
  // actively reading, and rows shuffling under the cursor would be worse than
  // a list a few seconds stale.
  useEffect(() => { api.sessions(60).then(setRows).catch(() => setRows([])); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture, and stop the event here: the chat textarea and the panel both
      // treat Escape as "close me", and one keypress should only close the menu.
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const shown = useMemo(() => {
    // `claude --resume` only knows about claude's own transcripts, so a session
    // recorded from another vendor's telemetry is not something we could pick
    // up. Unknown models stay in — early claude rows have no model recorded.
    const claudeish = (rows ?? []).filter((s) => {
      const p = providerOf(s.model_name);
      return p === "Anthropic" || p === "unknown";
    });
    const needle = q.trim().toLowerCase();
    if (!needle) return claudeish;
    return claudeish.filter((s) =>
      (`${s.project_path ?? ""} ${s.source_app} ${s.session_id}`).toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <>
      <div className="absolute inset-0" style={{ zIndex: 20 }} onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        className="absolute left-2 top-12 w-[360px] max-w-[calc(100%-1rem)] rounded-xl p-1.5 flex flex-col"
        style={{
          zIndex: 21,
          maxHeight: "min(60vh, 460px)",
          background: "color-mix(in srgb, var(--bg2) 97%, black)",
          border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
          boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
        }}
      >
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter sessions…"
          className="mx-1 mt-0.5 mb-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text)" }} />
        <div role="listbox" aria-label="sessions to resume" className="agx-scroll flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
          {rows === null && <div className="px-2.5 py-3 text-[11px] t-dim2">loading sessions…</div>}
          {rows !== null && !shown.length && <div className="px-2.5 py-3 text-[11px] t-dim2">no sessions to resume</div>}
          {shown.map((s) => (
            <ResumeRow key={s.session_id} s={s} openChatId={chatResuming(s.session_id)?.id} onPick={() => onPick(s)} />
          ))}
        </div>
        <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] t-dim2 shrink-0">
          resuming keeps claude's full context · running sessions can't be resumed
        </div>
      </motion.div>
    </>
  );
}

// A paperclip, not a plus: this attaches an existing file, it doesn't create
// anything. Drawn rather than an emoji so it renders identically in WebKitGTK
// and matches the stroke weight of the header's icons.
function ClipIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.9-8.9a3.3 3.3 0 0 1 4.7 4.7l-8.9 8.9a1.7 1.7 0 0 1-2.3-2.3l8.2-8.2" />
    </svg>
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
  const [resumeOpen, setResumeOpen] = useState(false);
  const [defaultCwd, setDefaultCwd] = useState<string>(() => { try { return localStorage.getItem(CWD_KEY) || ""; } catch { return ""; } });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Skills are already usable — `claude -p` keeps slash commands on unless
  // --disable-slash-commands is passed, which we never do. What was missing is
  // knowing they exist: you had to remember the exact name with no way to look
  // it up without leaving the chat.
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  useEffect(() => {
    if (!open || skills.length) return;
    api.skills().then((r) => setSkills(r.skills.map((k) => ({ name: k.name, description: k.when_to_use || k.description })))).catch(() => {});
  }, [open, skills.length]);

  const stuckBottom = useRef(true);

  const active = getChat(activeId);

  // Only while the draft is a bare `/word` on the first line: past the first
  // space it is prose, and a menu stealing Enter there would be maddening.
  const slashQuery = (() => {
    const d = active?.draft ?? "";
    const m = /^\/([A-Za-z0-9:_-]*)$/.exec(d);
    return m ? m[1].toLowerCase() : null;
  })();
  const slashMatches = slashQuery === null ? [] :
    skills.filter((k) => k.name.toLowerCase().includes(slashQuery)).slice(0, 8);
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);
  const pickSkill = (name: string) => {
    if (!active) return;
    update(active.id, (c) => { c.draft = `/${name} `; });
    inputRef.current?.focus();
  };
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
    if (!open) { seeded.current = false; setResumeOpen(false); return; }
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

  // Adopt an existing claude session. Focusing an already-open tab rather than
  // opening a second one is not a nicety: two chats resuming one session id
  // would both write to that transcript, which is the same corruption the live
  // check exists to prevent.
  const resume = useCallback((s: SessionRollup) => {
    setResumeOpen(false);
    if (!s.project_path || sessionIsLive(s)) return;
    const chat = chatResuming(s.session_id)
      ?? newChat(s.project_path, s.model_name || undefined, active?.mode ?? DEFAULT_MODE, {
        sessionId: s.session_id,
        title: `${s.source_app}:${s.session_id.slice(0, 8)}`,
      });
    setActiveId(chat.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [active]);

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
  // A turn is sendable when there is text or at least one attachment.
  const hasTurn = !!(active?.draft.trim() || active?.attachments.length);

  // Screenshots arrive as clipboard *files*, not text, so the paste is only
  // intercepted when there is at least one image among them — a normal text
  // paste has to fall through to the textarea untouched.
  //
  // Both `files` and `items` are read because the two engines this runs on
  // disagree. Chromium populates `clipboardData.files` for a pasted image;
  // WebKitGTK — which is what Tauri uses on Linux, i.e. the desktop app —
  // delivers it through `items` and leaves `files` empty. Reading only `files`
  // worked in a browser and silently did nothing in the app.
  const imagesFrom = (dt: DataTransfer): File[] => {
    const out = new Map<string, File>();
    for (const f of Array.from(dt.files)) {
      if (f.type.startsWith("image/")) out.set(`${f.name}:${f.size}`, f);
    }
    for (const it of Array.from(dt.items)) {
      if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
      const f = it.getAsFile();
      // Same image can appear in both collections; key by name+size so it is
      // attached once rather than twice.
      if (f) out.set(`${f.name}:${f.size}`, f);
    }
    return [...out.values()];
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!active) return;
    const files = imagesFrom(e.clipboardData);
    if (!files.length) {
      // A paste that carried a file which wasn't an image would otherwise look
      // identical to the feature being broken.
      if (Array.from(e.clipboardData.items).some((i) => i.kind === "file")) {
        e.preventDefault();
        setHint("that file isn't an image or a text file");
      }
      return;
    }
    e.preventDefault();
    setHint(await addAttachments(active.id, files));
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The skill menu owns the arrows, Tab and Enter while it is showing, or
    // Enter would send `/rev` as a message instead of completing it.
    if (slashMatches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault(); pickSkill(slashMatches[slashIdx].name); return;
      }
    }
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
                className="relative w-[95vw] h-[95vh] rounded-2xl flex pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
                <style>{SCROLLBAR_CSS}</style>

                {/* Anchored inside the modal rather than portalled like Select:
                    this panel already sits at a very high z-index, and a
                    portalled menu would render underneath it. */}
                <AnimatePresence>
                  {resumeOpen && <ResumePicker onPick={resume} onClose={() => setResumeOpen(false)} />}
                </AnimatePresence>

                {/* ---- sidebar: every open chat ---- */}
                <div className="w-[236px] shrink-0 flex flex-col border-r" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", background: "color-mix(in srgb, var(--bg) 40%, transparent)" }}>
                  <div className="flex items-center gap-1.5 px-3 py-3 shrink-0">
                    <span className="text-[13px] font-semibold shrink-0" style={{ color: "var(--text)" }}>💬 Chats</span>
                    <span className="text-[10px] t-dim2 tabular-nums shrink-0">{chats.length}</span>
                    <button onClick={() => setResumeOpen((v) => !v)} aria-expanded={resumeOpen} aria-haspopup="listbox"
                      className="ml-auto text-[11px] px-1.5 py-1 rounded-lg shrink-0" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}
                      title="continue a session that already exists — e.g. one you started in a terminal">↩ resume</button>
                    <button onClick={add} className="text-[11px] px-1.5 py-1 rounded-lg shrink-0" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }} title="new chat">+ new</button>
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
                        <div key={i}>
                          {/* The seam between what was said before this panel
                              adopted the session and what is being said in it
                              now — without it, replayed history reads as though
                              you had typed it here. */}
                          {m.historical && !active.messages[i + 1]?.historical && (
                            <div className="flex items-center gap-2 my-3 text-[9.5px] uppercase tracking-wider t-dim2">
                              <span className="flex-1 h-px" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
                              <span>resumed here</span>
                              <span className="flex-1 h-px" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
                            </div>
                          )}
                          <div className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className="max-w-[86%] min-w-0 rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed break-words"
                            style={{ ...CODE_FONT_STYLE, fontFamily: undefined, opacity: m.historical ? 0.72 : 1, background: m.role === "user" ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--text)" }}>
                            {m.tools.length > 0 && (
                              <div className="flex flex-wrap gap-1 mb-1.5">
                                {m.tools.map((t, j) => <span key={j} className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ ...CODE_FONT_STYLE, color: "var(--info)", background: "color-mix(in srgb, var(--info) 12%, transparent)" }}>⚙ {t}</span>)}
                              </div>
                            )}
                            {!!m.images?.length && (
                              <div className="flex flex-wrap gap-1.5 mb-1.5">
                                {m.images.map((img, j) => (
                                  <img key={j} src={`data:${img.mediaType};base64,${img.data}`} alt="attached image"
                                    className="block max-h-40 max-w-full rounded-lg"
                                    style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }} />
                                ))}
                              </div>
                            )}
                            {m.text ? <Markdown text={m.text} /> : (m.streaming ? <span className="t-dim2">▍</span> : "")}
                            {m.streaming && m.text && <span className="t-dim2">▍</span>}
                          </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="shrink-0 border-t p-3" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    {!!active?.attachments.length && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {active.attachments.map((a) => (
                          <div key={a.id} className="relative group rounded-lg overflow-hidden shrink-0"
                            style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                            title={`${a.name} · ${(a.bytes / 1024).toFixed(0)}KB`}>
                            <img src={a.url} alt={a.name} className="block h-14 w-14 object-cover" />
                            <button onClick={() => dropAttachment(active.id, a.id)} aria-label={`remove ${a.name}`}
                              className="absolute top-0.5 right-0.5 w-4 h-4 grid place-items-center rounded text-[10px] leading-none"
                              style={{ color: "var(--text)", background: "rgba(0,0,0,0.65)" }}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {slashMatches.length > 0 && (
                      // Above the input, not below: the composer is pinned to
                      // the panel's bottom edge, so a menu underneath would be
                      // off-screen.
                      <div className="mb-2 rounded-lg overflow-hidden"
                        style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                        {slashMatches.map((k, i) => (
                          <div key={k.name} onMouseDown={(ev) => { ev.preventDefault(); pickSkill(k.name); }}
                            onMouseEnter={() => setSlashIdx(i)}
                            className="px-2.5 py-1.5 cursor-pointer flex items-baseline gap-2"
                            style={{ background: i === slashIdx ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent" }}>
                            <span className="text-[11.5px] shrink-0" style={{ color: "var(--primary-hover)" }}>/{k.name}</span>
                            <span className="text-[10px] t-dim2 truncate">{k.description}</span>
                          </div>
                        ))}
                        <div className="px-2.5 py-1 text-[9.5px] t-dim2" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                          ↑↓ move · Tab or Enter to pick · keep typing to filter
                        </div>
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      {/* Clipboard behaviour differs per engine and some
                          screenshot tools only put a file path on it, so the
                          picker is the path that always works — these tools
                          save a file as well as copying it. */}
                      <input ref={fileRef} type="file" multiple hidden
                        onChange={async (ev) => {
                          const picked = Array.from(ev.target.files ?? []);
                          ev.target.value = ""; // re-picking the same file must still fire
                          if (active && picked.length) setHint(await addAttachments(active.id, picked));
                        }} />
                      <button onClick={() => fileRef.current?.click()} disabled={!enabled || !active}
                        title="Attach a file — images are sent as images, text files are quoted into the message"
                        aria-label="Attach a file"
                        className="shrink-0 grid place-items-center rounded-lg px-3 self-stretch"
                        style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text3)" }}>
                        <ClipIcon />
                      </button>
                      <textarea ref={inputRef} value={active?.draft ?? ""} disabled={!enabled || !active} rows={2}
                        onChange={(e) => active && update(active.id, (c) => { c.draft = e.target.value; })}
                        onKeyDown={onKey}
                        onPaste={onPaste}
                        placeholder={!enabled ? "chat unavailable" : active?.sessionId ? "reply… (Enter to send, Shift+Enter newline)" : "message a new session… (Enter to send)"}
                        className="agx-scroll flex-1 px-3 py-2 rounded-lg text-[12px] outline-none resize-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                      {active?.sending
                        ? <button onClick={() => stop(active.id)} className="shrink-0 px-3.5 rounded-lg text-[11.5px] font-semibold self-stretch" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>■ stop</button>
                        : <button onClick={submit} disabled={!hasTurn || !active?.cwd || !enabled} className="shrink-0 px-4 rounded-lg text-[11.5px] font-semibold self-stretch" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", opacity: (!hasTurn || !active?.cwd) ? 0.45 : 1 }}>send ↵</button>}
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
