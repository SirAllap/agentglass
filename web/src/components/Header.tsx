import { useEffect, useState, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import type { ConnState } from "../lib/useLive.ts";
import { IS_DEMO, reauthPrompt } from "../lib/api.ts";
import { MOD_KEY } from "../lib/format.ts";
import { IS_MAC_DESKTOP } from "../lib/desktop.ts";
import { ThemeSwitcher } from "./ThemeSwitcher.tsx";
import { UsageWidget } from "./UsageWidget.tsx";
import { Logo } from "./Logo.tsx";
import { Select } from "./Select.tsx";
import { subscribe as subscribeChats, attentionCount } from "../lib/chatStore.ts";
import { WorkspaceIcon } from "./workspace/icons.tsx";

// The long windows matter once history isn't pruned: the transcript scan can
// backfill months of sessions, and a 7d ceiling would hide most of the fleet.
const WINDOWS = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "6h", ms: 6 * 3_600_000 },
  { label: "24h", ms: 24 * 3_600_000 },
  { label: "7d", ms: 7 * 86_400_000 },
  { label: "30d", ms: 30 * 86_400_000 },
  { label: "all", ms: 3650 * 86_400_000 },
];

// Shared by the header's pill-shaped controls (filters, search button).
const selStyle = { background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text2)" };

const svg = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function IconBtn({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="h-8 w-8 grid place-items-center rounded-lg transition-colors"
      style={{
        border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
        background: active ? "color-mix(in srgb, var(--primary) 20%, transparent)" : "color-mix(in srgb, var(--bg3) 30%, transparent)",
        color: active ? "var(--primary-hover)" : "var(--text3)",
      }}
    >
      {children}
    </button>
  );
}

function SkillsIcon() {
  return (
    <svg {...svg}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

/* The git/diff/docker/terminal/chat glyphs moved to workspace/icons.tsx when
   their five buttons became one — the rail needs them too. */

/** Settings button — the overflow menu became a real modal (SettingsModal),
 *  because a flat list of one-liners could not show a toggle's state without
 *  spelling it out in the label. */
function MoreMenu({ onOpen }: { onOpen: () => void }) {
  return (
    <button title="Settings — preferences, exports, shortcuts" onClick={onOpen}
      className="h-8 w-8 grid place-items-center rounded-lg text-[15px]"
      style={{
        border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
        background: "color-mix(in srgb, var(--bg3) 30%, transparent)",
        color: "var(--text3)",
      }}>
      ⋯
    </button>
  );
}

export function Header({
  conn, windowMs, onWindow, apps, types, providers, filter, onFilter, theme, onTheme,
  sound, onSound, onOpenPalette, onOpenHelp, onOpenStats, onOpenSkills, onOpenWorkspace, onOpenSettings, onClear, showUsage,
  workspace, onOpenProject,
}: {
  conn: ConnState;
  windowMs: number;
  onWindow: (ms: number) => void;
  apps: string[];
  types: string[];
  providers: string[];
  filter: { app: string; type: string; provider: string };
  onFilter: (f: { app: string; type: string; provider: string }) => void;
  theme: string;
  onTheme: (id: string) => void;
  sound: boolean;
  onSound: () => void;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
  onOpenStats: () => void;
  onOpenSkills: () => void;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onClear: () => void;
  showUsage: boolean;
  workspace: string | null;
  onOpenProject: () => void;
}) {
  const live = conn === "open";
  // Subscribed rather than polled: a reply arriving is exactly when this can
  // change, and the store already notifies on it.
  const waiting = useSyncExternalStore(subscribeChats, attentionCount, attentionCount);
  const unauth = conn === "unauthorized";
  const pillColor = live ? "var(--success)" : unauth ? "var(--error)" : "var(--warning)";
  const hasFilter = filter.app || filter.type || filter.provider;

  return (
    <header data-tauri-drag-region="" className="flex items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5 shrink-0 relative z-20 flex-wrap sm:flex-nowrap"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", background: "color-mix(in srgb, var(--bg2) 94%, var(--bg))", paddingLeft: IS_MAC_DESKTOP ? 76 : undefined }}>
      <div data-tauri-drag-region="" className="flex items-center gap-2.5 shrink-0">
        <motion.span initial={{ rotate: -20, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 200 }} className="flex pointer-events-none">
          <Logo size={26} title="agentglass" />
        </motion.span>
        <div className="leading-none pointer-events-none">
          <div className="text-[16px] font-bold tracking-tight" style={{ color: "var(--text)" }}>agent<span style={{ color: "var(--primary)" }}>glass</span></div>
        </div>
        {/* The project defines what every other number on screen means, so it
            reads as a control in its own right rather than a caption under the
            wordmark — at that size it was easy to miss that the scope was even
            settable, let alone what it was set to. */}
        <button onClick={onOpenProject}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium shrink-0 transition-opacity hover:opacity-80"
          title={workspace ? `${workspace}\nclick to switch project` : "click to open a project — the cockpit scopes itself to its folder"}
          style={{
            color: workspace ? "var(--primary-hover)" : "var(--text2)",
            background: `color-mix(in srgb, var(--primary) ${workspace ? 14 : 7}%, transparent)`,
            border: `1px solid color-mix(in srgb, var(--primary) ${workspace ? 40 : 20}%, transparent)`,
          }}>
          <span>⌂</span>
          <span className="truncate" style={{ maxWidth: 200 }}>{workspace ? workspace.split("/").pop() : "every project"}</span>
          <span className="opacity-60">▾</span>
        </button>
        <span onClick={unauth ? reauthPrompt : undefined}
          title={unauth ? "This server needs an access token — click to enter it" : undefined}
          className={`flex items-center gap-1.5 ml-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${unauth ? "cursor-pointer" : ""}`}
          style={{ color: pillColor, background: `color-mix(in srgb, ${pillColor} 14%, transparent)` }}>
          <span className="relative flex h-1.5 w-1.5">
            {live && <span className="absolute inline-flex h-full w-full rounded-full opacity-70" style={{ background: "var(--success)", animation: "ping-ring 1.6s ease-out infinite" }} />}
            <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: pillColor }} />
          </span>
          {live ? "LIVE" : unauth ? "UNAUTHORIZED ⚿" : conn.toUpperCase()}
        </span>
        {IS_DEMO && (
          <a
            href="https://github.com/SirAllap/agentglass"
            target="_blank"
            rel="noreferrer"
            title="This is a live demo with sample data — nothing here is real. Click for the repo."
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
            style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}
          >
            ✦ DEMO<span className="hidden sm:inline"> · sample data</span>
          </a>
        )}
      </div>

      {/* Middle zone: fills the free space and scrolls sideways instead of
          wrapping, so the header stays a single line at any width / zoom.
          On phones it drops to its own full-width second row — otherwise the
          right-side controls get pushed off-screen and become unreachable. */}
      <div data-tauri-drag-region="" className="flex items-center gap-2 grow min-w-0 overflow-x-auto agw-noscrollbar order-3 basis-full sm:order-none sm:basis-0">
      <div className="flex items-center gap-0.5 p-0.5 rounded-lg shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 35%, transparent)" }}>
        {WINDOWS.map((w) => (
          <button key={w.label} onClick={() => onWindow(w.ms)} className="px-2 py-1 rounded-md text-[11px] transition-all"
            style={windowMs === w.ms ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--primary-hover)" } : { color: "var(--text4)" }}>
            {w.label}
          </button>
        ))}
      </div>

      {/* max-w keeps long worktree names (e.g. feature-branch-…) from blowing the header open */}
      {/* The app filter and the project scope answer the same question — "whose
          data is this?" — so with a project open it is a weaker duplicate of a
          control that already applies, offering a list of one. It earns its
          place only in the whole-machine view. */}
      {!workspace && (
        <Select value={filter.app} style={selStyle} options={[{ value: "", label: "all apps" }, ...apps.map((a) => ({ value: a, label: a }))]} onChange={(v) => onFilter({ ...filter, app: v })} />
      )}
      <Select value={filter.type} style={selStyle} options={[{ value: "", label: "all events" }, ...types.map((t) => ({ value: t, label: t }))]} onChange={(v) => onFilter({ ...filter, type: v })} />
      {/* Provider is auto-detected from each session's model. With one provider
          it's shown but disabled (just so you can see it); a mixed fleet
          (Anthropic + OpenAI + …) turns it into a real filter. */}
      {providers.length === 1 && (
        <Select value={providers[0]} style={selStyle} options={[{ value: providers[0], label: providers[0] }]} onChange={() => {}} disabled title={`only provider seen: ${providers[0]}`} />
      )}
      {providers.length > 1 && (
        <Select value={filter.provider} style={selStyle} options={[{ value: "", label: "all providers" }, ...providers.map((p) => ({ value: p, label: p }))]} onChange={(v) => onFilter({ ...filter, provider: v })} />
      )}
      {hasFilter && <button onClick={onClear} className="text-[11px] px-2 py-1 rounded-lg shrink-0 whitespace-nowrap" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>clear ✕</button>}
      </div>{/* middle scroll zone */}

      <div data-tauri-drag-region="" className="shrink-0 flex items-center gap-1.5 sm:gap-2 ml-auto sm:ml-0 max-w-full overflow-x-auto agw-noscrollbar">
        {/* Anthropic plan meters — only shown when viewing Anthropic (it's the
            one provider with a usage API), and only where there's room. */}
        {showUsage && <div className="hidden 2xl:block"><UsageWidget /></div>}
        {/* A keyboard-palette chip is dead weight on touch — hide it there. */}
        <button onClick={onOpenPalette} className="h-8 hidden sm:flex items-center gap-1.5 px-2.5 rounded-lg text-[11px]" style={selStyle}>
          <span>{MOD_KEY}K</span><span className="hidden sm:inline t-dim2">search</span>
        </button>
        {/* One button where there were five (git/diff/docker/term/chat).
            They were the app's whole purpose and yet each one opened its own
            modal, so moving between them meant closing and reopening — the
            rail inside the workspace does that switching now, for free.
            The letter keys still deep-link straight to a view, so this button
            only serves the mouse.
            It also inherits the chat button's attention state: a reply that
            landed while you were elsewhere has to be visible from the
            dashboard, and this is the only door left. */}
        <button
          onClick={onOpenWorkspace}
          title={waiting
            ? `Workspace — ${waiting} chat${waiting === 1 ? "" : "s"} replied while you were elsewhere (${MOD_KEY}\\)`
            : `Workspace — git, diff, docker, terminal, chat (${MOD_KEY}\\)`}
          className="h-8 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-semibold"
          style={{
            color: waiting ? "var(--success)" : "var(--primary-hover)",
            background: `color-mix(in srgb, ${waiting ? "var(--success)" : "var(--primary)"} 18%, transparent)`,
            border: `1px solid color-mix(in srgb, ${waiting ? "var(--success)" : "var(--primary)"} ${waiting ? 70 : 50}%, transparent)`,
            animation: waiting ? "agx-attention 1.8s ease-in-out infinite" : undefined,
          }}
        >
          <WorkspaceIcon />
          <span className="hidden sm:inline">workspace</span>
          {waiting > 0 && (
            <span className="tabular-nums px-1 rounded-full text-[9.5px]"
              style={{ background: "color-mix(in srgb, var(--success) 30%, transparent)" }}>{waiting}</span>
          )}
        </button>
        {/* Skills demoted to a plain icon */}
        <IconBtn title="Skills explorer — browse every available skill (k)" onClick={onOpenSkills}><SkillsIcon /></IconBtn>
        <MoreMenu onOpen={onOpenSettings} />
        <ThemeSwitcher current={theme} onChange={onTheme} />
      </div>
    </header>
  );
}
