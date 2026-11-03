/*
 * The Go list: every project and every window, under the project chip.
 *
 * What needs you first, then the project you are in, then each of the others
 * with the switch that keeps it on the strip. Type to narrow, arrows and Enter
 * to go, Esc to leave. It is drawn from the windows the strip already holds, so
 * it is current without asking anyone: a window that starts waiting is a row in
 * "Needs you" on the same frame, and nothing re-reads on a timer.
 *
 * The cross-session palette (WindowSwitcher) stays for every window on the
 * machine from any view; this one is the project-scoped face of the same
 * decisions (lib/goList.ts over lib/windowSwitcher's nextWaiting).
 *
 * No open or close animation: it opens from a chord used all day, and a list
 * that fades in is a list that is late.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TabGroup } from "../../lib/tabGroups.ts";
import { goList, moveSelection, type GoRow, type GoSection } from "../../lib/goList.ts";
import { windowMark } from "../../lib/windowMark.ts";
import { altDigit } from "../../lib/termKeys.ts";
import { appChordFor, chordFromEvent } from "../../lib/keybindings.ts";
import { nextWaiting } from "../../lib/windowSwitcher.ts";
import { NO_DRAG } from "../../lib/dragRegion.ts";
import { LAYER } from "../../lib/layers.ts";
import { ICON } from "../../lib/iconSize.ts";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import { CaretIcon, PinIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import { Portal } from "../Portal.tsx";
import { Badge, Chip, EDGE, GROUP_HEADING, INPUT, INPUT_STYLE, LINE } from "../workspace/Chrome.tsx";
import { SessionSwitcher, type SessionInfo } from "./SessionSwitcher.tsx";
import { WindowMarkIcon } from "./WindowMarkIcon.tsx";

const WIDTH = 420;
const ROW_H = 30;
const GAP = 4;
const MARGIN = 8;

export function GoList({
  anchor, groups, current, kept, numbers, branches, projects, session, sessions, engine, prefix,
  onPick, onToggleKept, onSwitchSession, onManageSessions, onUseTmuxBar, onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  groups: readonly TabGroup[];
  current: string | null;
  kept: ReadonlySet<string>;
  numbers: ReadonlyMap<string, number>;
  branches: ReadonlyMap<string, string>;
  /** Tab groups are on: other projects can be kept in the strip. */
  projects: boolean;
  /** The tmux session on screen, and all of them: the footer chip opens the quick switcher. */
  session: string;
  sessions: readonly SessionInfo[];
  engine: boolean;
  prefix: readonly string[];
  onPick: (windowId: string) => void;
  onToggleKept: (key: string) => void;
  onSwitchSession: (name: string) => void;
  /** "Manage sessions…": the Go list closes first, then the dialog opens. */
  onManageSessions: () => void;
  onUseTmuxBar?: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [switcher, setSwitcher] = useState(false);
  // Held by window, not by position: the list re-sorts as statuses change, and
  // an index would be left pointing at whatever moved into the slot.
  const [selId, setSelId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const sessionBox = useRef<HTMLSpanElement>(null);
  useCloseWithOwner(onClose, { from: anchor });

  const list = useMemo(() => goList({ groups, current, kept, query: q, branches, numbers }), [groups, current, kept, q, branches, numbers]);
  const at = Math.max(0, list.rows.findIndex((r) => r.window.id === selId));
  const select = (i: number) => setSelId(list.rows[i]?.window.id ?? null);

  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(MARGIN, Math.min(r.left, window.innerWidth - WIDTH - MARGIN)), top: r.bottom + GAP });
  }, [anchor]);
  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      // Back to the pane the chord came from, if it is still there.
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected) back.focus();
    };
  }, []);
  useEffect(() => { setSelId(null); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const go = (r: GoRow | undefined) => { if (r) { onClose(); onPick(r.window.id); } };
  const onKey = (e: React.KeyboardEvent) => {
    // Every key in here is the list's: none reaches the app's shortcuts or the pane.
    e.stopPropagation();
    const chord = chordFromEvent(e.nativeEvent);
    if (chord && chord === appChordFor("windows.switcher")) { e.preventDefault(); onClose(); return; }
    if (chord && chord === appChordFor("windows.waiting")) {
      e.preventDefault();
      const i = nextWaiting(list.rows.map((r) => r.window), at);
      if (i >= 0) select(i);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "Enter") { e.preventDefault(); go(list.rows[at]); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); select(moveSelection(at, e.key, list.rows.length)); return; }
    // With Alt, so a digit typed into the filter is always part of it.
    const n = altDigit(e.nativeEvent);
    if (n) {
      const r = list.rows.find((x) => x.number === n);
      if (r) { e.preventDefault(); go(r); }
    }
  };

  const row = (r: GoRow, i: number) => {
    const m = windowMark({ name: r.window.name, status: r.window.status, flags: r.window.flags });
    const lit = i === at;
    return (
      <div key={r.window.id} data-row={i} role="option" aria-selected={lit}
        onMouseMove={() => { if (!lit) select(i); }}
        onClick={() => go(r)}
        className="flex items-center gap-2 px-2 mx-1 rounded-md cursor-pointer text-[11.5px]"
        style={{ height: ROW_H, background: lit ? "var(--surface-inset)" : "transparent" }}>
        <span className="shrink-0 w-3.5 flex justify-center">{m.mark && <WindowMarkIcon mark={m.mark} label={m.title} />}</span>
        <span className="min-w-0 truncate font-semibold" style={{ color: "var(--text)" }}>{r.window.name || "shell"}</span>
        {r.branch && <span className="min-w-0 truncate text-[10.5px]" style={{ color: "var(--text3)" }} title={r.branch}>{r.branch}</span>}
        <span className="ml-auto shrink-0 text-[10.5px]"
          style={{ color: m.mark === "needs-you" ? "var(--warning-ink)" : m.mark === "failed" ? "var(--error-ink)" : m.mark === "working" ? "var(--primary-ink)" : "var(--text3)", fontWeight: m.mark === "needs-you" ? 600 : undefined }}>
          {m.title}
        </span>
        {r.number && <kbd className="shrink-0 text-[10.5px] px-1 rounded" style={{ background: "var(--surface-inset)", color: "var(--text3)" }}>Alt+{r.number}</kbd>}
      </div>
    );
  };

  let seen = 0;
  const rowsOf = (rs: readonly GoRow[]) => rs.map((r) => row(r, seen++));
  const heading = (text: string, tint?: string) => (
    <div className={GROUP_HEADING} style={{ color: tint ?? "var(--text3)", fontWeight: 600 }}>{text}</div>
  );
  const other = (s: GoSection) => (
    <div key={s.key}>
      <div className="flex items-center gap-2 pr-2">
        <div className={`${GROUP_HEADING} min-w-0 truncate`} style={{ color: "var(--text3)", fontWeight: 600 }}>
          {s.label} <span className="font-normal tabular-nums">{s.count}</span>
        </div>
        {projects && (
          <Chip compact pressed={s.kept} onClick={() => onToggleKept(s.key)} className="ml-auto"
            title={s.kept ? `${s.label} stays in the strip` : `Keep ${s.label} in the strip`}
            style={s.kept ? { color: "var(--primary-ink)" } : undefined}>
            <PinIcon size={ICON.xs} filled={s.kept} />{s.kept ? "Kept in strip" : "Keep in strip"}
          </Chip>
        )}
      </div>
      {rowsOf(s.rows)}
    </div>
  );

  return (
    <Portal z={LAYER.menu}>
      {/* The catcher, over the whole window: a click outside closes the list
          and does not land on what is underneath. */}
      <div className="fixed inset-0" style={NO_DRAG} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        role="dialog" aria-label="Projects and windows" onKeyDown={onKey}
        className="fixed flex flex-col overflow-hidden rounded-xl"
        style={{
          left: pos?.left ?? MARGIN, top: pos?.top ?? 0, width: WIDTH, maxWidth: `calc(100vw - ${2 * MARGIN}px)`,
          visibility: pos ? "visible" : "hidden",
          background: "var(--bg)", border: EDGE, boxShadow: "0 18px 40px -16px color-mix(in srgb, #000 55%, transparent)",
        }}>
        <div className="p-1.5 shrink-0" style={{ borderBottom: LINE }}>
          <div className="relative">
            <span className="flex absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.xs} /></span>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
              spellCheck={false} autoComplete="off" placeholder="Go to a window or project"
              role="combobox" aria-expanded="true" aria-controls="agx-go-list" aria-label="Go to a window or project"
              aria-activedescendant={list.rows[at] ? `agx-go-${list.rows[at]!.window.id}` : undefined}
              className={`w-full ${INPUT} pl-8`} style={INPUT_STYLE} />
          </div>
        </div>
        <div ref={listRef} id="agx-go-list" role="listbox" aria-label="Windows" className="overflow-y-auto agx-scroll py-1 min-h-0" style={{ maxHeight: 440 }}>
          {list.rows.length === 0 ? (
            <div className="px-3 py-3 text-[11.5px]" style={{ color: "var(--text3)" }}>{q ? `No window matches “${q}”.` : "No windows."}</div>
          ) : (
            <>
              {list.needsYou.length > 0 && <>{heading("Needs you", "var(--warning-ink)")}{rowsOf(list.needsYou)}</>}
              {list.here && (
                <div>
                  <div className="flex items-center gap-2 pr-2">
                    <div className={`${GROUP_HEADING} min-w-0 truncate`} style={{ color: "var(--text3)", fontWeight: 600 }}>
                      {list.here.label} <span className="font-normal tabular-nums">{list.here.count}</span>
                    </div>
                    <span className="uppercase"><Badge tint="var(--text3)" tight>here</Badge></span>
                  </div>
                  {rowsOf(list.here.rows)}
                </div>
              )}
              {list.others.map(other)}
            </>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 text-[10.5px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
          <span ref={sessionBox} className="flex">
            <Chip compact title="Which tmux session this is, and the others"
              onClick={() => setSwitcher((o) => !o)}>
              <span className="min-w-0 truncate max-w-[14rem]">{session}</span><CaretIcon size={ICON.xs} />
            </Chip>
          </span>
          <span className="tabular-nums">{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span>
          <span className="ml-auto flex items-center gap-1" aria-hidden="true">
            {["↑↓", "Enter", "Esc"].map((k) => <kbd key={k} className="px-1 rounded" style={{ background: "var(--surface-inset)" }}>{k}</kbd>)}
          </span>
        </div>
      </div>
      {switcher && (
        <SessionSwitcher anchor={sessionBox} current={session} sessions={sessions} engine={engine} prefix={prefix}
          onSwitch={onSwitchSession} onUseTmuxBar={onUseTmuxBar}
          onManage={() => { onClose(); onManageSessions(); }}
          onClose={() => setSwitcher(false)} />
      )}
    </Portal>
  );
}
