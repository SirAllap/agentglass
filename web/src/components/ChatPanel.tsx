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
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { motion, AnimatePresence } from "motion/react";
import { CHAT_EFFORTS } from "../../../shared/types.ts";
import type { GitRepoRef, SessionRollup, ChatEffort, AgentCliStatus, AgentModel } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { ALLOW_DEFAULT, initialAllowed } from "../lib/chatAllowlist.ts";
import { foldPreview, hiddenLineCount, isLongMessage } from "../lib/chatFold.ts";
import { ToolRow } from "./ToolRow.tsx";
import { ToolFeed } from "./ToolFeed.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { buildRows } from "../lib/toolTree.ts";
import { chatToMarkdown } from "../lib/chatTranscript.ts";
import { busyElsewhere, setActiveTurns } from "../lib/chatStore.ts";
import { tidyPaneScreen } from "../lib/paneScreen.ts";
import { quickSkills, pinnedSkills, togglePinnedSkill } from "../lib/quickSkills.ts";
import { fmtTime } from "../lib/format.ts";
import { Select } from "./Select.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./ChangesModal.tsx";
import { fmtAgo, fmtUsd, fmtTokens, modelLabelOf, modelColor } from "../lib/format.ts";
import { sessionIsLive, resumableAgent } from "../lib/derive.ts";
import { ctxLimitOf } from "../lib/contextWindow.ts";
import { worktreeTag, sessionWorktree, sessionCwd } from "../lib/worktree.ts";
import { useStuckBottom } from "../lib/useStuckBottom.ts";
import {
  listChats, getChat, newChat, closeChat, update, send, stop, enqueue, unqueue, subscribe, chatResuming,
  engineFor,
  AGENTS, isFresh, switchAgent,
  addAttachments, answerPane, dropAttachment, renameChat, clearAttention, type Chat, type AgentKind,
  restoredActiveId, setActiveChatId, chatFocusRequest, setPanePinned, hydratePanePins,
} from "../lib/chatStore.ts";
import { peekChatIntent, subscribeChatIntent, takeChatIntent } from "../lib/chatIntent.ts";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";

// Claude's list arrives from the server, like the other two agents'. It is data
// there (shared/claude-models.json), filtered to the models whose shutdown date
// has not passed — Claude Code publishes no list of its own, so a file that can
// be corrected without a rebuild is the closest thing to asking the CLI.
//
// This is only what to draw before that answer arrives, and on a server too old
// to send one. Deliberately a single certain id rather than a copy of the
// catalogue: two lists that drift apart is the problem being solved.
const MODELS_PENDING = [{ id: "claude-opus-5", label: "Claude Opus 5" }];
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

// Codex draws its line around the filesystem rather than per tool call, so it
// gets its own three rather than being squeezed into Claude's four. Labelling a
// sandbox "Ask (denies un-allowed)" would describe a mechanism it has not got.
// Keep in step with SANDBOXES in server/src/codex.ts.
const CODEX_MODES = [
  { id: "read-only", label: "Read-only (no writes)" },
  { id: "workspace-write", label: "Write in this repo" },
  { id: "full-access", label: "⚡ Full access (no sandbox)" },
];

// Antigravity's four land on Claude's, because it really does decide per tool
// call and really does have a plan mode — this is the CLI's own shape rather
// than a mapping forced here. `request-review` is its default and is spelled by
// passing no flag. Keep in step with MODES in server/src/antigravity.ts.
const ANTIGRAVITY_MODES = [
  { id: "request-review", label: "Ask (denies un-allowed)" },
  { id: "plan", label: "Plan (no edits)" },
  { id: "accept-edits", label: "Auto-accept edits" },
  { id: "always-proceed", label: "⚡ Bypass (runs all)" },
];

/** Before the server has answered, and for a CLI that is not installed. */
const CLI_OFF: AgentCliStatus = { enabled: false, models: [] };

const MODES_BY_AGENT: Record<AgentKind, Array<{ id: string; label: string }>> = {
  claude: MODES, codex: CODEX_MODES, antigravity: ANTIGRAVITY_MODES,
};
const modesFor = (agent: AgentKind) => MODES_BY_AGENT[agent];
const bypassMode = (agent: AgentKind) => AGENTS[agent].bypassMode;
const cliName = (agent: AgentKind) => AGENTS[agent].cli;
const agentLabel = (agent: AgentKind) => AGENTS[agent].label;

/** What the model dropdown may offer.
 *
 *  One path for all three agents now: every list comes from the server, because
 *  every list is the answer to "what will this CLI actually accept" and none of
 *  them is this component's to decide. Claude used to be the exception, with a
 *  hand-maintained array here that drifted every release.
 *
 *  A list that has not arrived yet falls back to that agent's default rather
 *  than rendering an empty dropdown. */
function modelsFor(agent: AgentKind, status: AgentCliStatus): Array<{ id: string; label: string }> {
  if (status.models.length) return status.models;
  const fallback = AGENTS[agent].defaultModel;
  return [{ id: fallback, label: fallback }];
}
const CWD_KEY = "agentglass.chatCwd";
const ALLOW_KEY = "agentglass.chatAllowedTools";
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
 * Closed until asked, streaming or not. It used to open itself while it was the
 * only thing happening, on the grounds that watching it stream is the difference
 * between "thinking" and "frozen" — but that put the working-out on screen by
 * default, which is exactly what nobody asked to read. Liveness is the tool
 * feed's running call and the composer's caret; this stays folded.
 */
/**
 * A message that is too long to sit in a conversation whole.
 *
 * Almost always a pasted prompt — a review brief with its rules, its context
 * and a block of JSON — which rendered in full takes the panel and pushes the
 * reply you came to read off the bottom of it. Folded, the conversation is a
 * conversation again.
 *
 * The top is kept rather than a summary: these are somebody's own words, and
 * the first lines are the part that says what they are. Reopening is a toggle
 * rather than a one-way reveal, because the reason to expand one of these is
 * usually to check a single line and then get out of the way again.
 */
function Foldable({ text, children }: { text: string; children: (shown: string) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!isLongMessage(text)) return <>{children(text)}</>;
  const hidden = hiddenLineCount(text);
  return (
    <>
      {children(open ? text : foldPreview(text))}
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="mt-1.5 text-[10px] px-2 py-0.5 rounded-full hover:opacity-80"
        style={{
          color: "var(--primary-hover)",
          border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)",
          background: "color-mix(in srgb, var(--primary) 10%, transparent)",
        }}>
        {/* What it costs to open. A fold that will not say how much it is
            hiding is a fold nobody opens. */}
        {open ? "Show less" : `Show ${hidden} more line${hidden === 1 ? "" : "s"}`}
      </button>
    </>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.trim().split("\n");
  return (
    <div className="mb-1.5 rounded-md overflow-hidden" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
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
      {/* Only when the CLI told us the prompt size. Codex's exec stream reports
          no per-turn context and no window, and a bar drawn at 0 / 400k would
          be a claim about a session we know nothing about. */}
      {u.contextTokens > 0 && (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>context</span>
            <span className="text-[10px] tabular-nums ml-auto" style={{ color: tone }}>{pct.toFixed(0)}%</span>
            <span className="text-[9px] t-dim2 tabular-nums">{fmtTokens(u.contextTokens)} / {fmtTokens(limit)}</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(1, pct)}%`, background: tone }} />
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-0.5">
        <Row k="In" v={fmtTokens(u.input)} />
        <Row k="Out" v={fmtTokens(u.output)} />
        {/* Cache read is the cheap part and usually the biggest — worth its own
            line so a large total doesn't read as a large bill. */}
        <Row k="Cache read" v={fmtTokens(u.cacheRead)} c="var(--success)" />
        <Row k="Cache write" v={fmtTokens(u.cacheWrite)} c="var(--warning)" />
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
          <div className="truncate text-[11.5px]" title="Double-click to rename"
            onDoubleClick={(e) => { e.stopPropagation(); setDraft(chat.title); setEditing(true); }}
            style={{ color: active ? "var(--text)" : "var(--text2)" }}>{chat.title}</div>
        )}
        {/* The dot carries the state as colour; this says which one, because
            "finished" and "stuck, needs you" are the same glance otherwise and
            they want opposite reactions from you. */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[9.5px] t-dim2">{repoName(chat.cwd) || "No repo"}</span>
          {chat.sending
            ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--success)" }}>· Running</span>
            : chat.attention === "blocked"
            ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--warning)" }}>· Needs you</span>
            : chat.attention === "done"
            ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--primary)" }}>· Done</span>
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
        title="Close chat"
        aria-label={`Close chat: ${chat.title}`}
      >✕</button>
    </div>
  );
}

/** The reply is coming but has not started.
 *
 *  Announced once to assistive tech, because the visual signal here is motion
 *  and motion alone — there is no text to read until the answer begins. */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[3.5px] align-middle py-1" role="status" aria-label="Waiting for a reply">
      {[0, 1, 2].map((i) => (
        <span key={i} className="agx-typing-dot rounded-full" style={{ width: 5, height: 5, background: "var(--text3)" }} />
      ))}
    </span>
  );
}

/** An interactive prompt waiting in a chat's tmux pane, and the keys to answer it.
 *
 *  The pane is the only thing that can render a `/model` picker properly, so
 *  this shows what it drew and forwards the few keys a picker takes. Each press
 *  returns the next frame, which is what makes it feel like using the menu
 *  rather than firing keys into the dark.
 *
 *  Escape both cancels the prompt and clears this, because a cancelled picker
 *  leaves nothing to answer. */
function PanePrompt({ chat }: { chat: Chat }) {
  const screen = useMemo(() => tidyPaneScreen(chat.paneNeedsYou?.screen ?? ""), [chat.paneNeedsYou?.screen]);
  const press = (k: string) => void answerPane(chat.id, k);
  // Small, quiet, and second to the real keys. These exist so the keys are
  // discoverable and for anyone who reaches for the mouse — not as the way in.
  const Key = ({ label, k }: { label: string; k: string }) => (
    <button onClick={() => press(k)} title={`Send ${k} to the pane`}
      className="text-[10px] leading-none px-1.5 py-1 rounded"
      style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>{label}</button>
  );
  return (
    <div className="mb-2 rounded-lg overflow-hidden"
      style={{ border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>
      <div className="px-2.5 py-1.5 flex items-center gap-2 text-[11px]"
        style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--text)" }}>
        <span>Waiting on you</span>
        {/* The keys the prompt itself names, shown as keys. */}
        <span className="flex items-center gap-1 ml-auto">
          <Key label="←" k="Left" /><Key label="→" k="Right" />
          <Key label="↑" k="Up" /><Key label="↓" k="Down" />
          <Key label="Enter" k="Enter" /><Key label="Esc" k="Escape" />
        </span>
      </div>
      <pre className="agx-scroll px-2.5 py-2 overflow-x-auto whitespace-pre text-[11px] leading-[1.5] m-0"
        style={{ ...CODE_FONT_STYLE, background: "color-mix(in srgb, var(--bg3) 45%, transparent)", color: "var(--text2)", maxHeight: 260 }}>{screen}</pre>
      <div className="px-2.5 py-1 text-[9.5px] t-dim2 flex items-center gap-1.5"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
        <span>Your arrow keys work here.</span>
        {chat.attachCommand && (
          <button onClick={() => navigator.clipboard?.writeText(chat.attachCommand!)}
            className="ml-auto hover:opacity-70" title={chat.attachCommand}
            style={{ color: "var(--text3)" }}>Copy the tmux command</button>
        )}
      </div>
    </div>
  );
}

/** How hard the model is asked to think, as a dial you can read at a glance.
 *
 *  Bars rather than a dropdown because the values are ordered — the useful
 *  question is "more or less than now", and a list of six words makes you read
 *  all six to answer it. Filled bars carry the level; the label names it, since
 *  bars alone cannot tell `xhigh` from `max`.
 *
 *  "Default" is a real seventh state and deliberately first: it means the CLI's
 *  own configured effort is left alone, which is what someone who set it in
 *  their settings.json wants. Anything else passes `--effort`. */
function EffortDial({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(false);
  const at = chat.effort ? CHAT_EFFORTS.indexOf(chat.effort) : -1;
  const label = chat.effort ?? "default";
  const pick = (v: ChatEffort | undefined) => {
    update(chat.id, (c) => { c.effort = v; });
    setOpen(false);
  };
  return (
    <span className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="listbox"
        title={"How hard the model thinks, sent as --effort.\n\nDefault leaves the CLI's own setting alone.\nChanging this restarts the chat's session, keeping the conversation."}
        className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md"
        style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
        <span className="flex items-end gap-[2px]" aria-hidden>
          {CHAT_EFFORTS.map((_, i) => (
            <span key={i} style={{
              width: 3, height: 4 + i * 2, borderRadius: 1,
              background: i <= at ? "var(--primary-hover)" : "color-mix(in srgb, var(--border) 70%, transparent)",
            }} />
          ))}
        </span>
        <span>{label}</span>
      </button>
      {open && (
        <div role="listbox" className="absolute z-20 mt-1 right-0 rounded-lg py-1 min-w-[150px]"
          style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 8px 24px rgba(0,0,0,.35)" }}>
          <button onClick={() => pick(undefined)} role="option" aria-selected={!chat.effort}
            className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-white/5"
            style={{ color: !chat.effort ? "var(--text)" : "var(--text3)" }}>Default</button>
          {CHAT_EFFORTS.map((v) => (
            <button key={v} onClick={() => pick(v)} role="option" aria-selected={chat.effort === v}
              className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-white/5"
              style={{ color: chat.effort === v ? "var(--text)" : "var(--text3)" }}>{v}</button>
          ))}
        </div>
      )}
    </span>
  );
}

/** A header button that copies something and says it did.
 *
 *  The confirmation is the whole point: a copy that succeeds looks exactly like
 *  a copy that silently failed, and both look like a button that does nothing.
 *  The label reverts on its own so the header does not stay changed. */
function CopyButton({ label, title, text, disabled }: { label: string; title: string; text: () => string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setDone(true);
        } catch {
          // Clipboard access can be refused (an insecure origin, a denied
          // permission). Saying nothing would read as the copy having worked.
          setDone(false);
        }
      }}
      disabled={disabled}
      title={title}
      className="text-[10px] px-2 py-1 rounded-md shrink-0 disabled:opacity-40"
      style={{ color: done ? "var(--ok, var(--text2))" : "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}
    >{done ? "Copied" : label}</button>
  );
}

/** Why a session can't be picked up, or `null` if it can.
 *
 *  Only one refusal is absolute now: a session that never recorded a directory
 *  has nowhere to resume into. "Still running" used to be the other, which made
 *  the sessions you most wanted — the one you just started on your phone, the
 *  one working in a terminal — the only ones you could not open. They can be
 *  opened and read; what protects the transcript is that a turn is queued
 *  rather than sent while someone else is writing (see chatStore.busyElsewhere,
 *  and the server's own 409 behind it). */
type Blocked = "no-dir" | null;
const blockedReason = (s: SessionRollup): Blocked => (sessionCwd(s) ? null : "no-dir");

/** One resumable session in the picker. */
function ResumeRow({ s, openChatId, onPick }: { s: SessionRollup; openChatId?: string; onPick: () => void }) {
  const why = blockedReason(s);
  const model = modelLabelOf(s.model_name);
  // Which CLI will be handed this session. Worth showing now that three of them
  // can appear side by side: the row opens a chat bound to that binary for
  // life, and "Opus 5" alone no longer says which one — `agy` runs Claude
  // models too.
  const agent = resumableAgent(s) ?? "claude";
  // Claude keeps its transcripts in this app's own store and Codex has a
  // rollout on disk, so both come back with the conversation in front of you.
  // Antigravity keeps protobuf inside SQLite, so a resumed thread arrives with
  // the CLI holding the full context and the panel showing none of it. That is
  // worth saying before the click, not after.
  const noReplay = !AGENTS[agent].hasTranscript;
  // A resumable session names the worktree it ran in when that isn't the repo
  // itself — resuming lands back in that checkout, so it has to say which.
  const wt = sessionWorktree(s);
  const label = (s.project_path ? repoName(s.project_path) : s.source_app) + (wt ? ` └ ${wt}` : "");
  const live = sessionIsLive(s);
  const note = why === "no-dir"
    ? "No directory was recorded for this session, so there's nowhere to run the resumed conversation."
    : openChatId
    ? "Already open in this panel — picking it focuses that tab."
    : live
    ? `Running now. Opening it shows the conversation; anything you send waits until this turn ends, because a session has one writer.`
    : `Continue this ${AGENTS[agent].label} conversation in ${sessionCwd(s)}`
      + (noReplay
        ? `\n\n${AGENTS[agent].label} keeps no transcript this panel can read, so the reply history won't be shown — ${AGENTS[agent].cli} still has the full context and follow-ups continue the same thread.`
        : "");

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
          <span style={{ color: "var(--text3)" }}>{AGENTS[agent].label}</span>
          <span style={{ color: modelColor(model) }}>· {model}</span>
          {noReplay && <span title="History is not replayed for this agent">· no replay</span>}
          <span>· {fmtAgo(s.last_seen)} ago</span>
          <span>· {fmtUsd(s.cost_usd)}</span>
        </div>
      </div>
      {live
        ? <span className="text-[9.5px] shrink-0" style={{ color: "var(--success)" }}>● Running</span>
        : why === "no-dir"
        ? <span className="text-[9.5px] shrink-0 t-dim2">No dir</span>
        : openChatId
        ? <span className="text-[9.5px] shrink-0 t-dim2">Open ↗</span>
        : <span className="text-[10px] shrink-0" style={{ color: "var(--primary-hover)" }}>↩</span>}
    </button>
  );
}

/**
 * Pick up a session that already exists, whichever CLI made it.
 *
 * The panel could always *start* conversations, but the ones worth continuing
 * are usually the ones started somewhere else — in a terminal, or by an earlier
 * run — and until now there was no way to reach them from here. This lists what
 * the fleet has seen, most recent first, and hands the chosen session to the
 * store to resume.
 *
 * All three agents appear, each row naming the CLI that will be handed it,
 * because the chat it opens is bound to that binary for life and the model name
 * alone no longer says which — `agy` runs Claude models too. Sessions belonging
 * to a CLI this panel cannot drive are left out entirely rather than offered and
 * failing on the first turn.
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
    // Every CLI this panel drives can pick its own sessions back up, so the
    // list is no longer Claude's alone — it was, back when Claude was the only
    // agent, and stayed that way after Codex and Antigravity could both resume.
    //
    // Still not "everything the fleet has seen": a session belonging to a CLI
    // this panel cannot drive — a Gemini CLI run, any other OTel exporter — has
    // nothing here that could continue it. `resumableAgent` refuses those
    // rather than guessing, which matters because the guess would be "Claude"
    // and `claude --resume` would fail on an id it has never seen.
    const drivable = (rows ?? []).filter((s) => resumableAgent(s) !== null);
    const needle = q.trim().toLowerCase();
    if (!needle) return drivable;
    return drivable.filter((s) =>
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
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter sessions…"
          className="mx-1 mt-0.5 mb-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text)" }} />
        <div role="listbox" aria-label="sessions to resume" className="agx-scroll flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
          {rows === null && <div className="px-2.5 py-3 text-[11px] t-dim2">Loading sessions…</div>}
          {rows !== null && !shown.length && <div className="px-2.5 py-3 text-[11px] t-dim2">No sessions to resume</div>}
          {shown.map((s) => (
            <ResumeRow key={s.session_id} s={s} openChatId={chatResuming(s.session_id)?.id} onPick={() => onPick(s)} />
          ))}
        </div>
        <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] t-dim2 shrink-0">
          Resuming keeps claude's full context · running sessions can't be resumed
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
  // Only used on one path: closing a chat that is still mid-turn.
  const { ask, dialog } = useDialogs();
  // The server silently downgrades bypassPermissions unless the operator opted
  // in (AGENTGLASS_CHAT_BYPASS=1) — don't offer a mode that wouldn't stick.
  const [bypassAllowed, setBypassAllowed] = useState(false);
  // Which models each CLI currently offers. Every list comes from the server,
  // because every one of them is that CLI's own answer rather than a table in
  // this repo — Codex's cache, `agy models`, and for Claude a catalogue file
  // the server reads and filters by shutdown date.
  const [claudeModels, setClaudeModels] = useState<AgentModel[]>(MODELS_PENDING);
  const [codex, setCodex] = useState<AgentCliStatus>(CLI_OFF);
  const [antigravity, setAntigravity] = useState<AgentCliStatus>(CLI_OFF);
  /** One lookup for "what does the server say about this agent?", so the
   *  dropdowns and the gates below stop naming CLIs one at a time. Claude's
   *  enabled/bypass are separate pieces of state for historical reasons. */
  const statusOf = (a: AgentKind): AgentCliStatus =>
    a === "codex" ? codex : a === "antigravity" ? antigravity : { enabled, bypass: bypassAllowed, models: claudeModels };
  // Shared by every chat and remembered across launches: the set of tools you
  // trust is a property of how you work, not of one conversation.
  const [allowed, setAllowed] = useState(() => {
    try { return initialAllowed(localStorage.getItem(ALLOW_KEY)); } catch { return ALLOW_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem(ALLOW_KEY, allowed); } catch { /* private mode */ } }, [allowed]);
  const [query, setQuery] = useState("");
  const [resumeOpen, setResumeOpen] = useState(false);

  /**
   * Which sessions are mid-turn, from the server.
   *
   * The panel knows about its own turns and nothing about a turn started on the
   * phone or in a terminal — and sending into one of those interrupts it and
   * loses both answers. Polled rather than pushed because it is two words of
   * JSON and it must be right within a couple of seconds of a turn ending, when
   * a queued message is waiting to go out.
   */
  useEffect(() => {
    let stop = false;
    const read = () => {
      api.chatActive()
        .then((r) => { if (!stop) setActiveTurns(r.ids); })
        .catch(() => { /* keep the last answer; guessing a new one is the bug */ });
    };
    read();
    const t = setInterval(read, 3000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const [defaultCwd, setDefaultCwd] = useState<string>(() => { try { return localStorage.getItem(CWD_KEY) || ""; } catch { return ""; } });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Skills are already usable — `claude -p` keeps slash commands on unless
  // --disable-slash-commands is passed, which we never do. What was missing is
  // knowing they exist: you had to remember the exact name with no way to look
  // it up without leaving the chat.
  // `calls` and `last_used` are kept, not mapped away: the quick strip ranks on
  // them, and asking the server twice for the same list to get two views of it
  // would be silly.
  const [skills, setSkills] = useState<{ name: string; description: string; calls: number; last_used: number | null }[]>([]);
  useEffect(() => {
    if (!open || skills.length) return;
    api.skills().then((r) => setSkills(r.skills.map((k) => ({
      name: k.name, description: k.when_to_use || k.description, calls: k.calls, last_used: k.last_used,
    })))).catch(() => {});
  }, [open, skills.length]);
  const [pinnedNames, setPinnedNames] = useState<string[]>(() => pinnedSkills());
  const quick = useMemo(() => quickSkills(skills, pinnedNames), [skills, pinnedNames]);
  const togglePin = (name: string) => setPinnedNames(togglePinnedSkill(name));

  // Looked up in the scoped list, not the store, so a restored tab belonging to
  // another project never renders even for the frame before the effect below
  // moves selection off it.
  const active = chats.find((c) => c.id === activeId);

  /** Which CLIs this machine can actually run a chat with. Drives the agent
   *  picker, and decides what a brand-new chat should be. */
  const installed = (Object.keys(AGENTS) as AgentKind[]).filter((a) => statusOf(a).enabled);
  // Whether *this* chat can run: `enabled` only ever spoke for `claude`, so on
  // a machine with Codex installed and Claude not, it would have greyed out a
  // composer that works perfectly well.
  const usable = active ? statusOf(active.agent).enabled : installed.length > 0;
  // Pasting and dropping images is a Claude-only affordance. The other two take
  // images as file paths rather than as content blocks, so there is nowhere for
  // pasted bytes to go without staging them on disk first — the server refuses
  // them outright, and offering the button anyway would just be a slower way to
  // reach that refusal.
  const canAttach = usable && !!active && AGENTS[active.agent].canAttach;

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
    api.chatEnabled().then((r) => {
      setEnabled(r.enabled);
      setBypassAllowed(!!r.bypass);
      // Absent from a server too old to send it — keep the placeholder rather
      // than emptying the dropdown.
      if (r.models?.length) setClaudeModels(r.models);
    }).catch(() => {});
    api.codexEnabled().then(setCodex).catch(() => {});
    api.antigravityEnabled().then(setAntigravity).catch(() => {});
    // Which project this instance is scoped to, if any. A failure here means we
    // never learn of a scope, so nothing is hidden, which is the safe direction.
    api.projects()
      .then((r) => setWorkspace(r.workspace))
      .catch(() => {})
      .finally(() => setScopeKnown(true));
    // Which panes are pinned lives on the server and deliberately does not
    // persist with the chat — it is a statement about a process running now.
    // So a reloaded window knows nothing about it, and a Pin button showing
    // "off" over a pinned pane is the same lie as the reverse.
    void hydratePanePins();
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
      // Stand aside for a controller that asked for a new chat: it is about to
      // add one of its own, and seeding first would leave two empty tabs. Not a
      // race — this effect is declared above the one that drains, so on the
      // commit where both gates open it always runs first. A peek rather than a
      // take because the drain is the one that acts on it, and it cannot see
      // this tab to skip its own `add()`: `activeIdRef` is assigned during
      // render and is still empty in the same effect pass.
      if (peekChatIntent() === "new") return;
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

  // The same thing asked from inside the workspace, where there is no prop to
  // pass: the PR panel seeds a chat and asks for it. The request carries a
  // serial, so asking again for the tab you just wandered off brings it back.
  const focusReq = useSyncExternalStore(subscribe, chatFocusRequest, chatFocusRequest);
  useEffect(() => { if (focusReq.id && getChat(focusReq.id)) setActiveId(focusReq.id); }, [focusReq]);

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

  /** Open a chat.
   *
   *  `seed` is the first thing typed when there was no chat to type into — the
   *  composer opens one rather than sending the keystroke nowhere. It also
   *  suppresses the refocus below: the box is already focused, and calling
   *  focus() again would move the caret off the character just typed. */
  const add = useCallback((seed?: string) => {
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
    // A new chat inherits the agent you were last using, the same way it
    // inherits the repo and the model — and falls back to whichever CLI is
    // actually installed when there is nothing to inherit from.
    const agent: AgentKind = active?.agent ?? installed[0] ?? "claude";
    const sameAgent = active?.agent === agent;
    const c = newChat(
      cwd,
      sameAgent ? active!.model : AGENTS[agent].defaultModel,
      sameAgent ? active!.mode : AGENTS[agent].defaultMode,
      undefined,
      agent,
    );
    if (seed) update(c.id, (x) => { x.draft = seed; });
    setActiveId(c.id);
    if (!seed) requestAnimationFrame(() => inputRef.current?.focus());
    return c;
  }, [active, defaultCwd, repos, workspace, enabled, codex.enabled, antigravity.enabled]);

  // Adopt an existing session. Focusing an already-open tab rather than
  // opening a second one is not a nicety: two chats resuming one session id
  // would both write to that transcript, which is the same corruption the live
  // check exists to prevent.
  const resume = useCallback((s: SessionRollup) => {
    setResumeOpen(false);
    // Resume in the checkout it ran in, not the repo it rolls up to.
    const cwd = sessionCwd(s);
    if (!cwd) return;
    // Which CLI this session belongs to decides which one has to pick it back
    // up: a thread id is only meaningful to the binary that minted it, so
    // opening a Codex session as a Claude chat would send `claude --resume` an
    // id it has never heard of and fail on the first turn.
    //
    // The same function the picker filters on, rather than `agentOf` — which
    // would answer "claude" for a session belonging to no CLI here and hand it
    // to the wrong binary. Nothing in the list should reach this, but the two
    // must not be able to disagree.
    const agent = resumableAgent(s);
    if (!agent) return;
    const chat = chatResuming(s.session_id)
      ?? newChat(
        cwd,
        s.model_name || AGENTS[agent].defaultModel,
        // The mode is this agent's vocabulary, so a mode carried over from the
        // chat you happened to have open only applies when it is the same one.
        active?.agent === agent ? active.mode : AGENTS[agent].defaultMode,
        { sessionId: s.session_id, title: `${s.source_app}:${s.session_id.slice(0, 8)}` },
        agent,
      );
    setActiveId(chat.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [active]);

  const drop = useCallback(async (id: string) => {
    // Closing a chat also releases its tmux pane, which costs nothing when the
    // chat is idle — the transcript survives and Resume relaunches it. Mid-turn
    // is the one case that throws away real work: the agent may be halfway
    // through editing files or running a build, and nothing else in the app
    // would say so. Ask, and only here.
    const c = getChat(id);
    if (c?.sending) {
      const ok = await ask({
        title: "Close this chat while it is still working?",
        body: `"${c.title}" has a turn in progress. Closing stops it, and anything it was part-way through is left as it is.\n\nThe conversation itself is kept — you can pick it back up from Resume.`,
        confirmLabel: "Close and stop",
        cancelLabel: "Keep it open",
        danger: true,
      });
      if (!ok) return;
    }
    const rest = listChats().filter((x) => x.id !== id);
    closeChat(id);
    if (activeIdRef.current === id) setActiveId(rest[rest.length - 1]?.id ?? "");
  }, [ask]);

  const submit = () => {
    if (!active) return;
    // Sending ends the browse. Anything stashed has been superseded by the
    // message going out, and the next Up should start from the newest again —
    // which is what a shell does too.
    setRecallAt(-1);
    stashed.current = "";
    const text = active.draft;
    // Mid-turn, Enter queues instead of sending. The composer used to go dead
    // for the length of a reply, so a long tool-running turn meant watching it
    // work with an answer already typed and no way to hand it over.
    //
    // The same applies when the turn belongs to someone else — a chat you
    // started on the phone, an agent running in a terminal. `send` would queue
    // it anyway; doing it here keeps the composer honest about what pressing
    // Enter just did.
    if (active.sending || busyElsewhere(active)) { enqueue(active.id, text); return; }
    send(active.id, text, () => openRef.current && activeIdRef.current === active.id, allowed.split(/\s+/).filter(Boolean));
  };
  const [hint, setHint] = useState("");

  // An external controller (a Stream Deck) asked for a new chat. Drained from
  // the mailbox rather than subscribed to, because the command that opens this
  // panel arrives before it is mounted — see lib/chatIntent.ts.
  useEffect(() => {
    // Not until the panel knows where a chat could run. `add()` resolves a cwd
    // from the repo list and the workspace scope, and both of those arrive
    // asynchronously after the panel opens — while the command that *opened*
    // it landed before either. Draining at mount would therefore spend the
    // intent on an `add()` with nothing to point at, refuse with "no repo",
    // and — the mailbox holding one slot and no history — leave nothing to
    // retry once the repos did arrive. On a browser that has chatted before
    // the remembered cwd covers for this; on a fresh profile it is the whole
    // first press. Waiting costs one render and removes the case entirely.
    if (!reposKnown || !scopeKnown) return;
    const run = () => {
      if (takeChatIntent() === "new") add();
    };
    run();
    return subscribeChatIntent(run);
  }, [add, reposKnown, scopeKnown]);
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
    const files = imagesFrom(e.clipboardData);
    // Pasting a screenshot into an empty panel is a complete thought too, and
    // the same reason typing opens a chat applies here: the alternative is a
    // paste that appears to work and goes nowhere. Pasted text needs no help —
    // it lands as a change event and opens a chat through onChange.
    const chat = active ?? (files.length ? add() ?? null : null);
    if (!chat) return;
    // Codex and Antigravity take images as file paths, not content blocks, so
    // there is nowhere for pasted bytes to go. Say so instead of dropping them
    // silently.
    if (files.length && !AGENTS[chat.agent].canAttach) {
      e.preventDefault();
      setHint(`${cliName(chat.agent)} chats can't take pasted images — start a Claude chat for that`);
      return;
    }
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
    setHint(await addAttachments(chat.id, files));
  };

  // A drag crossing a child element fires `dragleave` on the parent, so the
  // highlight is counted in and out rather than toggled — otherwise it flickers
  // off the moment the cursor passes over the textarea it is inviting you to
  // drop on.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const onDragOver = (e: React.DragEvent) => {
    if (!usable || !active) return;
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
    if (!canAttach) { setHint("codex chats can't take dropped images — start a Claude chat for that"); return; }
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

  /*
   * Where recall currently sits, and what it interrupted.
   *
   * `-1` means not browsing. The stash is what was in the box when browsing
   * started, so coming all the way forward returns it rather than leaving you
   * staring at an empty composer wondering where your half-written message
   * went. Both reset when the chat changes: history is per conversation, and
   * an index into someone else's messages is meaningless.
   */
  const [recallAt, setRecallAt] = useState(-1);
  const stashed = useRef("");
  useEffect(() => { setRecallAt(-1); stashed.current = ""; }, [active?.id]);

  /** This chat's own sent messages, newest first. Queued turns are deliberately
   *  absent: they have not been said yet, and recalling one would put the same
   *  text in the box twice over. */
  const history = useMemo(
    () => (active?.messages ?? []).filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text).reverse(),
    [active?.messages]
  );

  /** Step back one. Returns null when there is nothing older, so the caller can
   *  let the keystroke through and the caret moves as it normally would. */
  const recallOlder = (chat: Chat): string | null => {
    const next = recallAt + 1;
    if (next >= history.length) return null;
    if (recallAt === -1) stashed.current = chat.draft;
    setRecallAt(next);
    update(chat.id, (c) => { c.draft = history[next]; });
    return history[next];
  };

  /** Step forward one, landing back on the stashed draft past the newest. */
  const recallNewer = (chat: Chat): string | null => {
    if (recallAt < 0) return null;
    const next = recallAt - 1;
    setRecallAt(next);
    const text = next < 0 ? stashed.current : history[next];
    update(chat.id, (c) => { c.draft = text; });
    return text;
  };

  const PANE_KEYS: Record<string, string> = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Enter: "Enter", Escape: "Escape", Tab: "Tab",
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /*
     * A prompt waiting in the pane owns the keyboard, and this has to be the
     * first thing checked.
     *
     * The picker itself says "←/→ to adjust · Enter to confirm". Shipping that
     * instruction next to buttons you had to click instead was the wrong way
     * round — the keys it names are the ones that should work. The buttons stay
     * as the discoverable version, and for anyone who reaches for the mouse.
     */
    if (active?.paneNeedsYou) {
      const k = PANE_KEYS[e.key];
      if (k) { e.preventDefault(); void answerPane(active.id, k); return; }
      // Anything else is someone typing a message instead of answering. Let it
      // through rather than swallowing it — the prompt is not a modal.
    }
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
    /*
     * Shell-style recall: Up walks back through what you have sent in this
     * chat, Down comes forward again and lands back on whatever you were part
     * way through typing.
     *
     * Gated on the caret being on the first or last line, because a composer
     * that ate the arrow keys would make a multi-line message impossible to
     * edit. On the first line there is nothing above to move to, so Up is free
     * to mean something else — which is the same rule a shell uses.
     */
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && active) {
      const el = e.currentTarget;
      const before = el.value.slice(0, el.selectionStart ?? 0);
      const after = el.value.slice(el.selectionEnd ?? 0);
      const atFirstLine = !before.includes("\n");
      const atLastLine = !after.includes("\n");
      const moved = e.key === "ArrowUp"
        ? (atFirstLine ? recallOlder(active) : null)
        : (atLastLine ? recallNewer(active) : null);
      if (moved !== null) {
        e.preventDefault();
        // Caret to the end, so the recalled text is ready to be added to
        // rather than typed over from wherever the cursor happened to sit.
        requestAnimationFrame(() => { const n = el.value.length; el.setSelectionRange(n, n); });
        return;
      }
      return;
    }
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
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
                <style>{SCROLLBAR_CSS}</style>

                {/* Anchored inside the modal rather than portalled like Select:
                    this panel already sits at a very high z-index, and a
                    portalled menu would render underneath it. */}
                <AnimatePresence>
                  {resumeOpen && <ResumePicker onPick={resume} onClose={() => setResumeOpen(false)} />}
                </AnimatePresence>

                {/* The title belongs to the view, so it spans the view — the
                    same bar every other section has. It used to sit inside the
                    sidebar, which made Chat look like a different application:
                    two half-width bars where the others have one. */}
                <ViewHeader title="Chats" count={chats.length} actions={<>
                  <button onClick={() => setResumeOpen((v) => !v)} aria-expanded={resumeOpen} aria-haspopup="listbox"
                    className="text-[11px] px-2.5 py-1 rounded-lg shrink-0" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}
                    title="Continue a session that already exists — e.g. one you started in a terminal">↩ Resume</button>
                  <button onClick={() => add()} className="text-[11px] px-2.5 py-1 rounded-lg shrink-0" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }} title="New chat">+ New</button>
                </>} />

                <div className="flex-1 min-h-0 flex overflow-hidden">
                {/* ---- sidebar: every open chat ---- */}
                <div className="shrink-0 flex flex-col" style={{ width: sidebarW, background: "color-mix(in srgb, var(--bg) 40%, transparent)" }}>
                  {chats.length > 6 && (
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter chats…"
                      className="mx-2.5 mt-2.5 mb-2 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                      style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text)" }} />
                  )}
                  <div role="listbox" aria-label="open chats" className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2 pt-2.5 pb-2 flex flex-col gap-0.5">
                    {shown.map((c) => (
                      <ChatRow key={c.id} chat={c} active={c.id === activeId} onPick={() => setActiveId(c.id)} onClose={() => drop(c.id)} />
                    ))}
                    {/* Three different situations that all used to say "no
                        chats match": a filter that excluded everything, a list
                        still being fetched, and a machine with no repo to run
                        one in. Only the first is about matching. */}
                    {!shown.length && (
                      <div className="px-2.5 py-3 text-[11px] t-dim2">
                        {query.trim() ? "No chats match"
                          : !reposKnown || !scopeKnown ? "Finding your projects…"
                          : !repos.length ? "No git repository found to run a chat in"
                          : "No chats yet — start typing below, or press + new"}
                      </div>
                    )}
                    {noRepo && (
                      <div className="px-2.5 py-2 text-[11px]" style={{ color: "var(--warning)" }}>
                        Nowhere to run a chat: no git repository was found
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
                          className={selCls} style={selStyle} options={repoOptions} placeholder="Pick a repo" />
                        {/* Only shown when there is a choice to make: on a
                            machine with one CLI installed this would be a
                            control with a single option and nothing to explain.

                            Switchable until the chat has a thread, then frozen.
                            A resume id belongs to the CLI that minted it, so
                            there is no meaning to handing a live conversation
                            from one to the other — but a tab you have not sent
                            anything from yet is just a blank tab. */}
                        {installed.length > 1 && (
                          isFresh(active) ? (
                            <Select value={active.agent} onChange={(v) => switchAgent(active.id, v as AgentKind)}
                              className={selCls} style={selStyle} title="Which CLI runs this chat"
                              options={installed.map((a) => ({ value: a, label: AGENTS[a].label }))} />
                          ) : (
                            <span className={selCls} title="The CLI behind this chat — settled once it has a thread to resume"
                              style={{ ...selStyle, color: "var(--text3)" }}>{agentLabel(active.agent)}</span>
                          )
                        )}
                        <Select value={active.model} onChange={(v) => update(active.id, (c) => { c.model = v; })}
                          className={selCls} style={selStyle} options={modelsFor(active.agent, statusOf(active.agent)).map((m) => ({ value: m.id, label: m.label }))} />
                        <Select value={active.mode} onChange={(v) => update(active.id, (c) => { c.mode = v; })}
                          className={selCls} style={selStyle} title={active.agent === "codex" ? "How much codex may touch without asking" : "Permission mode for tool use"}
                          options={modesFor(active.agent)
                            .filter((m) => statusOf(active.agent).bypass || m.id !== bypassMode(active.agent))
                            .map((m) => ({ value: m.id, label: m.label }))} />
                        {/* Only Claude has an allowlist to fill in. Codex decides
                            per filesystem boundary and Antigravity per call under
                            its own modes, so a box here would be a control that
                            silently did nothing. */}
                        {active.agent === "claude" && active.mode !== "bypassPermissions" && (
                          <input
                            value={allowed}
                            onChange={(e) => setAllowed(e.target.value)}
                            placeholder="Allowed tools…"
                            title={"Tools that may run without asking — space-separated.\n\nExamples: Read  Edit  Bash(git status)  Bash(gh pr view:*)\n\nWithout this, `claude -p` refuses anything that would normally prompt, because there is no terminal to prompt from."}
                            className="text-[10px] px-2 py-1 rounded-md outline-none min-w-0 flex-1 max-w-[280px]"
                            style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}
                          />
                        )}
                        {/* Same reasoning as the allowlist above: `--effort` is
                            Claude's flag, and the send path only passes it on a
                            Claude turn, so on the other two this dial would set
                            a value that goes nowhere. */}
                        {AGENTS[active.agent].hasEffort && <EffortDial chat={active} />}
                        {/* Claude Code's own settings, which are global rather
                            than per chat — so a button rather than something
                            you have to remember is a slash command. Only in
                            pane mode: `claude -p` has no interactive config to
                            open, and offering a button that cannot work is
                            worse than not offering one. */}
                        {engineFor(active) === "tmux" && active.sessionId && (
                          <button
                            onClick={() => send(active.id, "/config", () => openRef.current && activeIdRef.current === active.id, [])}
                            disabled={active.sending}
                            title="Open Claude Code's own settings in this chat's pane. They apply to every chat, not just this one."
                            className="text-[10px] px-2 py-1 rounded-md shrink-0 disabled:opacity-40"
                            style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                          >⚙ Config</button>
                        )}
                        {/* Keep this one, however long you are away.
                            The engine reclaims a warm CLI after half an hour
                            idle, which is right for the four chats you opened to
                            ask one question each and wrong for the one you are
                            living in — step away for lunch and the session you
                            care about is exactly the one reclaimed, so the turn
                            you come back to is the slow one. Beside the engine
                            chip rather than in a menu, because a pin that holds
                            several hundred megabytes should be something you can
                            see you switched on. */}
                        {engineFor(active) === "tmux" && active.sessionId && (
                          <button
                            onClick={() => void setPanePinned(active.id, !active.panePinned)}
                            role="switch" aria-checked={!!active.panePinned}
                            title={active.panePinned
                              ? "Pinned: this chat's warm CLI is kept no matter how long it sits idle. Closing the chat still releases it."
                              : "Pin this chat, so its warm CLI is never reclaimed for being idle. Costs a few hundred megabytes for as long as it is on."}
                            className="text-[10px] px-2 py-1 rounded-md shrink-0"
                            style={active.panePinned
                              ? { color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }
                              : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                          >{active.panePinned ? "📌 Pinned" : "📌 Pin"}</button>
                        )}
                        {active.sessionId && <span className="text-[9.5px] t-dim2 tabular-nums" title="Resuming this session">↻ {active.sessionId.slice(0, 8)}</span>}
                        {/* Pushed right so the two copy actions sit together at
                            the end of the header rather than between pickers. */}
                        <span className="ml-auto flex items-center gap-1.5">
                          {/* Where this chat runs, stated before its first turn
                              rather than after. Shown only for the pane engine:
                              `claude -p` is the long-standing behaviour and a
                              badge on every chat saying "normal" is noise. The
                              chip is the only way to tell the two apart from the
                              outside, and without it a preference that had not
                              taken effect looked exactly like one that had. */}
                          {engineFor(active) === "tmux" && (
                            active.attachCommand ? (
                              <CopyButton
                                label="⧉ tmux"
                                title={`This chat runs in a tmux pane. Copy the command that opens it in your own terminal, where you can keep typing:\n\n${active.attachCommand}`}
                                text={() => active.attachCommand!}
                              />
                            ) : (
                              <span
                                className="text-[10px] px-2 py-1 rounded-md shrink-0"
                                style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--border) 35%, transparent)" }}
                                title="This chat will run in a tmux pane. The pane starts with the first message, and this turns into a button that copies the command to open it in your terminal."
                              >⧉ tmux on send</span>
                            )
                          )}
                          <CopyButton
                            label="Copy chat"
                            title="Copy the whole conversation as markdown — messages, reasoning and tool calls"
                            text={() => chatToMarkdown(active)}
                            disabled={!active.messages.length}
                          />
                        </span>
                      </>
                    ) : <span className="text-[12px] t-dim2">No chat selected</span>}
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
                          {usable
                            ? <div>Chat with a {agentLabel(active.agent)} session in <b style={{ color: "var(--text2)" }}>{repoName(active.cwd) || "a repo"}</b>.<br />It runs there, appears in your fleet, and follow-ups keep the context.</div>
                            : <div>No local <code>{cliName(active.agent)}</code> CLI found — install it to chat.</div>}
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
                              // Resumed history reads at full strength, same as
                              // live: the "resumed here" divider already marks the
                              // seam, so dimming the bubbles on top of it only made
                              // a restored conversation look degraded next to the
                              // console it mirrors.
                              ...CODE_FONT_STYLE, fontFamily: undefined,
                              // Stronger than the old 16%/45% wash: at that
                              // strength every bubble was the same violet as the
                              // panel behind it, and on some themes the two roles
                              // were indistinguishable. The left border is what
                              // survives a theme that flattens the fills.
                              // Filled, not tinted. At 26% over the panel every
                              // user bubble was within a shade of the surface
                              // behind it, so on the darker themes the two
                              // speakers read as one voice. A filled accent is
                              // the one treatment that survives every palette,
                              // and it is what puts a conversation on screen
                              // instead of a transcript.
                              // Half the accent rather than a quarter of it, and
                              // no further: past about this the body text stops
                              // being reliably legible on it across the themes,
                              // and a bubble you cannot read is a worse problem
                              // than two that look alike.
                              background: m.role === "user"
                                ? "color-mix(in srgb, var(--primary) 50%, var(--bg2))"
                                : "color-mix(in srgb, var(--bg3) 85%, var(--bg))",
                              border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                              borderLeft: `3px solid ${m.role === "user" ? "var(--primary)" : "color-mix(in srgb, var(--info) 70%, transparent)"}`,
                              color: "var(--text)",
                            }}>
                            {/* Role and time, the way the session view has always
                                shown them — their absence is most of why the two
                                read as different products. */}
                            {/* On the filled user bubble the old
                                `--primary-hover` label sat on its own colour and
                                vanished; the agent's still gets the accent it
                                always had, because its bubble is a surface. */}
                            <div className="text-[9px] uppercase tracking-wider mb-1 flex items-center gap-2"
                              style={{ color: m.role === "user" ? "var(--text)" : "var(--info)", opacity: m.role === "user" ? 0.75 : 1 }}>
                              <span>{m.role}</span>
                              <span className="t-dim2 normal-case tracking-normal">{fmtTime(m.ts)}</span>
                            </div>
                            {m.thinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.text} />}
                            {/* Behind a fold, not in front of the answer. The
                                summary line carries the running call and any
                                failure; the feed itself is one click away. */}
                            <ToolFeed tools={m.tools} streaming={!!m.streaming}>
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
                            </ToolFeed>
                            {!!m.images?.length && (
                              <div className="flex flex-wrap gap-1.5 mb-1.5">
                                {m.images.map((img, j) => (
                                  <img key={j} src={`data:${img.mediaType};base64,${img.data}`} alt="Attached image"
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
                            {/* A reading measure. `max-w-[86%]` bounds the
                                bubble against the panel, which on a 1600px
                                window is a 1400px line — the eye loses the
                                start of the next one on every wrap. Characters
                                rather than pixels, so it holds when the display
                                size or the font changes. */}
                            <div style={{ maxWidth: "82ch" }}>
                              {m.text
                                ? <Foldable text={m.text}>{(shown) => <Markdown text={shown} />}</Foldable>
                                : (m.streaming ? <TypingDots /> : "")}
                            </div>
                            {m.streaming && m.text && <span className="t-dim2 agx-caret">▍</span>}
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
                        ↓ Jump to latest
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
                        Drop to attach
                      </div>
                    )}
                    {!!active?.attachments.length && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {active.attachments.map((a) => (
                          <div key={a.id} className="relative group rounded-lg overflow-hidden shrink-0"
                            style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                            title={`${a.name} · ${(a.bytes / 1024).toFixed(0)}KB`}>
                            <img src={a.url} alt={a.name} className="block h-14 w-14 object-cover" />
                            <button onClick={() => dropAttachment(active.id, a.id)} aria-label={`Remove ${a.name}`}
                              className="absolute top-0.5 right-0.5 w-4 h-4 grid place-items-center rounded text-[10px] leading-none"
                              style={{ color: "var(--text)", background: "rgba(0,0,0,0.65)" }}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {quick.length > 0 && active && !active.sending && (
                      // What you pinned, then what you actually run. The `/`
                      // menu already lists everything, but fifty entries behind
                      // a keystroke you have to remember is a reference, not a
                      // shortcut. Hidden mid-turn: the composer is for queueing
                      // then, and a row of one-click starters invites the wrong
                      // thing.
                      <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                        {quick.map((k) => (
                          <button key={k.name} onClick={() => pickSkill(k.name)}
                            title={`${k.description}${k.calls ? `\n\nRun ${k.calls} time${k.calls === 1 ? "" : "s"}` : ""}`}
                            className="text-[10.5px] px-2 py-1 rounded-md shrink-0 flex items-center gap-1"
                            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                            {pinnedNames.includes(k.name) && <span style={{ color: "var(--primary-hover)" }}>★</span>}
                            /{k.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {active?.paneNeedsYou && (
                      // Answerable from here. The alternative shipped first and
                      // was telling someone to open a terminal to move a cursor
                      // one step, which is a dead end wearing instructions.
                      <PanePrompt chat={active} />
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
                            className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>Copy</button>
                          <button onClick={() => update(active.id, (c) => { c.setupNeeded = undefined; c.attention = "none"; })}
                            className="ml-auto text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)" }}>Dismiss</button>
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
                          Allow {active.blockedTool}
                        </button>
                        <button onClick={() => update(active.id, (c) => { c.blockedTool = undefined; })}
                          className="shrink-0 px-1 t-dim2 hover:opacity-70" aria-label="Dismiss">✕</button>
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
                            {/* Pinning lives here because this is the one place
                                every skill is listed. onMouseDown, and stopped,
                                so pinning does not also insert the command. */}
                            <button
                              onMouseDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); togglePin(k.name); }}
                              title={pinnedNames.includes(k.name) ? `Unpin /${k.name}` : `Pin /${k.name} to the quick strip`}
                              aria-label={pinnedNames.includes(k.name) ? `Unpin ${k.name}` : `Pin ${k.name}`}
                              className="ml-auto shrink-0 text-[10px] px-1 leading-none hover:opacity-100"
                              style={{ color: pinnedNames.includes(k.name) ? "var(--primary-hover)" : "var(--text3)", opacity: pinnedNames.includes(k.name) ? 1 : 0.55 }}
                            >★</button>
                          </div>
                        ))}
                        <div className="px-2.5 py-1 text-[9.5px] t-dim2" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                          ↑↓ Move · Tab or Enter to pick · keep typing to filter
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
                            <span className="shrink-0 text-[9.5px] t-dim2">Queued {i + 1}</span>
                            <span className="flex-1 truncate text-[11.5px]" style={{ color: "var(--text3)" }}>
                              {q.text || `${q.images.length} image${q.images.length > 1 ? "s" : ""}`}
                            </span>
                            {!!q.images.length && q.text && <span className="shrink-0 text-[9.5px] t-dim2">+{q.images.length} img</span>}
                            {/* Editing puts the text back in the composer,
                                which an attached image can't survive — so it
                                is only offered where nothing is lost. */}
                            {!q.images.length && (
                              <button onClick={() => unqueue(active.id, q.id, true)} title="Put this back in the composer"
                                className="shrink-0 text-[9.5px] t-dim2 hover:opacity-70">Edit</button>
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
                      <button onClick={() => fileRef.current?.click()} disabled={!canAttach || !active}
                        title={active?.agent === "codex"
                          ? "codex chats can't take attachments — start a Claude chat for that"
                          : "Attach a file — images are sent as images, text files are quoted into the message"}
                        aria-label="Attach a file"
                        className="shrink-0 grid place-items-center rounded-lg px-3 self-stretch"
                        style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text3)" }}>
                        <ClipIcon />
                      </button>
                      {/* Enabled with no chat open, because typing is how you
                          open one. The composer was disabled until you had
                          pressed + New, which put a working-looking input in
                          front of you that silently swallowed everything —
                          the empty state said "press + new" and the box said
                          "Message a new session…", and only one of them was
                          telling the truth. */}
                      <textarea ref={inputRef} aria-label="Chat composer" value={active?.draft ?? ""} disabled={!usable} rows={2}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (active) { update(active.id, (c) => { c.draft = v; }); return; }
                          // Only real text opens a chat. Otherwise clearing the
                          // box, or a stray empty change event, would leave a
                          // trail of blank tabs behind.
                          if (v) add(v);
                        }}
                        onKeyDown={onKey}
                        onPaste={onPaste}
                        placeholder={!usable ? `${agentLabel(active?.agent ?? "claude")} chat unavailable — no local \`${cliName(active?.agent ?? "claude")}\` CLI` : active?.sending ? "Still replying — type anyway, Enter queues it for the next turn" : active?.sessionId ? "Reply… (Enter to send, Shift+Enter newline)" : "Message a new session… (Enter to send)"}
                        className="agx-scroll flex-1 px-3 py-2 rounded-lg text-[12px] outline-none resize-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                      {/* Stop stays reachable while a turn is queueing: the
                          two are different intents — "answer this next" and
                          "drop what you're doing" — and hiding either one
                          behind the other is how you lose a turn you meant to
                          keep. */}
                      {active?.sending && (
                        <button onClick={() => stop(active.id)} title="Interrupt the turn and clear anything queued"
                          className="shrink-0 px-3.5 rounded-lg text-[11.5px] font-semibold self-stretch" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>■ Stop</button>
                      )}
                      <button onClick={submit} disabled={!hasTurn || !active?.cwd || !usable} className="shrink-0 px-4 rounded-lg text-[11.5px] font-semibold self-stretch" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", opacity: (!hasTurn || !active?.cwd) ? 0.45 : 1 }}>
                        {active?.sending ? "Queue ↵" : "Send ↵"}
                      </button>
                    </div>
                    <div className="mt-1.5 text-[9.5px] t-dim2">
                      {hint
                        ? <span style={{ color: "var(--warning)" }}>{hint}</span>
                        : <>Runs {cliName(active?.agent ?? "claude")} in {active ? repoName(active.cwd) || "the repo" : "the repo"} · {modesFor(active?.agent ?? "claude").find((x) => x.id === active?.mode)?.label} · tool calls fold away, click to open</>}
                      {active && active.mode === bypassMode(active.agent) && <span style={{ color: "var(--warning)" }}> · ⚡ runs tools unattended</span>}
                    </div>
                  </div>
                </div>
                </div>
      {/* The mid-turn close confirmation. Mounted here so it renders whether or
          not the panel is the active view. */}
      {dialog}
    </div>
  );
}
