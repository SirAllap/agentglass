/*
 * The Terminal's strip: 32px, left to right
 *
 *   [project chip] | windows ... + | (prefix hint) ......... [n need you] [pins] [commands] [gear]
 *
 * A project is a space. The chip names the one you are in and opens the Go
 * list; the tabs are its windows, plus those of the projects you chose to keep
 * on the strip, each behind a small label. Every decision about what goes where
 * is a tested module (lib/stripZones, windowMark, goList, needYouJump,
 * prefixArmed); this file is the drawing and the pointer and keyboard glue.
 *
 * TerminalPanel owns the tmux door and passes it in as `cmd`: nothing here
 * talks to tmux by any other route, and "which window is active" is always
 * tmux's answer coming back, never a guess made here.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { subscribeViewModal, takeViewModal } from "../../lib/viewModalIntent.ts";
import type { TmuxWindow } from "../../../../shared/types.ts";
import type { TmuxCmdBody } from "../../lib/tmuxCmd.ts";
import { OTHER, type TabGroup } from "../../lib/tabGroups.ts";
import { stripZones, type StripItem } from "../../lib/stripZones.ts";
import { peekSentence, prText } from "../../lib/peekCard.ts";
import { windowMark } from "../../lib/windowMark.ts";
import { needYouJump } from "../../lib/needYouJump.ts";
import { branchPr, windowBranches } from "../../lib/windowGit.ts";
import { altDigit } from "../../lib/termKeys.ts";
import { registerStripDoors } from "../../lib/termStripHost.ts";
import { appChordFor, chordLabel } from "../../lib/keybindings.ts";
import { edgeMask, useTabStripScroll } from "../../lib/tabStrip.ts";
import { keepTermFocus } from "../../lib/keepFocus.ts";
import { BellIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { ContextMenu, MenuItem } from "../ContextMenu.tsx";
import type { ConfirmSpec } from "../ConfirmDialog.tsx";
import { CTRL_H, INPUT, INPUT_STYLE, LINE, tintEdge } from "../workspace/Chrome.tsx";
import { GoList } from "./GoList.tsx";
import { ProjectChip } from "./ProjectChip.tsx";
import { ManageSessions } from "./ManageSessions.tsx";
import type { SessionInfo } from "./SessionSwitcher.tsx";
import { PeekCard, usePeek } from "./PeekCard.tsx";
import { PlusButton, type PlusProps } from "./PlusButton.tsx";
import { WindowTab } from "./WindowTab.tsx";

/** The strip's own frame: the fallback shell strip and the row shown while tmux
 *  draws its own bar use it too, so the Terminal has one chrome. */
export function StripFrame({ armed = false, children, onMouseDown }: { armed?: boolean; children: ReactNode; onMouseDown?: React.MouseEventHandler }) {
  return (
    <div onMouseDown={onMouseDown} className="shrink-0 relative flex items-center gap-1 px-2"
      style={{ height: CTRL_H.large, borderBottom: LINE, background: "var(--surface-nav)" }}>
      {children}
      {/* Prefix armed: tmux is waiting for the rest of the sequence. A thin
          halo on the strip's bottom edge, lit at once (a fade-in would be late
          for a key pressed this second) and let go softly. */}
      <div aria-hidden className="absolute inset-x-0 pointer-events-none motion-reduce:transition-none"
        style={{
          bottom: -1, height: 2, opacity: armed ? 1 : 0, transition: armed ? "none" : "opacity 120ms ease-out",
          background: "linear-gradient(90deg, transparent, color-mix(in srgb, var(--primary) 18%, transparent), color-mix(in srgb, var(--primary) 82%, transparent), color-mix(in srgb, var(--primary) 18%, transparent), transparent)",
          boxShadow: "0 0 14px 1px color-mix(in srgb, var(--primary) 55%, transparent), 0 6px 18px -4px color-mix(in srgb, var(--primary) 35%, transparent)",
        }} />
    </div>
  );
}

type AskText = (spec: ConfirmSpec & { input: NonNullable<ConfirmSpec["input"]> }) => Promise<string | null>;

export interface TermStripProps {
  /** The Terminal view is on screen: only then do its keys and chords answer. */
  shown: boolean;
  windows: readonly TmuxWindow[];
  /** By project, in strip order. One entry when tab groups are off or all share a folder. */
  groups: readonly TabGroup[];
  /** Tab groups are on: labels, the project menu, keeping a project open. */
  projects: boolean;
  active: string | null;
  activeGroup: string | null;
  kept: ReadonlySet<string>;
  onToggleKept: (key: string) => void;
  session: { name: string; list: readonly SessionInfo[]; engine: boolean; prefix: readonly string[] };
  phones: number;
  clientCols: number | null;
  /** The prefix chord was pressed and tmux is waiting for the next key. */
  prefixArmed: boolean;
  root: string;
  focusWin: string;
  cmd: (body: TmuxCmdBody) => void;
  /** Every close goes here (x, middle click, menus, Close all): it asks only when an agent would stop, and offers Reopen after. */
  closeWindows: (ids: readonly string[], opts?: { anchor?: Element | null; project?: string }) => void;
  /** Select a window and hand the keyboard back to the pane. */
  onPick: (id: string) => void;
  focusTerm: () => void;
  askText: AskText;
  /** Give tmux its own status line back; absent on the engine. */
  onUseTmuxBar?: () => void;
  /** What the "+" menu starts; the strip adds the root and the tooltip. */
  plus: Omit<PlusProps, "root" | "title">;
  /** The pull request of the focused window's branch ("#318 open"), when the panel has read it. */
  activePr?: string | null;
  /** Reconnect, pins, commands, gear: what sits at the right end. */
  right: ReactNode;
}

/** The mark a tab draws: what the server knows about the pane first, then the agent's status. */
const tabMark = (w: TmuxWindow) =>
  windowMark({ name: w.name || "shell", status: w.status, flags: w.flags, dead: w.dead, exitCode: w.exit, restored: w.restored, wasRunning: w.was });

export function TermStrip(p: TermStripProps) {
  const { windows, groups, projects, active, kept, cmd, onPick, focusTerm } = p;
  const lockedSession = p.session.list.find((s) => s.name === p.session.name)?.locked === true;
  const zones = useMemo(
    () => stripZones({ groups, current: p.activeGroup, kept, locked: lockedSession }),
    [groups, p.activeGroup, kept, lockedSession],
  );
  const groupOfWindow = useMemo(() => {
    const m = new Map<string, TabGroup>();
    for (const g of groups) for (const w of g.windows) m.set(w.id, g);
    return m;
  }, [groups]);
  /* Branch per window, read when somebody looks (the Go list opening, a peek
     card), never on a timer: lib/windowGit.ts. */
  const [branches, setBranches] = useState<ReadonlyMap<string, string>>(new Map());
  const [goOpen, setGoOpen] = useState(false);
  useEffect(() => {
    if (!goOpen) return;
    let live = true;
    void windowBranches(windows).then((m) => { if (live) setBranches(m); });
    return () => { live = false; };
    // The windows as they are when the list opens; the list does not re-read while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goOpen]);
  const [manageOpen, setManageOpen] = useState(false);
  useEffect(() => {
    const run = () => { if (takeViewModal("terminal.sessions")) setManageOpen(true); };
    run();
    return subscribeViewModal(run);
  }, []);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [projMenu, setProjMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  // Keyed by tmux's window id, not the index: a rename in flight must follow the
  // window even if killing another one renumbers the strip underneath it.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [alt, setAlt] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  // A menu whose window or project has gone closes, rather than staying in
  // state with nothing drawn and popping back up when one of that name returns.
  useEffect(() => {
    if (tabMenu && !windows.some((w) => w.id === tabMenu.id)) setTabMenu(null);
    if (projMenu && !groups.some((g) => g.key === projMenu.key)) setProjMenu(null);
  }, [windows, groups, tabMenu, projMenu]);

  /*
   * `prefix ,` and `prefix .`, arriving from tmux.
   *
   * While this strip owns the bar there is no row for tmux to prompt in, so the
   * keys leave a note on the window instead and the server forwards it once.
   * Opening our own input here is what makes the takeover honest: the keys
   * people already have in their fingers keep working, and they land in a box
   * that looks like the rest of the app. The server clears the note as it
   * forwards it, so this fires once per press.
   */
  useEffect(() => {
    const asked = windows.find((w) => w.ask);
    if (!asked) return;
    if (asked.ask === "rename") { setMoving(null); setRenaming(asked.id); }
    else { setRenaming(null); setMoving(asked.id); }
  }, [windows]);

  const jump = useMemo(() => needYouJump(windows, active), [windows, active]);

  // Alt held shows the numbers; Alt+1..9 goes to that window. While the Go list
  // is open the keys are its own (it stops them before they get here).
  const goNumber = (n: number): boolean => {
    const id = [...zones.numbers].find(([, no]) => no === n)?.[0];
    if (!id) return false;
    onPick(id);
    return true;
  };
  const goNumberRef = useRef(goNumber);
  goNumberRef.current = goNumber;
  useEffect(() => {
    if (!p.shown) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAlt(true);
      const n = altDigit(e);
      if (n && goNumberRef.current(n)) { e.preventDefault(); e.stopPropagation(); }
    };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAlt(false); };
    const off = () => setAlt(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", off); setAlt(false); };
  }, [p.shown]);

  // The app's chords (Ctrl+Alt+J / Ctrl+Alt+N / Ctrl+Shift+T) answer through here.
  const doorsRef = useRef({ jump, newShell: () => {} });
  doorsRef.current = {
    jump,
    newShell: () => cmd({ cmd: "new", root: p.root, window: p.focusWin || undefined }),
  };
  useEffect(() => {
    if (!p.shown) return;
    return registerStripDoors({
      goList: () => setGoOpen((o) => !o),
      needYou: () => { const id = doorsRef.current.jump; if (!id) return false; onPick(id); return true; },
      newShell: () => doorsRef.current.newShell(),
    });
  }, [p.shown, onPick]);

  const showNumbers = alt || p.prefixArmed;
  // Alt numbers the strip's tabs (its own order); the armed prefix numbers what
  // the digit will actually do, which is tmux's own window index.
  const numberOf = (w: TmuxWindow): number | null => {
    if (!showNumbers) return null;
    if (p.prefixArmed) return w.index >= 0 && w.index <= 9 ? w.index : null;
    return zones.numbers.get(w.id) ?? null;
  };

  const tabStrip = useTabStripScroll(active,
    windows.map((w) => `${w.id}:${w.name}:${w.status ?? ""}:${w.pinned ? 1 : 0}:${w.flags.includes("!") ? 1 : 0}`).join("|")
    + `#${groups.map((g) => g.key).join(",")}:${[...kept].join(",")}:${showNumbers ? 1 : 0}`);

  // The peek card: what the window under the pointer is, after a breath.
  const peek = usePeek(tabStrip.el);
  const peekWin = peek.id ? windows.find((w) => w.id === peek.id) : undefined;
  const [peekGit, setPeekGit] = useState<{ id: string; branch: string | null; pr: string | null } | null>(null);
  useEffect(() => {
    if (!peekWin) return;
    let live = true;
    void (async () => {
      const branch = (await windowBranches([peekWin])).get(peekWin.id) ?? null;
      const pr = branch && peekWin.repo ? await branchPr(peekWin.repo, branch).catch(() => null) : null;
      if (live) setPeekGit({ id: peekWin.id, branch, pr: pr ? prText(pr) : null });
    })();
    return () => { live = false; };
  }, [peekWin?.id]);

  // The tabs slide in 160ms when the project changes. Not on the first draw, not
  // on a window change inside a project, and not at all with reduced motion
  // (the stylesheet turns the animation off).
  const swapKey = zones.chip?.key ?? "";
  const lastSwap = useRef(swapKey);
  useEffect(() => {
    const el = tabStrip.el;
    if (!el || lastSwap.current === swapKey) { lastSwap.current = swapKey; return; }
    lastSwap.current = swapKey;
    el.classList.remove("agx-strip-swap");
    void el.offsetWidth;
    el.classList.add("agx-strip-swap");
  }, [swapKey, tabStrip.el]);

  /* ---- drag and drop: the tab sends the same `move` the number box does. ---- */
  const dropOnProject = (g: TabGroup) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || groupOfWindow.get(dragging)?.key === g.key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropOn(`group:${g.key}`);
    },
    onDragLeave: () => setDropOn((cur) => (cur === `group:${g.key}` ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragging;
      setDragging(null); setDropOn(null);
      if (from && groupOfWindow.get(from)?.key !== g.key) cmd({ cmd: "group", window: from, name: g.label });
    },
  });
  const dnd = (w: TmuxWindow) => ({
    onDragStart: (e: React.DragEvent) => {
      setDragging(w.id);
      e.dataTransfer.effectAllowed = "move";
      // A drag carrying no data at all is refused outright by some targets.
      try { e.dataTransfer.setData("text/plain", w.id); } catch { /* not fatal */ }
    },
    onDragEnd: () => { setDragging(null); setDropOn(null); },
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || dragging === w.id) return;
      // Without this the drop never fires: the default is "not a drop target".
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Over another project's tab the drop regroups rather than reorders, so
      // it lights the project, not the insert line.
      const to = groupOfWindow.get(w.id);
      setDropOn(projects && to && groupOfWindow.get(dragging)?.key !== to.key ? `group:${to.key}` : w.id);
    },
    onDragLeave: () => setDropOn((cur) => (cur === w.id ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragging;
      setDragging(null); setDropOn(null);
      if (!from || from === w.id) return;
      // Onto a tab of ANOTHER project it joins that project and keeps its
      // index: moving it in tmux as well would reorder projects nobody touched.
      const to = groupOfWindow.get(w.id);
      if (projects && to && groupOfWindow.get(from)?.key !== to.key) { cmd({ cmd: "group", window: from, name: to.label }); return; }
      cmd({ cmd: "move", window: from, name: String(w.index) });
    },
  });

  const handBack = () => focusTerm();
  const tabEl = (id: string) => document.querySelector(`[data-window="${id}"]`);
  const renderTab = (it: Extract<StripItem, { kind: "tab" }>) => {
    const w = it.window;
    return (
      <WindowTab key={w.id} w={w}
        active={w.id === active}
        mark={tabMark(w)}
        no={numberOf(w)}
        dragging={dragging === w.id}
        dropBefore={dropOn === w.id && !!dragging && dragging !== w.id}
        renaming={renaming === w.id} moving={moving === w.id}
        clientCols={p.clientCols}
        dnd={dnd(w)}
        onSelect={() => onPick(w.id)}
        onClose={() => p.closeWindows([w.id], { anchor: tabEl(w.id) })}
        onStartRename={() => setRenaming(w.id)}
        onRename={(name) => {
          setRenaming(null);
          // Escape and Enter both hand the keyboard back to the pane rather
          // than leaving it on the vanishing input.
          if (name === null) return;
          if (name && name !== w.name) cmd({ cmd: "rename", window: w.id, name });
          handBack();
        }}
        onMove={(to) => {
          setMoving(null);
          if (to === null) return;
          if (/^\d{1,3}$/.test(to) && Number(to) !== w.index) cmd({ cmd: "move", window: w.id, name: to });
          handBack();
        }}
        onMenu={(x, y) => setTabMenu({ id: w.id, x, y })} />
    );
  };

  const label = (it: Extract<StripItem, { kind: "label" }>) => {
    const g = groups.find((x) => x.key === it.key);
    return (
      <span key={`label:${it.key}`} {...(g ? dropOnProject(g) : null)}
        onContextMenu={(e) => { e.preventDefault(); setProjMenu({ key: it.key, x: e.clientX, y: e.clientY }); }}
        className="shrink-0 pl-2 ml-1.5 mr-0.5 text-[10px] uppercase tracking-wider font-semibold select-none"
        style={{
          color: "var(--text3)", borderLeft: LINE, height: CTRL_H.compact, lineHeight: `${CTRL_H.compact}px`,
          background: g && dropOn === `group:${g.key}` && dragging ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined,
        }}
        title={`${it.name} — kept in the strip. Right-click for its menu; drop a tab here to move it into ${it.name}.`}>
        <span className="max-w-[14ch] truncate inline-block align-bottom">{it.name}</span>
      </span>
    );
  };

  const onTablistKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : 0;
    if (!dir) return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    const to = dir === "first" ? tabs[0] : dir === "last" ? tabs[tabs.length - 1] : tabs[i + dir];
    if (to) { e.preventDefault(); to.focus(); }
  };

  /* ---- menus ---- */
  const tabMenuNode = (() => {
    if (!tabMenu) return null;
    const w = windows.find((x) => x.id === tabMenu.id);
    if (!w) return null;
    const mine = groupOfWindow.get(w.id);
    const close = () => setTabMenu(null);
    return (
      <ContextMenu x={tabMenu.x} y={tabMenu.y} plain onClose={close}>
        <div className="px-2 pb-1 pt-0.5 text-[10px] tracking-wider uppercase truncate" style={{ color: "var(--text4)" }}>{w.name || "shell"}</div>
        {/* Always offered: a menu that only showed Pin once a project existed
            read as a missing feature on a fresh strip, and the hint on the tab
            promises it. */}
        <MenuItem onClick={() => { close(); cmd({ cmd: "pin", window: w.id, after: !w.pinned }); }}>
          {w.pinned ? "Unpin" : projects ? "Pin first in its project" : "Pin first"}
        </MenuItem>
        <MenuItem onClick={() => { close(); setRenaming(w.id); }}>Rename</MenuItem>
        {projects && (
          <>
            <div className="px-2 pt-1 text-[10px] tracking-wider uppercase" style={{ color: "var(--text4)" }}>Move to project</div>
            {w.group && <MenuItem onClick={() => { close(); cmd({ cmd: "group", window: w.id }); }}>Back to its folder's project</MenuItem>}
            {groups.filter((g) => g.key !== mine?.key).map((g) => (
              <MenuItem key={g.key} onClick={() => { close(); cmd({ cmd: "group", window: w.id, name: g.label }); }}>{g.label}</MenuItem>
            ))}
            {/* A project of its own, named here. Enter sets it. */}
            <div className="px-2 py-1">
              <input placeholder="New project…" spellCheck={false} aria-label="Move to a new project named"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const name = (e.target as HTMLInputElement).value.trim();
                  if (!name) return;
                  close();
                  cmd({ cmd: "group", window: w.id, name });
                }}
                className={`w-full ${INPUT}`} style={INPUT_STYLE} />
            </div>
          </>
        )}
        <div className="my-0.5" style={{ borderTop: LINE }} />
        <MenuItem danger onClick={() => { close(); p.closeWindows([w.id], { anchor: tabEl(w.id) }); }}>Close window</MenuItem>
      </ContextMenu>
    );
  })();

  const projMenuNode = (() => {
    if (!projMenu) return null;
    const g = groups.find((x) => x.key === projMenu.key);
    if (!g) return null;
    const close = () => setProjMenu(null);
    const isHere = g.key === p.activeGroup;
    return (
      <ContextMenu x={projMenu.x} y={projMenu.y} plain onClose={close}>
        <div className="px-2 pb-1 pt-0.5 text-[10px] tracking-wider uppercase truncate" style={{ color: "var(--text4)" }}>{g.label}</div>
        <MenuItem onClick={async () => {
          close();
          const to = (await p.askText({ title: `Rename ${g.label}`, input: { label: "Project name", initial: g.label }, confirmLabel: "Rename" }))?.trim();
          if (to && to !== g.label) for (const w of g.windows) cmd({ cmd: "group", window: w.id, name: to });
        }}>Rename project</MenuItem>
        {!isHere && <MenuItem onClick={() => { close(); p.onToggleKept(g.key); }}>{kept.has(g.key) ? "Stop keeping open" : "Keep open in the strip"}</MenuItem>}
        {g.key !== OTHER && (
          <MenuItem onClick={() => { close(); for (const w of g.windows) cmd({ cmd: "group", window: w.id, name: "Other" }); }}>Move windows to Other</MenuItem>
        )}
        <div className="my-0.5" style={{ borderTop: LINE }} />
        <MenuItem danger onClick={() => { close(); p.closeWindows(g.windows.map((w) => w.id), { anchor: tabEl(g.windows[0]?.id ?? ""), project: g.label }); }}>Close all windows</MenuItem>
      </ContextMenu>
    );
  })();

  const needN = zones.needYou;
  const chip = zones.chip;
  return (
    <StripFrame armed={p.prefixArmed} onMouseDown={keepTermFocus}>
      {chip && (
        <ProjectChip ref={chipRef} name={chip.name} count={chip.count} locked={chip.locked} open={goOpen}
          chord={chordLabel(appChordFor("windows.switcher"))}
          onClick={() => setGoOpen((o) => !o)}
          onMenu={projects ? (x, y) => setProjMenu({ key: chip.key, x, y }) : undefined} />
      )}
      <span aria-hidden className="shrink-0 mx-0.5" style={{ width: 1, height: 18, background: "var(--surface-line)" }} />
      {/* The wheel scrolls it sideways and the lit tab is kept on screen (see
          lib/tabStrip.ts). The scrollbar stays hidden — it would take a row of
          its own — so the side with tabs past it fades instead: the fade shows
          only when something is past the edge, and is the only thing that says
          there is more. */}
      <div ref={tabStrip.ref} role="tablist" aria-label="Windows" onKeyDown={onTablistKey}
        className="min-w-0 flex-1 self-stretch flex items-center gap-1 pr-3.5 overflow-x-auto agw-noscrollbar"
        style={{ maskImage: edgeMask(tabStrip.edges), WebkitMaskImage: edgeMask(tabStrip.edges) }}>
        {zones.items.map((it) => (it.kind === "label" ? label(it) : renderTab(it)))}
        {/* The end of the strip is a drop target of its own. Dropping ON a tab
            inserts BEFORE it — which is what the line on its leading edge
            promises — so without this there is no way to make a window the last
            one. It sends `after` on the last tab, because `-b` against an index
            one past the end silently puts the window at the FRONT (measured on
            3.6a). */}
        <span
          onDragOver={(e) => { if (!dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropOn("__end__"); }}
          onDragLeave={() => setDropOn((cur) => (cur === "__end__" ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragging;
            const last = windows[windows.length - 1];
            setDragging(null); setDropOn(null);
            if (!from || !last || from === last.id) return;
            cmd({ cmd: "move", window: from, name: String(last.index), after: true });
          }}
          className="shrink-0 self-stretch"
          style={{ width: dragging ? 18 : 2, boxShadow: dropOn === "__end__" ? "inset -2px 0 0 0 var(--primary)" : undefined }}
          aria-hidden />
        <PlusButton root={p.root} {...p.plus}
          title={`New window, agent or split (${p.session.prefix[0] ?? "the prefix"} c puts a shell next to this one)`} />
      </div>
      {p.prefixArmed && (
        <span className="shrink-0 inline-flex items-center gap-1.5 px-2 rounded-full text-[11px]"
          style={{ height: 22, color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 8%, var(--bg))", border: tintEdge("var(--primary)", 35) }}>
          <kbd className="px-1.5 rounded-full text-[10.5px] font-semibold" style={{ background: "var(--primary)", color: "var(--on-primary)" }}>{p.session.prefix[0] ?? "prefix"}</kbd>
          1-9 window · c new · Esc
        </span>
      )}
      {/* A badge and nothing more: a phone on this tmux can resize or scroll a
          window with nobody touching it, and this is the one place that says why. */}
      {p.phones > 0 && (
        <span title="A phone is attached to a session on this tmux, so a window may be sized or scrolled by it"
          className="shrink-0 px-2 inline-flex items-center rounded-lg text-[10px] font-semibold"
          style={{ height: CTRL_H.strip, color: "var(--text3)", background: "var(--surface-inset)", border: tintEdge("var(--text)", 14) }}>
          {p.phones > 1 ? `${p.phones} phones attached` : "phone attached"}
        </span>
      )}
      <span className="shrink-0 flex items-center gap-1">
        {needN > 0 && (
          <button type="button" disabled={!jump} onClick={() => { if (jump) onPick(jump); }}
            title={`Go to the window that needs you  ${chordLabel(appChordFor("windows.waiting"))}`}
            className="inline-flex items-center gap-1 pl-2 pr-2 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors hover:brightness-125"
            style={{
              height: CTRL_H.strip, color: "var(--warning-ink)",
              background: "color-mix(in srgb, var(--warning) 12%, var(--bg))", border: tintEdge("var(--warning)", 32),
            }}>
            <BellIcon size={ICON.xs} />{needN} {needN === 1 ? "needs" : "need"} you
          </button>
        )}
        {p.right}
      </span>
      {goOpen && (
        <GoList anchor={chipRef} groups={groups} current={p.activeGroup} kept={kept} numbers={zones.numbers} branches={branches}
          projects={projects} session={p.session.name} sessions={p.session.list} engine={p.session.engine} prefix={p.session.prefix}
          onPick={onPick} onToggleKept={p.onToggleKept}
          onSwitchSession={(name) => cmd({ cmd: "session", name })}
          onManageSessions={() => setManageOpen(true)}
          onUseTmuxBar={p.session.engine ? undefined : p.onUseTmuxBar}
          onClose={() => { setGoOpen(false); focusTerm(); }} />
      )}
      {manageOpen && (
        <ManageSessions sessions={p.session.list} current={p.session.name} engine={p.session.engine} prefix={p.session.prefix} needsYou={zones.needYou}
          onEnd={(name) => cmd({ cmd: "endsession", name })}
          onLock={(name, after) => cmd({ cmd: "locksession", name, after })}
          onClose={() => { setManageOpen(false); focusTerm(); }} />
      )}
      {tabMenuNode}
      {projMenuNode}
      {peekWin && peek.rect && !tabMenu && !goOpen && (
        <PeekCard rect={peek.rect} warm={peek.warm}
          facts={{
            name: peekWin.name || "shell",
            project: groupOfWindow.get(peekWin.id)?.label ?? null,
            number: zones.numbers.get(peekWin.id) ?? null,
            branch: peekGit?.id === peekWin.id ? peekGit.branch : null,
            pr: peekWin.id === active ? p.activePr ?? null : peekGit?.id === peekWin.id ? peekGit.pr : null,
            sentence: peekSentence(peekWin.status, tabMark(peekWin).title),
            mark: tabMark(peekWin).mark ? { kind: tabMark(peekWin).mark!, label: tabMark(peekWin).label } : null,
          }} />
      )}
    </StripFrame>
  );
}
