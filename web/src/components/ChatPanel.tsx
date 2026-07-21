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
import { api } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { buildRows } from "../lib/toolTree.ts";
import { fmtTime } from "../lib/format.ts";
import { Select } from "./Select.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./ChangesModal.tsx";
import { fmtAgo, fmtUsd, fmtTokens, modelLabelOf, modelColor, providerOf } from "../lib/format.ts";
import { sessionIsLive } from "../lib/derive.ts";
import { ctxLimitOf } from "../lib/contextWindow.ts";
import { worktreeTag, sessionWorktree, sessionCwd } from "../lib/worktree.ts";
import { useStuckBottom } from "../lib/useStuckBottom.ts";
import {
  listChats, getChat, newChat, closeChat, update, send, stop, enqueue, unqueue, subscribe, chatResuming,
  DEFAULT_MODEL, DEFAULT_MODE, addAttachments, dropAttachment, renameChat, clearAttention, type Chat,
  restoredActiveId, setActiveChatId,
} from "../lib/chatStore.ts";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";

// Still hand-maintained, and still drifts every release — the runtime-sourced
// list is its own job. The 1M entry is here because it is what this fix buys:
// the suffix now survives the server, so the window is actually selectable.
const MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-8[1m]", label: "Opus 4.8 · 1M" },
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
/**
 * The model's reasoning, folded away.
 *
 * It arrives on the stream and was being discarded, which made a turn that
 * reasoned for two minutes and then answered in one line look like a model with
 * nothing to say. Collapsed by default and deliberately quiet — this is the
 * working-out, not the answer, and it is usually several times longer.
 *
 * Auto-opens only while it's the only thing happening: watching it stream is the
 * difference between "thinking" and "frozen". It folds itself the moment real
 * output starts.
 */
function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [openedByHand, setOpenedByHand] = useState<boolean | null>(null);
  const open = openedByHand ?? streaming;
  const lines = text.trim().split("\n");
  return (
    <div className="mb-1.5 rounded-md overflow-hidden" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
      <button onClick={() => setOpenedByHand(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:opacity-80">
        <span className="text-[8px] t-dim2 transition-transform" style={{ transform: open ? "none" : "rotate(-90deg)" }}>▼</span>
        <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>thinking</span>
        {streaming && <span className="text-[9px]" style={{ color: "var(--info)" }}>·</span>}
        {/* A length cue, so a fold is an informed choice rather than a mystery. */}
        {!open && <span className="text-[9px] t-dim2 ml-auto tabular-nums">{lines.length} line{lines.length === 1 ? "" : "s"}</span>}
      </button>
      {open && (
        <div className="px-2.5 pb-2 pt-0.5 text-[11px] leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: "var(--text3)", fontStyle: "italic", maxHeight: 260, overflowY: "auto" }}>
          {text.trim()}
        </div>
      )}
    </div>
  );
}

/** What a chat's context is measured against: the model the CLI said it ran,
 *  falling back to the one we asked for until the first turn reports back. */
function chatLimit(chat: Chat, observed: number): number {
  return ctxLimitOf(chat.resolvedModel ?? chat.model, observed);
}

/**
 * What this chat has spent, and how close it is to a compaction.
 *
 * Every number here was already arriving on the stream and being thrown away.
 * Context is the one that changes behaviour: at 90% the next turn gets
 * compacted and the model quietly loses the earlier conversation, and knowing
 * that *before* it happens is the difference between finishing a thought and
 * starting again.
 */
function Inspector({ chat }: { chat: Chat }) {
  const u = chat.usage;
  if (!u) return null;
  const limit = chatLimit(chat, u.contextTokens);
  const pct = (u.contextTokens / limit) * 100;
  // Amber is "start thinking about wrapping up"; red is "the next turn may compact".
  const tone = pct >= 90 ? "var(--error)" : pct >= 70 ? "var(--warning)" : "var(--primary)";
  const Row = ({ k, v, c }: { k: string; v: string; c?: string }) => (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="t-dim2">{k}</span>
      <span className="ml-auto tabular-nums" style={{ color: c ?? "var(--text2)" }}>{v}</span>
    </div>
  );
  return (
    <div className="shrink-0 px-3 py-2 border-t flex flex-col gap-1.5"
      style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <div className="flex items-baseline gap-2">
        <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>context</span>
        <span className="text-[10px] tabular-nums ml-auto" style={{ color: tone }}>{pct.toFixed(0)}%</span>
        <span className="text-[9px] t-dim2 tabular-nums">{fmtTokens(u.contextTokens)} / {fmtTokens(limit)}</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(1, pct)}%`, background: tone }} />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-0.5">
        <Row k="in" v={fmtTokens(u.input)} />
        <Row k="out" v={fmtTokens(u.output)} />
        {/* Cache read is the cheap part and usually the biggest — worth its own
            line so a large total doesn't read as a large bill. */}
        <Row k="cache read" v={fmtTokens(u.cacheRead)} c="var(--success)" />
        <Row k="cache write" v={fmtTokens(u.cacheWrite)} c="var(--warning)" />
      </div>
      {u.costUsd > 0 && (
        <div className="flex items-baseline gap-2 pt-1 mt-0.5 border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 20%, transparent)" }}>
          <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>cost</span>
          <span className="ml-auto text-[11px] tabular-nums font-medium" style={{ color: "var(--success)" }}>{fmtUsd(u.costUsd)}</span>
        </div>
      )}
    </div>
  );
}

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
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${chat.sending ? "animate-pulse" : ""}`} style={{
        background: chat.sending ? "var(--success)"
          : chat.attention === "blocked" ? "var(--warning)"
          : chat.attention === "done" ? "var(--primary)"
          : "color-mix(in srgb, var(--text4) 50%, transparent)",
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
        {/* The dot carries the state as colour; this says which one, because
            "finished" and "stuck, needs you" are the same glance otherwise and
            they want opposite reactions from you. */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[9.5px] t-dim2">{repoName(chat.cwd) || "no repo"}</span>
          {chat.sending
            ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--success)" }}>· running</span>
            : chat.attention === "blocked"
            ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--warning)" }}>· needs you</span>
            : chat.attention === "done"
            ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--primary)" }}>· done</span>
            : null}
          {/* How full this chat's context is, per row. With several open it's
              the number that decides which one you go back to first — the one
              at 88% is about to lose its own history to a compaction. */}
          {chat.usage && chat.usage.contextTokens > 0 && (() => {
            const pct = (chat.usage.contextTokens / chatLimit(chat, chat.usage.contextTokens)) * 100;
            if (pct < 1) return null;
            return (
              <span className="ml-auto shrink-0 text-[9px] tabular-nums" title={`${fmtTokens(chat.usage.contextTokens)} of context used`}
                style={{ color: pct >= 90 ? "var(--error)" : pct >= 70 ? "var(--warning)" : "var(--text3)" }}>
                {pct.toFixed(0)}%
              </span>
            );
          })()}
        </div>
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
  sessionIsLive(s) ? "live" : sessionCwd(s) ? null : "no-dir";

/** One resumable session in the picker. */
function ResumeRow({ s, openChatId, onPick }: { s: SessionRollup; openChatId?: string; onPick: () => void }) {
  const why = blockedReason(s);
  const model = modelLabelOf(s.model_name);
  // A resumable session names the worktree it ran in when that isn't the repo
  // itself — resuming lands back in that checkout, so it has to say which.
  const wt = sessionWorktree(s);
  const label = (s.project_path ? repoName(s.project_path) : s.source_app) + (wt ? ` └ ${wt}` : "");
  const note = why === "live"
    ? "This session is still running. A claude session has a single owner — a second one writing to the same transcript would corrupt its history. Resume it once it stops."
    : why === "no-dir"
    ? "No directory was recorded for this session, so there's nowhere to run the resumed conversation."
    : openChatId
    ? "Already open in this panel — picking it focuses that tab."
    : `Continue this conversation in ${sessionCwd(s)}`;

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
      // cwd included: with a worktree per card, the card id is in the checkout
      // path and nowhere else — searching "20343" has to find that session.
      (`${s.project_path ?? ""} ${s.cwd_path ?? ""} ${s.source_app} ${s.session_id}`).toLowerCase().includes(needle));
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

/** Chat as a workspace view.
 *
 *  The conversations themselves already live outside React in chatStore, so
 *  they survived the old panel closing. What didn't survive was everything
 *  around them — which chat was selected, the draft in the composer, the
 *  scroll position. Staying mounted fixes that. */
// `active` is destructured as `visible` because this component already has an
// `active` of its own — the currently selected chat.
export function ChatView({ active: visible, focusId, onClose = () => {} }: { active: boolean; focusId?: string | null; onClose?: () => void }) {
  const sidebarW = useSidebarWidth();
  const open = visible;
  const allChats = useSyncExternalStore(subscribe, listChats, listChats);
  // `null` until we know, which is not the same as "unscoped". See the filter
  // below, which must not run on a guess.
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [scopeKnown, setScopeKnown] = useState(false);
  /** Whether the repo list has come back yet. Distinguishes "still finding your
   *  projects" from "there are none" — the panel used to render both as the
   *  same empty list, which reads as a broken feature rather than a pending one. */
  const [reposKnown, setReposKnown] = useState(false);
  /** Set when + new was pressed with nowhere to run. */
  const [noRepo, setNoRepo] = useState(false);

  // Chats outlive the page now, so the panel can be holding tabs from a project
  // you are no longer in. They stay in the store, and stay saved, but a project
  // is a scope: being in one repo and looking at another's conversations is the
  // mixing this app exists to avoid. Switching back brings them straight back.
  //
  // An unscoped instance, the desktop app watching every project at once, has
  // no scope to filter by, so it shows everything.
  const chats = useMemo(() => {
    if (!workspace) return allChats;
    return allChats.filter((c) => c.cwd === workspace || c.cwd.startsWith(workspace.replace(/\/$/, "") + "/"));
  }, [allChats, workspace]);
  // Starts on whichever tab was open when the window last went away, so a crash
  // or a project switch puts you back where you were instead of at the end of
  // the tab strip.
  const [activeId, setActiveId] = useState(restoredActiveId);
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

  // Looked up in the scoped list, not the store, so a restored tab belonging to
  // another project never renders even for the frame before the effect below
  // moves selection off it.
  const active = chats.find((c) => c.id === activeId);

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
    }).catch(() => {}).finally(() => setReposKnown(true));
    api.chatEnabled().then((r) => { setEnabled(r.enabled); setBypassAllowed(!!r.bypass); }).catch(() => {});
    // Which project this instance is scoped to, if any. A failure here means we
    // never learn of a scope, so nothing is hidden, which is the safe direction.
    api.projects()
      .then((r) => setWorkspace(r.workspace))
      .catch(() => {})
      .finally(() => setScopeKnown(true));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Opening with nothing to show should land on something usable, not an empty
  // frame asking to be clicked.
  // Only seeds a chat when the panel is opened with none — not on every change
  // to the count, which made closing the last chat instantly resurrect it.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) { seeded.current = false; setResumeOpen(false); return; }
    // Not before the scope is known. Restored chats are already in the store,
    // but until we know which project we are in we cannot tell whether any of
    // them belong here, and seeding on that guess drops a blank tab on top of
    // the ones about to appear.
    if (!scopeKnown) return;
    if (!seeded.current && !chats.length && defaultCwd) {
      seeded.current = true;
      setActiveId(newChat(defaultCwd).id);
      return;
    }
    // Covers the restored tab having been closed, and the restored tab belonging
    // to a project other than the one now open.
    if (!chats.some((c) => c.id === activeId) && chats.length) setActiveId(chats[chats.length - 1].id);
  }, [open, chats, defaultCwd, activeId, scopeKnown]);

  // The store persists the tab set and needs to record which of them was up.
  useEffect(() => { setActiveChatId(activeId); }, [activeId]);

  // Opened to continue a specific session (from the fleet view): show that tab
  // rather than whichever was last active, or the request looks ignored.
  useEffect(() => { if (focusId && getChat(focusId)) setActiveId(focusId); }, [focusId]);

  useEffect(() => { if (defaultCwd) { try { localStorage.setItem(CWD_KEY, defaultCwd); } catch { /* ignore */ } } }, [defaultCwd]);

  // Whatever is on screen is, by definition, no longer waiting on you.
  useEffect(() => {
    if (open && active) clearAttention(active.id);
  }, [open, active?.id, active?.unread, active?.attention]);

  // Follow the newest turn. The reset key is "which chat, and is the panel up",
  // so opening it — or coming back to a chat you had scrolled up in — always
  // lands on the live end rather than wherever you last left the scrollbar.
  //
  // Height changes are watched rather than enumerated: a chat grows from
  // streaming text, from tool chips appended to a message already on screen,
  // and from markdown and syntax highlighting that settle a frame or two after
  // the content arrives. The previous version keyed an effect on the message
  // count and the last message's length, so everything in that second group
  // slipped past it and the view fell behind the stream it was supposed to be
  // showing live.
  const { scrollRef, contentRef, pinned, toBottom, onScroll } =
    useStuckBottom(open ? active?.id ?? "" : null);

  const add = useCallback(() => {
    // `workspace` last: a scoped instance always has one, so the only way to
    // reach "" now is a machine with no repo at all.
    const cwd = active?.cwd || defaultCwd || repos[0]?.root || workspace || "";
    // A chat with no directory cannot run — `claude` needs somewhere to start —
    // so it used to appear in the list as "no repo" and fail at the first
    // message. Before the repos call resolves every one of those fallbacks is
    // empty, so clicking + new in that window produced exactly that dead tab
    // and looked like new chats were broken. Refuse instead, and say why.
    if (!cwd) { setNoRepo(true); return; }
    setNoRepo(false);
    const c = newChat(cwd, active?.model ?? DEFAULT_MODEL, active?.mode ?? DEFAULT_MODE);
    setActiveId(c.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [active, defaultCwd, repos, workspace]);

  // Adopt an existing claude session. Focusing an already-open tab rather than
  // opening a second one is not a nicety: two chats resuming one session id
  // would both write to that transcript, which is the same corruption the live
  // check exists to prevent.
  const resume = useCallback((s: SessionRollup) => {
    setResumeOpen(false);
    // Resume in the checkout it ran in, not the repo it rolls up to.
    const cwd = sessionCwd(s);
    if (!cwd || sessionIsLive(s)) return;
    const chat = chatResuming(s.session_id)
      ?? newChat(cwd, s.model_name || undefined, active?.mode ?? DEFAULT_MODE, {
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
    // Mid-turn, Enter queues instead of sending. The composer used to go dead
    // for the length of a reply, so a long tool-running turn meant watching it
    // work with an answer already typed and no way to hand it over.
    if (active.sending) { enqueue(active.id, text); return; }
    send(active.id, text, () => openRef.current && activeIdRef.current === active.id, allowed.split(/\s+/).filter(Boolean));
  };
  const [hint, setHint] = useState("");
  // A turn is sendable when there is text or at least one attachment.
  const hasTurn = !!(active?.draft.trim() || active?.attachments.length);

  // Screenshots arrive as clipboard *files*, not text, so the paste is only
  // intercepted when there is at least one image among them — a normal text
  // paste has to fall through to the textarea untouched.
  //
  // Both `files` and `items` are read because engines disagree on where a
  // pasted image lands. Chromium populates `clipboardData.files`; some engines
  // deliver it only through `items` and leave `files` empty. Reading both
  // covers either, so a paste never silently does nothing.
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

  // A drag crossing a child element fires `dragleave` on the parent, so the
  // highlight is counted in and out rather than toggled — otherwise it flickers
  // off the moment the cursor passes over the textarea it is inviting you to
  // drop on.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const onDragOver = (e: React.DragEvent) => {
    if (!enabled || !active) return;
    if (!Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) return;
    // Without this the browser answers the drop itself by navigating to the
    // file, replacing the whole app with the image.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dragDepth.current++;
    setDragOver(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragOver(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!active) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    // Files, not just images: `addAttachments` quotes a text file into the
    // draft, which is the same thing the picker and the paste path already do.
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) {
      // A drag from another window can carry an image as bytes with no File
      // behind it; `imagesFrom` reads the item list the paste path relies on.
      const items = imagesFrom(e.dataTransfer);
      if (items.length) setHint(await addAttachments(active.id, items));
      return;
    }
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
    setHint("");
    submit();
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => (c.title + " " + repoName(c.cwd)).toLowerCase().includes(q));
  }, [chats, query]);

  // Worktrees read as their card ("└ WEB-1042"), not as a near-duplicate of
  // the project name — with a dozen open, `orbit-WEB-1042` and
  // `orbit-WEB-1043` are one glance apart otherwise.
  const repoOptions = useMemo(
    () => repos.map((r) => {
      const wt = worktreeTag(r);
      return { value: r.root, label: wt ? `└ ${wt}` : repoName(r.root), hint: r.branch };
    }),
    [repos]
  );

  return (
    <div className="relative flex-1 min-h-0 flex overflow-hidden">
                <style>{SCROLLBAR_CSS}</style>

                {/* Anchored inside the modal rather than portalled like Select:
                    this panel already sits at a very high z-index, and a
                    portalled menu would render underneath it. */}
                <AnimatePresence>
                  {resumeOpen && <ResumePicker onPick={resume} onClose={() => setResumeOpen(false)} />}
                </AnimatePresence>

                {/* ---- sidebar: every open chat ---- */}
                <div className="shrink-0 flex flex-col" style={{ width: sidebarW, background: "color-mix(in srgb, var(--bg) 40%, transparent)" }}>
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
                    {/* Three different situations that all used to say "no
                        chats match": a filter that excluded everything, a list
                        still being fetched, and a machine with no repo to run
                        one in. Only the first is about matching. */}
                    {!shown.length && (
                      <div className="px-2.5 py-3 text-[11px] t-dim2">
                        {query.trim() ? "no chats match"
                          : !reposKnown || !scopeKnown ? "finding your projects…"
                          : !repos.length ? "no git repository found to run a chat in"
                          : "no chats yet — press + new"}
                      </div>
                    )}
                    {noRepo && (
                      <div className="px-2.5 py-2 text-[11px]" style={{ color: "var(--warning)" }}>
                        nowhere to run a chat: no git repository was found
                      </div>
                    )}
                  </div>
                  {/* Pinned under the list, so context and spend for the chat you
                      are reading stay on screen while you scroll its history. */}
                  {active && <Inspector chat={active} />}
                </div>
                <SidebarGrip />

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
                  {/* The wrapper is what "jump to latest" is positioned against:
                      it ends exactly where the composer begins, so the button
                      floats just above the input instead of over it. */}
                  <div className="relative flex-1 min-h-0 flex flex-col">
                  <div ref={scrollRef} onScroll={onScroll}
                    className="agx-scroll flex-1 min-h-0 overflow-y-auto px-5 py-4">
                    <div ref={contentRef} className="min-h-full flex flex-col justify-end gap-3">
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
                            style={{
                              ...CODE_FONT_STYLE, fontFamily: undefined, opacity: m.historical ? 0.72 : 1,
                              // Stronger than the old 16%/45% wash: at that
                              // strength every bubble was the same violet as the
                              // panel behind it, and on some themes the two roles
                              // were indistinguishable. The left border is what
                              // survives a theme that flattens the fills.
                              background: m.role === "user"
                                ? "color-mix(in srgb, var(--primary) 26%, var(--bg2))"
                                : "color-mix(in srgb, var(--bg3) 85%, var(--bg))",
                              border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                              borderLeft: `3px solid ${m.role === "user" ? "var(--primary)" : "color-mix(in srgb, var(--info) 70%, transparent)"}`,
                              color: "var(--text)",
                            }}>
                            {/* Role and time, the way the session view has always
                                shown them — their absence is most of why the two
                                read as different products. */}
                            <div className="text-[9px] uppercase tracking-wider mb-1 flex items-center gap-2"
                              style={{ color: m.role === "user" ? "var(--primary-hover)" : "var(--info)" }}>
                              <span>{m.role}</span>
                              <span className="t-dim2 normal-case tracking-normal">{fmtTime(m.ts)}</span>
                            </div>
                            {m.thinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.text} />}
                            {m.tools.length > 0 && (
                              <div className="flex flex-col gap-0.5 mb-1.5 pb-1.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                                {/* Folded the same way the session timeline
                                    folds it: a subagent's work nests under the
                                    call that spawned it rather than being
                                    interleaved with the main thread's. */}
                                {buildRows(m.tools.map((t) => ({
                                  kind: "tool" as const, ts: t.ts, tool: t.name, target: t.target,
                                  is_error: t.error, output: t.output, note: t.note,
                                  agent_id: t.agentId, agent_type: t.agentType, tool_use_id: t.id,
                                }))).map((r) => r.kind === "tool" && (
                                  <ToolRow key={r.key} e={r.e} sub={r.children} />
                                ))}
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
                            {!!m.imagesDropped && (
                              <div className="mb-1.5 text-[10px] t-dim2 italic">
                                {m.imagesDropped} image{m.imagesDropped > 1 ? "s" : ""} sent with this turn, not kept when the chat was restored
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

                  {/* Sibling of the scroller, not a child: an absolutely
                      positioned element inside a scroll container scrolls away
                      with the content, which is the one place this must not be.
                      Only while detached — a permanent button would be noise,
                      but silently stopping following looks like a frozen panel. */}
                  {!pinned && (
                    <div className="absolute left-0 right-0 bottom-0 grid place-items-center pointer-events-none" style={{ zIndex: 5 }}>
                      <button onClick={toBottom}
                        title="Jump to the newest message and follow again"
                        className="pointer-events-auto mb-2 text-[10px] px-2.5 py-1 rounded-full font-medium shadow-lg"
                        style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 18%, var(--bg2))", border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)" }}>
                        ↓ jump to latest
                      </button>
                    </div>
                  )}
                  </div>

                  <div className="shrink-0 border-t p-3 relative" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
                    style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    {dragOver && (
                      // Drawn over the composer rather than around it: a border
                      // swap reflows the textarea under the cursor mid-drag.
                      <div className="absolute inset-0 z-10 grid place-items-center rounded-lg pointer-events-none text-[11px] font-semibold"
                        style={{ background: "color-mix(in srgb, var(--primary) 14%, transparent)", border: "1px dashed color-mix(in srgb, var(--primary) 60%, transparent)", color: "var(--text)" }}>
                        drop to attach
                      </div>
                    )}
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
                    {active?.setupNeeded && (
                      // The CLI never started. Retrying is pointless until the
                      // named command is run, so this says the command rather
                      // than offering a retry that will fail the same way.
                      <div className="mb-2 px-2.5 py-2 rounded-lg text-[11px]"
                        style={{ background: "color-mix(in srgb, var(--error) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)", color: "var(--text2)" }}>
                        <div style={{ color: "var(--text)" }}>{active.setupNeeded.why}</div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <code className="px-1.5 py-0.5 rounded" style={{ ...CODE_FONT_STYLE, background: "color-mix(in srgb, var(--bg3) 60%, transparent)", color: "var(--text)" }}>
                            {active.setupNeeded.command}
                          </code>
                          <button onClick={() => { navigator.clipboard?.writeText(active.setupNeeded!.command); }}
                            className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>copy</button>
                          <button onClick={() => update(active.id, (c) => { c.setupNeeded = undefined; c.attention = "none"; })}
                            className="ml-auto text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)" }}>dismiss</button>
                        </div>
                      </div>
                    )}
                    {active?.blockedTool && (
                      // The refusal happens silently server-side, so without
                      // this the only symptom is an agent saying it is blocked
                      // and a user with no idea an allowlist exists.
                      <div className="mb-2 px-2.5 py-2 rounded-lg flex items-center gap-2 text-[11px]"
                        style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", color: "var(--text2)" }}>
                        <span className="min-w-0 flex-1">
                          <b style={{ color: "var(--text)" }}>{active.blockedTool}</b> was refused — it isn't in this chat's allowed tools.
                        </span>
                        <button
                          onClick={() => {
                            const next = `${allowed} ${active.blockedTool}`.trim();
                            setAllowed(next);
                            update(active.id, (c) => { c.blockedTool = undefined; });
                          }}
                          className="shrink-0 px-2 py-1 rounded-md text-[10.5px] font-medium"
                          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>
                          allow {active.blockedTool}
                        </button>
                        <button onClick={() => update(active.id, (c) => { c.blockedTool = undefined; })}
                          className="shrink-0 px-1 t-dim2 hover:opacity-70" aria-label="dismiss">✕</button>
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
                    {/* What you have already handed over, above the composer
                        and in the order it will go — a queued message is
                        otherwise indistinguishable from one that vanished. */}
                    {!!active?.queued.length && (
                      <div className="mb-2 flex flex-col gap-1">
                        {active.queued.map((q, i) => (
                          <div key={q.id} className="flex items-baseline gap-2 px-2.5 py-1.5 rounded-lg"
                            style={{ background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px dashed color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                            <span className="shrink-0 text-[9.5px] t-dim2">queued {i + 1}</span>
                            <span className="flex-1 truncate text-[11.5px]" style={{ color: "var(--text3)" }}>
                              {q.text || `${q.images.length} image${q.images.length > 1 ? "s" : ""}`}
                            </span>
                            {!!q.images.length && q.text && <span className="shrink-0 text-[9.5px] t-dim2">+{q.images.length} img</span>}
                            {/* Editing puts the text back in the composer,
                                which an attached image can't survive — so it
                                is only offered where nothing is lost. */}
                            {!q.images.length && (
                              <button onClick={() => unqueue(active.id, q.id, true)} title="Put this back in the composer"
                                className="shrink-0 text-[9.5px] t-dim2 hover:opacity-70">edit</button>
                            )}
                            <button onClick={() => unqueue(active.id, q.id)} aria-label="Remove queued message"
                              className="shrink-0 px-1 t-dim2 hover:opacity-70">✕</button>
                          </div>
                        ))}
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
                      <textarea ref={inputRef} aria-label="chat composer" value={active?.draft ?? ""} disabled={!enabled || !active} rows={2}
                        onChange={(e) => active && update(active.id, (c) => { c.draft = e.target.value; })}
                        onKeyDown={onKey}
                        onPaste={onPaste}
                        placeholder={!enabled ? "chat unavailable" : active?.sending ? "still replying — type anyway, Enter queues it for the next turn" : active?.sessionId ? "reply… (Enter to send, Shift+Enter newline)" : "message a new session… (Enter to send)"}
                        className="agx-scroll flex-1 px-3 py-2 rounded-lg text-[12px] outline-none resize-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                      {/* Stop stays reachable while a turn is queueing: the
                          two are different intents — "answer this next" and
                          "drop what you're doing" — and hiding either one
                          behind the other is how you lose a turn you meant to
                          keep. */}
                      {active?.sending && (
                        <button onClick={() => stop(active.id)} title="Interrupt the turn and clear anything queued"
                          className="shrink-0 px-3.5 rounded-lg text-[11.5px] font-semibold self-stretch" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>■ stop</button>
                      )}
                      <button onClick={submit} disabled={!hasTurn || !active?.cwd || !enabled} className="shrink-0 px-4 rounded-lg text-[11.5px] font-semibold self-stretch" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", opacity: (!hasTurn || !active?.cwd) ? 0.45 : 1 }}>
                        {active?.sending ? "queue ↵" : "send ↵"}
                      </button>
                    </div>
                    <div className="mt-1.5 text-[9.5px] t-dim2">
                      {hint
                        ? <span style={{ color: "var(--warning)" }}>{hint}</span>
                        : <>runs claude in {active ? repoName(active.cwd) || "the repo" : "the repo"} · {MODES.find((x) => x.id === active?.mode)?.label} · tools appear as ⚙ chips</>}
                      {active?.mode === "bypassPermissions" && <span style={{ color: "var(--warning)" }}> · ⚡ runs tools unattended</span>}
                    </div>
                  </div>
                </div>
    </div>
  );
}
