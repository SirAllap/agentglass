// What is waiting on you, and what you can actually do about it — without
// leaving the view you were working in.
//
// The chip used to be a button that took you somewhere. First to the dashboard,
// which showed the same alert in a panel; then to the session, which for a chat
// meant the chat and for everything else meant SessionModal — a post-mortem
// headed WHAT IT DID, with counts of events and tools and money spent. That
// screen answers "what did this session do". The question on the strip is "what
// does it want now", and a read-only summary covering the terminal you were
// typing in is the worst possible answer to it: it moved you, and then it could
// not help.
//
// So the chip opens this instead. It stays out of the way (a small panel under
// the chip, nothing else disturbed), it says everything it knows — which agent,
// which project, the message in full, the directory it is running in — and it
// offers only the actions that genuinely exist. Where none exist it says so in
// a sentence rather than inventing a destination.
//
// Rows, not one item: with two agents waiting, "+1" on a chip you have to click
// twice to understand is worse than a list you read once.
import { useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import type { AgentPane } from "../../../shared/types.ts";
import { CloseButton } from "./CloseButton.tsx";
import { paneChoices } from "../lib/panePick.ts";

export type NeedsItem = {
  /** The agent card key this was raised from. Stable enough for a list key. */
  key: string;
  sessionId: string;
  /** Session title if it has one, else the app that raised it. */
  label: string;
  /** What it wants, in its own words. */
  because: string;
  /** How loud: an error reads differently from a question. */
  level: "warn" | "error";
  /** Where it is running, and the project that directory folds onto. */
  cwd: string | null;
  project: string | null;
  /** The project's display name, when it is not the one currently scoped. */
  otherProject: string | null;
  /** An in-app chat that can answer it, when there is one. */
  chatId: string | null;
  /** A permission hold the dashboard can approve. */
  gated: boolean;
};

/** `/home/me/code/x` reads as noise; `~/code/x` reads as a place. The browser
 *  has no idea what $HOME is, so this matches the shape rather than the value —
 *  which is also why it accepts the macOS spelling. */
const short = (p: string): string => {
  const m = p.match(/^\/(?:home|Users)\/[^/]+(\/.*)?$/);
  return m ? "~" + (m[1] ?? "") : p;
};

function Action({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] px-2 py-[3px] rounded"
      style={{
        color: primary ? "var(--bg)" : "var(--text2)",
        background: primary ? "var(--primary)" : "transparent",
        border: `1px solid ${primary ? "var(--primary)" : "var(--border2)"}`,
      }}
    >{children}</button>
  );
}

function Row({ it, exact, hits, onChat, onApprove, onProject, onPane }: {
  it: NeedsItem;
  /** The pane this very session reported being in, when it did. */
  exact: AgentPane | null;
  /** Panes running an agent in this session's directory. One is a button; more
   *  than one is a fact worth stating and not a choice worth guessing. */
  hits: AgentPane[];
  onChat: (chatId: string) => void;
  onApprove: () => void;
  onProject: (root: string) => void;
  onPane: (p: AgentPane) => void;
}) {
  const tint = it.level === "error" ? "var(--error)" : "var(--warning)";
  const pane = exact ?? (hits.length === 1 ? hits[0]! : null);
  const actionable = !!it.chatId || it.gated || !!it.otherProject || !!pane || hits.length > 0;
  return (
    <div className="agx-note-row">
      <div className="flex items-center gap-2 mb-1">
        <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: tint }} />
        <span className="text-[11.5px] font-semibold truncate" style={{ color: "var(--text)" }}>{it.label}</span>
        {/* Which project it belongs to, and only when that is NOT the one you
            have open. A cockpit watches every project at once, so an alert from
            another one is legitimate — but reading it as though it came from the
            project in front of you is how you go looking in the wrong tree. */}
        {it.otherProject && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-[1px] rounded shrink-0"
            style={{ color: "var(--text3)", border: "1px solid var(--border)" }}
            title={`This is not the project you have open — it lives in ${it.project}`}>
            {it.otherProject}
          </span>
        )}
      </div>
      {/* The message in full, wrapping. The chip truncates it to fit a 30px
          strip; this is the place it gets to be read. */}
      <div className="text-[11px]" style={{ color: "var(--text2)", overflowWrap: "anywhere" }}>{it.because}</div>
      {it.cwd && (
        <div className="text-[10px] mt-[3px] font-mono truncate" style={{ color: "var(--text4)" }} title={it.cwd}>{short(it.cwd)}</div>
      )}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {it.chatId && <Action primary onClick={() => onChat(it.chatId!)}>Open its chat</Action>}
        {it.gated && <Action primary={!it.chatId} onClick={onApprove}>Approve it</Action>}
        {/* The one that answers the original complaint: the agent is in a tmux
            pane, and now the app knows which. It moves tmux to it and shows the
            terminal, so you land on the prompt that is waiting rather than on a
            summary of what it did. */}
        {pane && (
          <Action primary={!it.chatId && !it.gated} onClick={() => onPane(pane)}>
            Go to its pane · {pane.windowName || pane.windowIndex}
          </Action>
        )}
        {/* Only where the pane was guessed from a directory. When the session
            named its own pane there is nothing to hedge about, and a caveat on
            a certain answer teaches you to distrust the certain ones. */}
        {pane && !exact && (
          <span className="text-[10px]" style={{ color: "var(--text4)" }} title="Matched by the directory the agent is running in — it is the only pane there">
            best guess
          </span>
        )}
        {/* Several agents in one directory is the normal case, not the odd one
            — five in a project is a working day. The app cannot tell them
            apart, and it does not have to: it knows the windows, and you named
            them. Offering the candidates is not guessing, and it beats a
            sentence that leaves you to find them yourself. */}
        {hits.length > 1 && <span className="text-[10px]" style={{ color: "var(--text4)" }}>in one of</span>}
        {hits.length > 1 && hits.slice(0, 4).map((p) => (
          <Action key={p.paneId} onClick={() => onPane(p)}>{p.windowName || `${p.session}:${p.windowIndex}`}</Action>
        ))}
        {it.otherProject && it.project && <Action onClick={() => onProject(it.project!)}>Switch to {it.otherProject}</Action>}
        {/* Honest about the gap rather than offering a button that lands
            somewhere useless. Naming the directory is the useful half of what a
            destination would have done: it tells you where to go yourself. */}
        {!actionable && (
          <span className="text-[10px]" style={{ color: "var(--text4)" }}>
            Nothing in here can answer this — it is waiting in a terminal of its own.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The panel under the chip.
 *
 * Anchored to the button rather than centred, and in a Portal, because the bar
 * clips its own overflow — it has to, or a long project name pushes the clock
 * off the end — and a panel drawn inside it would be sliced off at 30px.
 */
export function NeedsPopover({ anchorRef, open, items, onClose, onChat, onApprove, onProject, onTerminal }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  items: NeedsItem[];
  onClose: () => void;
  onChat: (chatId: string) => void;
  onApprove: () => void;
  onProject: (root: string) => void;
  /** Show the terminal, once tmux has been moved to the pane. */
  onTerminal: () => void;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [panes, setPanes] = useState<AgentPane[]>([]);

  // Asked when the panel opens, and only then. It is a `list-panes` plus a walk
  // of /proc per pane on the far side — cheap once and wasted on a timer, since
  // the answer is only read in the second between opening this and clicking
  // through it. Failure is silent on purpose: no pane found and no pane
  // offered are the same outcome here.
  useEffect(() => {
    if (!open) return;
    let dead = false;
    api.agentPanes().then((r) => { if (!dead) setPanes(r.panes ?? []); }).catch(() => {});
    return () => { dead = true; };
  }, [open]);

  const goPane = useCallback((p: AgentPane) => {
    void api.focusPane({ sessionId: p.sessionId, windowId: p.windowId, paneId: p.paneId })
      // The view switches either way. If tmux refused — the pane died between
      // the list and the click — the terminal is still where you were going,
      // and it will be showing whatever tmux is actually on.
      .catch(() => {})
      .finally(onTerminal);
  }, [onTerminal]);

  const place = useCallback(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 380;
    // Centred under the chip, then pulled back inside the window rather than
    // allowed to hang off the edge on a narrow one.
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), Math.max(8, window.innerWidth - width - 8));
    setAt({ top: r.bottom + 6, left });
  }, [anchorRef]);

  useEffect(() => {
    if (!open) return;
    place();
    // Capture, so Escape closes this before anything under it acts on the same
    // key — one Escape should undo one thing.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (anchorRef.current?.contains(t as Node)) return;
      if (panel.current?.contains(t as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place, onClose, anchorRef]);

  if (!open || !at || !items.length) return null;
  return (
    <Portal z={10055}>
      <div
        ref={panel}
        data-needs-panel=""
        className="fixed flex flex-col rounded-xl overflow-hidden"
        style={{
          top: at.top, left: at.left, width: 380,
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          boxShadow: "0 22px 48px -20px var(--shadow)",
        }}
      >
        <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>waiting on you</span>
          <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{items.length}</span>
          <CloseButton onClick={onClose} title="Close (Esc)" className="agx-note-btn ml-auto" />
        </div>
        <div className="agx-inbox-list">
          {items.map((it) => {
            const { exact, hits } = paneChoices(panes, it);
            return (
              <Row key={it.key} it={it} exact={exact} hits={hits}
                onChat={onChat} onApprove={onApprove} onProject={onProject} onPane={goPane} />
            );
          })}
        </div>
      </div>
    </Portal>
  );
}
