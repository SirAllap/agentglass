/*
 * The bench: a window that floats over whatever view you are in.
 *
 * The problem it answers is the same one the file palette answers, one floor
 * up. A shell, the file you were reading, a note, an agent — each of those
 * lives in a VIEW, so reaching one costs leaving the diff or the pull request
 * you were reading, and the trip back is the expensive part. This does not take
 * the screen from anything: it opens on top, nothing underneath moves, and it
 * goes away with the same chord.
 *
 * What makes it more than a panel is underneath: every tab that runs something
 * is its own tmux session on the engine (see engineBenchArgv). Close the
 * window, close the app, come back tomorrow — the tab reattaches to the session
 * still running whatever it was running. A floating terminal that dies with its
 * window would be a worse terminal than the one in the Terminal view; this one
 * is the same terminal, in a place you can reach from anywhere.
 *
 * Three decisions are written into the shape of this file, and each was made
 * once so it does not have to be made again:
 *
 *   ONE window, with tabs. Several floating windows is a desktop to tidy, and
 *   there is one of those already.
 *
 *   The tabs belong to a CHECKOUT. Moving the chip does not close anything: the
 *   other set is still on the engine, and the menu says so.
 *
 *   The button is loose. It is dragged where you want it and remembered as a
 *   proportion of the window, never as pixels — this machine has two monitors
 *   at different scales.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Portal } from "../Portal.tsx";
import { LAYER } from "../../lib/layers.ts";
import { api } from "../../lib/api.ts";
import { isLanternTab } from "../../lib/lanternAsk.ts";
import { shortPath } from "../../lib/shortPath.ts";
import { appChordFor, chordLabel } from "../../lib/keybindings.ts";
import {
  activateTab, activeTab, addTab, benchRoots, benchState, closeBench, closeTab, freeSlot, openBench,
  setBenchFab, setBenchGeom, setBenchGrown, setBenchRoot, subscribeBench, tabsFor, zoomBench,
  READER_SLOT, type BenchTab,
} from "../../lib/benchStore.ts";
import { claimZoom } from "../../lib/zoomOwner.ts";
import { BenchTerm } from "./BenchTerm.tsx";
import { BenchNote } from "./BenchNote.tsx";
import { BenchWeb } from "./BenchWeb.tsx";
import type { GitRepoRef } from "../../../../shared/types.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/** The floor the store clamps to, repeated here because the resize has to keep
 *  the anchored edge still WHILE it clamps — see onEdgeMove. */
const MIN_W = 22;
const MIN_H = 18;

/**
 * Where the window can be grabbed, and which way each one goes.
 *
 * INSIDE the box, not straddling it: the window clips its children so its
 * rounded corners hold, and a strip hanging outside would be cut off exactly
 * where you reach for it. Six pixels of edge and fourteen of corner — wide
 * enough to hit without looking, narrow enough to stay out of the way of a
 * terminal that fills the window. The corners come last so they sit ON TOP of
 * the two strips they overlap; otherwise a corner drag resizes one axis, which
 * is a corner that lies.
 */
const EDGES: { dir: string; cursor: string; box: React.CSSProperties }[] = [
  { dir: "n", cursor: "ns-resize", box: { left: 12, right: 12, top: 0, height: 6 } },
  { dir: "s", cursor: "ns-resize", box: { left: 12, right: 12, bottom: 0, height: 6 } },
  { dir: "w", cursor: "ew-resize", box: { top: 12, bottom: 12, left: 0, width: 6 } },
  { dir: "e", cursor: "ew-resize", box: { top: 12, bottom: 12, right: 0, width: 6 } },
  { dir: "nw", cursor: "nwse-resize", box: { left: 0, top: 0, width: 14, height: 14 } },
  { dir: "ne", cursor: "nesw-resize", box: { right: 0, top: 0, width: 14, height: 14 } },
  { dir: "sw", cursor: "nesw-resize", box: { left: 0, bottom: 0, width: 14, height: 14 } },
  { dir: "se", cursor: "nwse-resize", box: { right: 0, bottom: 0, width: 14, height: 14 } },
];

/** What a kind looks like in a tab, once, so the tab bar and the menu agree. */
const GLYPH: Record<BenchTab["kind"], { glyph: string; tint: string }> = {
  term: { glyph: ">_", tint: "var(--info)" },
  file: { glyph: "◆", tint: "var(--primary)" },
  note: { glyph: "▤", tint: "var(--success)" },
  web: { glyph: "◍", tint: "var(--warning)" },
  agent: { glyph: "✳", tint: "var(--error)" },
};

/**
 * Claude, and only Claude.
 *
 * Three were offered for one build and two of them were a lie: the ticket the
 * server mints does not carry WHICH agent — by design, since "the client says
 * what, the server decides how" — so `claudeCode.bin()` is what every one of
 * them started. Naming Codex and Antigravity in this menu promised a choice
 * that does not exist here. When the ticket learns to carry an engine, they can
 * come back; until then the menu says what actually happens.
 */
const AGENTS: { id: string; label: string }[] = [
  { id: "claude", label: "Claude" },
];

export function FloatingBench() {
  const st = useSyncExternalStore(subscribeBench, benchState);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const winRef = useRef<HTMLDivElement>(null);

  const root = st.root;
  const tabs = tabsFor(root);
  const active = activeTab(root);

  /* Which checkouts there are, asked when the window opens rather than once at
     mount: a worktree cut since the app started has to be reachable without a
     reload, and this is the moment we know somebody cares. */
  useEffect(() => {
    if (!st.open) return;
    api.gitRepos().then(({ repos: r }) => {
      setRepos(r);
      if (!benchState().root && r[0]) setBenchRoot(seedRoot(r));
    }).catch(() => { /* the chip says "pick a checkout" and the menu is empty */ });
  }, [st.open]);

  const repo = repos.find((r) => r.root === root) ?? null;

  /*
   * Which tabs still have something behind them.
   *
   * A tab is a session, and a session ends when its command exits — you typed
   * `exit`, the agent finished, the editor was quit. The tab is still a
   * perfectly good tab (opening it starts a fresh session in the same place),
   * but saying so is the difference between "my shell is still running" and
   * finding out it is not by looking for the command you left. Asked of tmux
   * rather than remembered, because tmux is where the truth is.
   */
  const [liveSlots, setLiveSlots] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!st.open || !root) { setLiveSlots(null); return; }
    let live = true;
    api.benchLive(root)
      .then((r) => { if (live) setLiveSlots(r.ok ? new Set(r.slots) : null); })
      .catch(() => { if (live) setLiveSlots(null); });
    return () => { live = false; };
  }, [st.open, root, st.byRoot]);

  /* --------------------------------------------------------------- opening */

  /**
   * A slot with nothing on it — asked of tmux, not only of the tab list.
   *
   * `new-session -A` REATTACHES when the session exists and ignores the command
   * it was given, so a tab created on a slot some earlier tab left running came
   * up as that old shell. Measured, and it is exactly what "Claude does
   * nothing" was: the agent tab attached to a leftover shell and Claude was
   * never started at all.
   */
  const coldSlot = useCallback(async (): Promise<number> => {
    const used = new Set(tabsFor(root).filter((t) => t.slot > 0).map((t) => t.slot));
    try {
      const r = await api.benchLive(root);
      if (r.ok) for (const n of r.slots) used.add(n);
    } catch { /* tmux could not be asked; the tab list is still a floor */ }
    used.add(READER_SLOT);
    for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
    return freeSlot(root);
  }, [root]);

  const newTerm = useCallback(() => {
    if (!root) return;
    /* Named after the session it will be, not after the checkout: the chip
       already says which checkout this is, and what a person wants to know
       about a tab is which of their shells it is. "bench2" is also the answer
       to "is this thing tmux?" — it is, always, and there is no version of this
       tab that is not. */
    setMenuOpen(false);
    void coldSlot().then((slot) => addTab(root, { kind: "term", slot, title: `shell ${slot}` }));
  }, [root, coldSlot]);

  const newNote = useCallback(() => {
    if (!root) return;
    addTab(root, { kind: "note", slot: 0, title: "note" });
    setMenuOpen(false);
  }, [root]);

/*
   * No recipes in this menu.
   *
   * They were offered for one build and the first one in the list was called
   * "tmux", which is the whole objection: a bench tab IS a tmux session, so a
   * shortcut that types `tmux attach` into it is a nested one — and being
   * offered it reads as the window not knowing what it is. Recipes have a pane
   * of their own, where the questions and the confirmations live.
   */

  const newWeb = useCallback(() => {
    if (!root) return;
    addTab(root, { kind: "web", slot: 0, title: "Browser" });
    setMenuOpen(false);
  }, [root]);

  /**
   * An agent, in this checkout.
   *
   * The ticket is minted first and the tab carries only its id — the same rule
   * the terminal view follows, and for the same reason: what starts an agent is
   * chosen by the server, and a client that could pass a command line would be
   * a client that could run anything.
   */
  const newAgent = useCallback(async (agent: { id: string; label: string }) => {
    if (!root) return;
    setMenuOpen(false);
    setBusy(`starting ${agent.label}…`);
    try {
      const r = await api.termAgentTicket(root, "", false, agent.label);
      const ticket = (r as { ok?: boolean; ticket?: string; error?: string });
      if (!ticket.ok || !ticket.ticket) { setBusy(ticket.error ?? `could not start ${agent.label}`); return; }
      /* A slot with no session on it, or `-A` would reattach a leftover shell
         and the agent would never run — see coldSlot. */
      const slot = await coldSlot();
      addTab(root, { kind: "agent", slot, title: agent.label.toLowerCase(), agent: ticket.ticket });
      setBusy(null);
    } catch (e) {
      setBusy(String(e));
    }
  }, [root]);

  /* ---------------------------------------------------------- the reader */

  /*
   * The file tabs are one editor's buffers, not one editor each.
   *
   * So exactly ONE terminal is rendered for them all, attached to the reader's
   * session, and changing tab does not change socket: it asks that editor to
   * show the other file. Rendering one per tab would put several clients on one
   * tmux session, which tmux answers by mirroring — the same bug that made the
   * docked console a copy of the Terminal.
   *
   * The FIRST file is the one the session is created with; after that the
   * session exists and tmux ignores the command, which is exactly what we want.
   */
  const files = useMemo(() => tabs.filter((t) => t.kind === "file"), [tabs]);
  const seed = files[0];

  useEffect(() => {
    if (!root || active?.kind !== "file" || !active.path) return;
    let live = true;
    let tries = 0;
    const ask = () => {
      api.benchEdit(root, active.path!, active.line ?? 0, !!active.readonly)
        .then((r) => {
          /* Not live yet means the editor is still starting — the session was
             created a moment ago by the terminal below. One retry rather than a
             poll: if it is not up by then, the tab is showing it starting and
             the file it was created with is the one you asked for anyway. */
          if (live && r.ok && !r.live && tries++ < 1) setTimeout(ask, 700);
        })
        .catch(() => { /* the tab still shows whatever the editor has */ });
    };
    ask();
    return () => { live = false; };
  }, [root, active?.id, active?.path, active?.line, active?.readonly, active?.kind]);

  /* ------------------------------------------------------------------ zoom */

  /*
   * The bench zooms itself, and only while it is the thing you are pointing at.
   *
   * The app's own zoom is bound at the window in the capture phase, so without
   * asking first one gesture would scale the cockpit AND this window. zoomOwner
   * is that question, already used by the image viewer — the difference here is
   * that the bench is not modal: the diff behind it is still being read, so the
   * claim is held only while the pointer is over the window or the focus is
   * inside it, and handed straight back on the way out.
   */
  const release = useRef<null | (() => void)>(null);
  const take = useCallback(() => { if (!release.current) release.current = claimZoom("bench"); }, []);
  const giveBack = useCallback(() => { release.current?.(); release.current = null; }, []);
  useEffect(() => giveBack, [giveBack]);
  useEffect(() => { if (!st.open) giveBack(); }, [st.open, giveBack]);

  /*
   * The zoom keys, at the window, for as long as the claim is held.
   *
   * Taking the claim and handling the keys only inside this element was half a
   * feature and measured as worse than nothing: with the pointer over the bench
   * and the focus anywhere else — the empty state, a tab that had not been
   * clicked — the app stood down because the claim was held, this element never
   * saw the key because the focus was elsewhere, and Ctrl+= zoomed nothing at
   * all. Whoever holds the claim has to answer the gesture.
   */
  useEffect(() => {
    if (!st.open) return;
    const onKeys = (e: KeyboardEvent) => {
      if (!release.current) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key;
      if (k !== "=" && k !== "+" && k !== "-" && k !== "_" && k !== "0") return;
      e.preventDefault();
      e.stopPropagation();
      zoomBench(k === "0" ? 0 : (k === "-" || k === "_") ? -1 : 1);
    };
    window.addEventListener("keydown", onKeys, true);
    return () => window.removeEventListener("keydown", onKeys, true);
  }, [st.open]);

  /*
   * The wheel, the hard way, for the same reason CardFiles does it: React
   * attaches `onWheel` passively at the root, so preventDefault in a JSX
   * handler is a no-op and Chromium zooms the whole page instead — which is the
   * gesture being taken over.
   */
  useEffect(() => {
    const el = winRef.current;
    if (!st.open || !el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      zoomBench(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [st.open]);

  /* -------------------------------------------------------------- dragging */

  const dragFrom = useRef<{ x: number; y: number; g: typeof st.geom } | null>(null);
  const onBarDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    dragFrom.current = { x: e.clientX, y: e.clientY, g: st.geom };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onBarMove = (e: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    const dx = ((e.clientX - from.x) / window.innerWidth) * 100;
    const dy = ((e.clientY - from.y) / window.innerHeight) * 100;
    setBenchGeom({ ...from.g, x: from.g.x + dx, y: from.g.y + dy });
  };
  const onBarUp = (e: React.PointerEvent) => {
    dragFrom.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  /*
   * Eight handles, and each one moves the edge you grabbed.
   *
   * One corner grip was what a window had in 1995 and it is the wrong shape for
   * this one: the bench is usually wide and short, and the thing you actually
   * want is "a bit more room on the right" without moving the left edge, which
   * a corner cannot express. So the right edge only grows to the right, the
   * left edge only to the left, and the corners do both.
   *
   * The anchored edge stays put even at the minimum size: clamping the width
   * and then recomputing x from `from.w - width` is the difference between a
   * window that stops growing and one that slides sideways once it has.
   */
  const sizeFrom = useRef<{ x: number; y: number; g: typeof st.geom; dir: string } | null>(null);
  const onEdgeDown = (dir: string) => (e: React.PointerEvent) => {
    sizeFrom.current = { x: e.clientX, y: e.clientY, g: st.geom, dir };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  };
  const onEdgeMove = (e: React.PointerEvent) => {
    const from = sizeFrom.current;
    if (!from) return;
    const dx = ((e.clientX - from.x) / window.innerWidth) * 100;
    const dy = ((e.clientY - from.y) / window.innerHeight) * 100;
    const { dir, g } = from;
    let { x, y, w, h } = g;
    if (dir.includes("e")) w = g.w + dx;
    if (dir.includes("w")) w = g.w - dx;
    if (dir.includes("s")) h = g.h + dy;
    if (dir.includes("n")) h = g.h - dy;
    const cw = Math.min(Math.max(w, MIN_W), 100);
    const ch = Math.min(Math.max(h, MIN_H), 100);
    if (dir.includes("w")) x = g.x + (g.w - cw);
    if (dir.includes("n")) y = g.y + (g.h - ch);
    setBenchGeom({ x, y, w: cw, h: ch });
  };
  const onEdgeUp = (e: React.PointerEvent) => {
    sizeFrom.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  /* ----------------------------------------------------------------- keys */

  const onKey = (e: React.KeyboardEvent) => {
    /*
     * Escape does NOT close this.
     *
     * Every other overlay in the app closes on it, and this one must not: the
     * thing inside a bench tab is usually nvim or a shell, where Escape is the
     * most-pressed key there is. Closing the window on it would mean losing
     * your place every time you left insert mode. The chord that opened it is
     * how it goes away, and the − button is the mouse's way.
     */
    if (e.key === "Escape") { e.stopPropagation(); return; }
    if (!e.ctrlKey && !e.metaKey) return;
    /* The zoom keys are handled at the window while the claim is held — see
       above — so that they answer wherever the focus happens to be. */
    // Ctrl+PageUp / PageDown walk the tabs, the way a terminal's tabs do.
    if (e.key === "PageDown" || e.key === "PageUp") {
      if (!tabs.length) return;
      e.preventDefault(); e.stopPropagation();
      const at = Math.max(0, tabs.findIndex((t) => t.id === active?.id));
      const next = e.key === "PageDown" ? (at + 1) % tabs.length : (at - 1 + tabs.length) % tabs.length;
      activateTab(root, tabs[next]!.id);
    }
  };

  const chord = chordLabel(appChordFor("bench.toggle"));
  const elsewhere = useMemo(
    () => benchRoots().filter((r) => r !== root).map((r) => ({ root: r, n: tabsFor(r).length })),
    [root, st.byRoot],
  );

  return (
    <>
      <AnimatePresence>
        {st.open && (
          <Portal z={LAYER.bench}>
            <motion.div
              ref={winRef}
              initial={{ opacity: 0, y: -6, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.99 }}
              transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
              className="fixed flex flex-col overflow-hidden rounded-xl"
              /* No scrim, and that is the point: the view underneath stays
                 usable and visible. A bench that dimmed the diff you opened it
                 to work on would be a modal, and a modal is the thing this is
                 not. */
              style={{
                left: `${st.grown ? 4 : st.geom.x}%`,
                top: `${st.grown ? 4 : st.geom.y}%`,
                width: `${st.grown ? 92 : st.geom.w}%`,
                height: `${st.grown ? 88 : st.geom.h}%`,
                background: "var(--bg2)",
                border: "1px solid color-mix(in srgb, var(--primary) 38%, transparent)",
                boxShadow: "0 30px 70px -18px #000",
              }}
              onKeyDown={onKey}
              onPointerEnter={take}
              onPointerLeave={() => { if (!winRef.current?.contains(document.activeElement)) giveBack(); }}
              onFocusCapture={take}
              onBlurCapture={(e) => { if (!winRef.current?.contains(e.relatedTarget as Node | null)) giveBack(); }}
              role="dialog" aria-label="The bench">

              {/*
                * Everything inside is drawn at the bench's own scale.
                *
                * `zoom` rather than a transform: a transform leaves the layout
                * at the old size, so a terminal would keep its old rows and be
                * drawn over the edge, while `zoom` re-lays-out — which is what
                * makes xterm refit and the pty get the new grid.
                *
                * And 100%, NOT 100/zoom%. Compensating the size was the first
                * version and it was measured wrong on screen: under `zoom` a
                * percentage already resolves in the zoomed coordinate space, so
                * dividing it again left the content covering 1/zoom of the
                * window — at 121% a band of empty window down the right and
                * along the bottom.
                */}
              <div className="absolute left-0 top-0 w-full h-full flex flex-col" style={{ zoom: st.zoom }}>

              {/*
                * The bar: what is open, where it opens, and the two controls.
                *
                * Every target in here is at least 28×28 with a hover that shows
                * where it starts and stops — "a veces fallo al darle y es
                * molesto", which is what a row of 22px glyphs with no hover
                * state does. The gaps between the targets are the bar's drag
                * area, so a miss moves the window instead of doing nothing,
                * and that is the least surprising thing a miss can do.
                */}
              <div
                className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 cursor-grab active:cursor-grabbing"
                style={{ background: "color-mix(in srgb, var(--text) 5%, var(--bg2))", borderBottom: edge(16) }}
                onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>

                <button
                  data-bench-plus
                  onClick={() => setMenuOpen((o) => !o)}
                  title="Open something in the bench"
                  aria-expanded={menuOpen}
                  className="agx-bench-hit shrink-0 rounded-md text-[15px] leading-none flex items-center justify-center"
                  style={{
                    width: 28, height: 28,
                    color: menuOpen ? "var(--primary)" : "var(--text2)",
                    border: edge(18),
                    background: menuOpen ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                  }}>+</button>

                <div className="flex items-center gap-1 min-w-0 overflow-x-auto agx-scroll">
                  {tabs.map((t) => {
                    const on = t.id === active?.id;
                    const g = GLYPH[t.kind];
                    return (
                      <span key={t.id} className="shrink-0 flex items-center rounded-md overflow-hidden"
                        style={on
                          ? { background: "var(--bg2)", border: edge(18) }
                          : { background: "color-mix(in srgb, var(--text) 4%, transparent)", border: edge(10) }}>
                        <button
                          onClick={() => activateTab(root, t.id)}
                          className="agx-bench-hit flex items-center gap-2 text-[11.5px] px-2.5 max-w-[200px]"
                          style={{ height: 28, color: on ? "var(--text)" : "var(--text3)" }}
                          title={tabTitle(t, root, cold(t, liveSlots))}>
                          <span className="shrink-0 text-[13px] leading-none" style={{ color: g.tint }}>{g.glyph}</span>
                          <span className="truncate" style={cold(t, liveSlots) ? { opacity: 0.6 } : undefined}>{t.title}</span>
                          {t.readonly && <span className="shrink-0 text-[9px]" style={{ color: "var(--warning)" }}>ro</span>}
                        </button>
                        {/* × only on the active tab — the tab bar's own rule
                            elsewhere in this app, and the reason there are no
                            accidental closes. Forgetting a tab does not end
                            what it is running; see closeTab.
                            A square of its own rather than a glyph tucked
                            against the name: at 22px wide it was the control
                            people missed, and missing it selects the tab you
                            were trying to close. */}
                        {on && (
                          <button onClick={() => { if (isLanternTab(t)) void api.benchEnd(root, t.slot); closeTab(root, t.id); }}
                            title={isLanternTab(t) ? "Close the Lantern's chat (ends it)" : "Forget this tab (what it runs keeps running)"}
                            className="agx-bench-hit shrink-0 text-[14px] leading-none flex items-center justify-center"
                            style={{ width: 26, height: 28, color: "var(--text3)" }}>×</button>
                        )}
                      </span>
                    );
                  })}
                </div>

                <span className="flex-1" />

                <BenchChip repo={repo} repos={repos} root={root} elsewhere={elsewhere}
                  openState={[pickOpen, setPickOpen]}
                  onPick={(r) => { setBenchRoot(r); setPickOpen(false); }} />

                {/* Only when it is not 100%: a control that says nothing most of
                    the time is clutter, and one that appears the moment you
                    change something is a label. Click resets. */}
                {Math.round(st.zoom * 100) !== 100 && (
                  <button onClick={() => zoomBench(0)} title="Back to 100% (Ctrl+0 in here) — Ctrl+wheel or Ctrl+± zooms this window alone"
                    className="agx-bench-hit shrink-0 text-[10.5px] px-2 rounded-md tabular-nums flex items-center"
                    style={{ height: 28, color: "var(--text2)", border: edge(20) }}>
                    {Math.round(st.zoom * 100)}%
                  </button>
                )}
                <button onClick={() => setBenchGrown(!st.grown)} title={st.grown ? "Back to size" : "Fill the window"}
                  className="agx-bench-hit shrink-0 rounded-md text-[14px] leading-none flex items-center justify-center"
                  style={{ width: 28, height: 28, color: "var(--text2)" }}>{st.grown ? "⤡" : "⤢"}</button>
                <button onClick={closeBench} title={`Minimise to the button (${chord})`}
                  className="agx-bench-hit shrink-0 rounded-md text-[15px] leading-none flex items-center justify-center"
                  style={{ width: 28, height: 28, color: "var(--text2)" }}>—</button>
              </div>

              {menuOpen && (
                <BenchMenu
                  root={root}
                  onClose={() => setMenuOpen(false)}
                  onTerm={newTerm} onNote={newNote} onWeb={newWeb} onAgent={newAgent} />
              )}

              {/* what is in the tab */}
              <div className="flex-1 min-h-0 relative">
                {!root && <Note>No checkout yet — pick one with the chip above.</Note>}
                {root && !tabs.length && <Empty chord={chord} onTerm={newTerm} onNote={newNote} onWeb={newWeb} />}
                {/*
                 * Every tab stays MOUNTED, hidden rather than unmounted.
                 *
                 * Switching tabs would otherwise tear down a socket and
                 * reattach on the way back — which works, tmux being what it
                 * is, but repaints the whole screen and loses the scroll
                 * position each time. Hidden keeps the connection and costs
                 * nothing while it is not on screen.
                 */}
                {root && tabs.filter((t) => t.kind !== "file").map((t) => (
                  <div key={t.id} className="absolute inset-0" style={{ visibility: t.id === active?.id ? "visible" : "hidden" }}>
                    <TabBody root={root} tab={t} active={st.open && t.id === active?.id} />
                  </div>
                ))}
                {root && seed && (
                  <div className="absolute inset-0" style={{ visibility: active?.kind === "file" ? "visible" : "hidden" }}>
                    <BenchTerm
                      root={root}
                      slot={READER_SLOT}
                      view={seed.path}
                      line={seed.line}
                      edit={!seed.readonly}
                      active={st.open && active?.kind === "file"}
                    />
                  </div>
                )}
              </div>

              {busy && (
                <div className="px-3 py-1 text-[10.5px] shrink-0" style={{ color: "var(--text3)", borderTop: edge(14) }}>{busy}</div>
              )}

              </div>

              {/* every edge and every corner. Filled while it is grown: then
                  the window IS the screen and there is nothing to drag. */}
              {!st.grown && EDGES.map((e) => (
                <div
                  key={e.dir}
                  onPointerDown={onEdgeDown(e.dir)} onPointerMove={onEdgeMove}
                  onPointerUp={onEdgeUp} onPointerCancel={onEdgeUp}
                  className="absolute"
                  style={{ ...e.box, cursor: e.cursor, touchAction: "none", zIndex: 6 }}
                  aria-hidden="true" />
              ))}
              {/* The corner still SAYS it is a corner. The strips are invisible
                  by design — a window edged in eight grey bars is a toolbar —
                  but one visible affordance is what tells you the rest exist. */}
              {!st.grown && (
                <svg viewBox="0 0 16 16" width="16" height="16"
                  className="absolute right-0 bottom-0 pointer-events-none"
                  style={{ color: "var(--text4)" }} aria-hidden="true">
                  <path d="M15 5 L5 15 M15 10 L10 15" stroke="currentColor" strokeWidth="1.2" fill="none" />
                </svg>
              )}
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>

      <BenchFab />
    </>
  );
}

/* ------------------------------------------------------------------ the button */

/**
 * The loose button.
 *
 * Dragged anywhere and remembered there, which is the whole of its charm — and
 * remembered as a percentage, because this machine has two monitors at
 * different scales and a button saved in pixels comes back off the screen.
 *
 * It is visible whether or not the window is: closed, it is how you get back;
 * open, it is where the window goes when you press −. Hiding it while the
 * window is open would make the two feel like different features.
 */
function BenchFab() {
  const st = useSyncExternalStore(subscribeBench, benchState);
  const from = useRef<{ x: number; y: number; f: { x: number; y: number }; moved: boolean } | null>(null);
  const live = useMemo(() => benchRoots().reduce((n, r) => n + tabsFor(r).length, 0), [st.byRoot]);

  const down = (e: React.PointerEvent) => {
    from.current = { x: e.clientX, y: e.clientY, f: st.fab, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const f = from.current;
    if (!f) return;
    const dx = ((e.clientX - f.x) / window.innerWidth) * 100;
    const dy = ((e.clientY - f.y) / window.innerHeight) * 100;
    if (Math.abs(e.clientX - f.x) + Math.abs(e.clientY - f.y) > 4) f.moved = true;
    setBenchFab({ x: f.f.x + dx, y: f.f.y + dy });
  };
  const up = (e: React.PointerEvent) => {
    const f = from.current;
    from.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    // A drag is not a click. Without this the button opens the bench every time
    // it is moved, which is every time you use the feature it is known for.
    if (f && !f.moved) (st.open ? closeBench : openBench)();
  };

  return (
    <Portal z={LAYER.bench}>
      <button
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        title={`The bench (${chordLabel(appChordFor("bench.toggle"))}) — drag me anywhere`}
        aria-label="The bench"
        /* Furniture that floats over a view, and can be dragged into any
           corner: anything else that places itself in a corner has to know
           where this one is. See lib/paneBox's dodge and the terminal's pane
           buttons, which land in the same bottom-right by default. */
        data-floating-furniture
        className="fixed rounded-xl flex items-center justify-center cursor-grab active:cursor-grabbing"
        style={{
          left: `${st.fab.x}%`, top: `${st.fab.y}%`, transform: "translate(-50%, -50%)",
          width: 38, height: 38,
          background: "var(--bg3)",
          border: `1px solid color-mix(in srgb, var(--primary) ${st.open ? 60 : 34}%, transparent)`,
          color: "var(--primary)",
          boxShadow: "0 14px 30px -10px #000",
        }}>
        <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2.5" y="4" width="15" height="12" rx="2" />
          <path d="M2.5 7.5 H17.5" />
          <path d="M6 11 l2 1.6 -2 1.6" />
        </svg>
        {live > 0 && (
          <span className="absolute rounded-full tabular-nums text-[8.5px] flex items-center justify-center"
            style={{
              right: -4, top: -4, minWidth: 15, height: 15, padding: "0 4px",
              background: "var(--bg)", color: "var(--primary)",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
            }}
            title={`${live} tab${live === 1 ? "" : "s"} on the bench`}>{live}</span>
        )}
      </button>
    </Portal>
  );
}

/* -------------------------------------------------------------------- pieces */

/** Everything except a file. The file tabs share one editor and are rendered
 *  once, above — see the reader. */
function TabBody({ root, tab, active }: { root: string; tab: BenchTab; active: boolean }) {
  if (tab.kind === "note") return <BenchNote root={root} active={active} />;
  if (tab.kind === "web") return <BenchWeb active={active} />;
  return <BenchTerm root={root} slot={tab.slot} agent={tab.kind === "agent" ? tab.agent : undefined} type={tab.type} active={active} />;
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-[12px]" style={{ color: "var(--text3)" }}>{children}</div>;
}

/** The empty bench says what it is for, with the keys — the same thing the
 *  floating workspace this is modelled on does, and the reason its menu is
 *  discoverable without ever opening the menu. */
function Empty({ chord, onTerm, onNote, onWeb }: { chord: string; onTerm: () => void; onNote: () => void; onWeb: () => void }) {
  const rows: [string, string, () => void][] = [
    ["A terminal here", "shell in this checkout", onTerm],
    ["A note for this checkout", "kept per worktree, not in your repo", onNote],
    ["A browser tab", "your profiles, your cookies", onWeb],
  ];
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2.5 text-[12px]">
      {rows.map(([label, hint, fn]) => (
        <button key={label} onClick={fn} className="w-[min(420px,80%)] flex items-baseline gap-3 px-3 py-2 rounded-lg text-left"
          style={{ border: edge(14), color: "var(--text)" }}>
          <span>{label}</span>
          <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>{hint}</span>
        </button>
      ))}
      <p className="text-[10.5px] mt-1" style={{ color: "var(--text4)" }}>{chord} opens and closes this · a tab keeps running when you forget it</p>
    </div>
  );
}

function BenchMenu({ root, onClose, onTerm, onNote, onWeb, onAgent }: {
  root: string;
  onClose: () => void;
  onTerm: () => void; onNote: () => void; onWeb: () => void;
  onAgent: (a: { id: string; label: string }) => void;
}) {
  /*
   * A click anywhere else closes it — including inside this window.
   *
   * A backdrop was the first answer and it was wrong twice. Inside the window
   * it is clipped by the window's own `overflow-hidden`, so clicking the app
   * behind did nothing; drawn under the window instead, a click on the TERMINAL
   * — the thing most of the window is — still did nothing, because the window
   * is above the catcher. A listener has no geometry to get wrong: anything
   * that is not this menu closes it.
   *
   * `pointerdown` rather than `click`, so the menu is gone before whatever was
   * clicked reacts, and captured, so a panel that stops propagation cannot keep
   * the menu alive over itself.
   */
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      // The + itself is not "outside": closing here and letting its own click
      // reopen it would make the button unable to close its own menu.
      if (panel.current?.contains(t) || t?.closest?.("[data-bench-plus]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  return (
    <>
      <div ref={panel} className="absolute left-2 top-9 rounded-lg overflow-hidden"
        style={{ zIndex: 2, width: 300, background: "var(--bg2)", border: edge(26), boxShadow: "0 22px 50px -16px #000" }}
        onKeyDown={(e) => {
          /* A React portal bubbles through the REACT tree, so keys pressed in
             here reach the window's handler too. Stopped at the door, like the
             palette's menus are. */
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}>
        <div className="px-3 pt-2 pb-1.5 flex flex-col gap-1" style={{ borderBottom: edge(12) }}>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Open here</div>
          <div className="text-[10px]" style={{ color: "var(--text4)" }}>{root ? shortPath(root) : "no checkout picked"}</div>
        </div>
        <div className="py-1.5 flex flex-col">
          <MenuRow glyph={GLYPH.term} label="Terminal" onClick={onTerm} />
          <MenuRow glyph={GLYPH.note} label="Note for this checkout" onClick={onNote} />
          <MenuRow glyph={GLYPH.web} label="Browser tab" onClick={onWeb} />
          <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>An agent, in this checkout</div>
          {AGENTS.map((a) => <MenuRow key={a.id} glyph={GLYPH.agent} label={a.label} onClick={() => onAgent(a)} />)}
        </div>
        <div className="px-3 py-2 text-[10px]" style={{ borderTop: edge(12), color: "var(--text4)" }}>
          A file gets here from the palette, a diff or a pull request — wherever you were reading it.
        </div>
      </div>
    </>
  );
}

function MenuRow({ glyph, label, onClick }: { glyph: { glyph: string; tint: string }; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="agx-bench-hit w-full text-left px-3 flex items-center gap-2.5 text-[12px]"
      style={{ minHeight: 32, color: "var(--text)" }}>
      <span style={{ color: glyph.tint }}>{glyph.glyph}</span>{label}
    </button>
  );
}

/**
 * Which checkout the bench is pointed at — and what is open in the others.
 *
 * The second half is the one that matters after a week: tabs are per checkout,
 * so a shell you left in another worktree is not gone and not on screen, and
 * this is where you find it. Without the list it would be a feature you could
 * lose things in.
 */
function BenchChip({ repo, repos, root, elsewhere, openState, onPick }: {
  repo: GitRepoRef | null; repos: GitRepoRef[]; root: string;
  elsewhere: { root: string; n: number }[];
  openState: [boolean, (v: boolean) => void];
  onPick: (root: string) => void;
}) {
  const [open, setOpen] = openState;
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);

  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const put = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setBox({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    put();
    window.addEventListener("resize", put);
    /*
     * A click anywhere that is not this menu closes it.
     *
     * The backdrop this used to rely on is drawn in the same portal as the
     * menu, so a click that landed on the bench window — which is most of the
     * screen when the bench is open — never reached it, and the only way out
     * was to pick something. Reported as exactly that. A capture-phase
     * pointerdown has no geometry to get wrong.
     */
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (panel.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("resize", put);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [open, setOpen]);

  return (
    <>
      <button ref={btn} onClick={() => setOpen(!open)}
        className="agx-bench-hit shrink-0 flex items-center gap-1.5 text-[10.5px] px-2.5 rounded-md max-w-[220px]"
        style={{ height: 28, background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text2)" }}
        title={root ? `Opening things in ${root}` : "Pick a checkout"}>
        <span className="truncate min-w-0">{repo ? (repo.worktreeOf ? repo.branch : repo.name) : (root ? shortPath(root) : "Pick a checkout")}</span>
        <span style={{ color: "var(--text3)" }}>▾</span>
      </button>
      {open && box && (
        <Portal z={LAYER.menu}>
          <div ref={panel} className="fixed rounded-lg text-[11px] flex flex-col overflow-hidden"
            style={{
              top: box.top, right: box.right, width: "min(520px, calc(100vw - 16px))", maxHeight: "min(420px, 60vh)",
              background: "var(--bg2)", border: edge(30), boxShadow: "0 22px 50px -16px #000",
            }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setOpen(false); }}>
            <div className="px-3 pt-2 pb-1.5 flex flex-col gap-1" style={{ borderBottom: edge(12) }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Where this opens</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>each checkout keeps its own tabs — moving here closes nothing</div>
            </div>
            <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1.5" style={{ minHeight: 0 }}>
              {!repos.length && <div className="px-3 py-2" style={{ color: "var(--text3)" }}>No checkouts found.</div>}
              {repos.map((r) => {
                const n = tabsFor(r.root).length;
                return (
                  <button key={r.root} onClick={() => onPick(r.root)}
                    className="w-full text-left px-3 py-1.5 flex flex-col gap-1"
                    style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="truncate" style={{ color: "var(--text)" }}>{shortPath(r.root)}</span>
                      {r.worktreeOf && (
                        <span className="shrink-0 text-[8.5px] px-1 rounded"
                          style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>WT</span>
                      )}
                      {n > 0 && (
                        <span className="ml-auto shrink-0 text-[9px] px-1.5 rounded"
                          style={{ color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }}>
                          {n} open
                        </span>
                      )}
                    </span>
                    <span className="text-[9.5px] truncate" style={{ color: "var(--text4)" }}>on {r.branch}</span>
                  </button>
                );
              })}
              {/* A checkout the repo list no longer has — a worktree removed
                  while its tabs were open. Named rather than dropped: the tabs
                  are still on the engine and this is the only door back. */}
              {elsewhere.filter((e) => !repos.some((r) => r.root === e.root)).map((e) => (
                <button key={e.root} onClick={() => onPick(e.root)} className="w-full text-left px-3 py-1.5 flex flex-col gap-1">
                  <span className="truncate" style={{ color: "var(--text2)" }}>{shortPath(e.root)}</span>
                  <span className="text-[9.5px]" style={{ color: "var(--warning)" }}>{e.n} open · this checkout is not in the list any more</span>
                </button>
              ))}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ helpers */

const shortName = (root: string): string => root.split("/").filter(Boolean).pop() ?? "shell";

/** A tab whose session is not on the engine any more. Not an error and not a
 *  dead tab — opening it starts one — but worth showing, because "my shell is
 *  still running" is a thing people believe about a tab bar. Unknown (the read
 *  failed, or has not answered yet) is never cold: greying every tab because a
 *  call was slow would be worse than saying nothing. */
/** What the tab says when you hover it. A terminal or an agent names its tmux
 *  session, because "is this thing tmux?" is the first question this window
 *  gets and the answer is always yes — it is the whole reason a tab survives
 *  the app being closed. */
function tabTitle(tab: BenchTab, root: string, isCold: boolean): string {
  const what = tab.path ?? tab.url ?? tab.title;
  const where = tab.slot > 0
    ? `tmux session ${shortName(root)}-bench${tab.slot} on the engine — it keeps running when this window closes`
    : "";
  const dead = isCold ? "nothing running here now; opening it starts a session" : "";
  return [what, where, dead].filter(Boolean).join("\n");
}

function cold(tab: BenchTab, live: Set<number> | null): boolean {
  if (!live || tab.slot <= 0) return false;
  return !live.has(tab.slot);
}

/**
 * Where the bench points the first time it opens.
 *
 * The checkout the palette was last searching, when that is one of the repos we
 * know: it is the last place the person expressed an interest in, and the
 * alternative — whichever repository sorts first — is a coin toss. Falls back
 * to the first repo, which is what the palette does too.
 */
export function seedRoot(repos: GitRepoRef[], remembered?: string | null): string {
  let last = remembered;
  if (last === undefined) {
    try { last = localStorage.getItem("agentglass.files.paletteRoot"); } catch { last = null; }
  }
  if (last && repos.some((r) => r.root === last)) return last;
  return repos[0]?.root ?? "";
}
