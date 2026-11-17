// In-browser terminal — a REAL machine terminal (xterm.js ⇄ WebSocket ⇄ PTY).
// The server spawns your login shell inside a pseudo-terminal per repo/worktree,
// so everything a local terminal does works here: job control, Ctrl+C/Ctrl+R,
// tab-completion, colors, vim/htop/lazygit. Shell sessions are kept alive in a
// module-level store, so closing the panel (or switching repos) never kills a
// running job — reopening reattaches to the live session, scrollback intact.
import { onTabRoot } from "../lib/tabRootStore.ts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { usePoll } from "../lib/usePoll.ts";
import { PILL_POLL_MS, withFreshRepo } from "../lib/repoPulse.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { subscribePaneDirsChanged } from "../lib/paneDirsBus.ts";

/** The pane-directory BACKSTOP: the server pushes a `panedirs` frame when tmux reports a window or active-pane path change (a cd in a pane that is not the active one is not announced, so this still catches it within a minute). */
const PANE_BEAT_MS = 60_000;
import { subscribeTermReview, termReview, clearTermReview } from "../lib/termReview.ts";
import { subscribeTermIssue, termIssue, clearTermIssue, resolveTermIssue, type TermIssue } from "../lib/termIssue.ts";
import { setupPane, subscribeSetupPane, takeSetupPane } from "../lib/setupFirstWork.ts";
import { dirName } from "../lib/worktree.ts";
import { noteWindowSet } from "../lib/liveWindow.ts";
import { requestWorktreeJump } from "../lib/worktreeJump.ts";
import { ICON } from "../lib/iconSize.ts";
import { GearIcon } from "./workspace/icons.tsx";
import { openSettings } from "../lib/openSettings.ts";
import { SearchIcon } from "../lib/glyphIcons.tsx";
import type { TmuxCmdBody } from "../lib/tmuxCmd.ts";
import { StripFrame, TermStrip } from "./terminal/TermStrip.tsx";
import { TermOverlays, noTmuxNoteDismissed } from "./terminal/TermOverlays.tsx";
import { SkeletonTabs } from "./terminal/PaneStates.tsx";
import { useWindowClose } from "../lib/useWindowClose.ts";
import { termState } from "../lib/termStates.ts";
import { CommandsPopover } from "./terminal/CommandsPopover.tsx";
import { PrPinsButton } from "./terminal/StripButtons.tsx";
import { bookedFor, chipWorktree, namedWorktree, paneCandidates, paneNote, bookPanes, unlistedWorktree, type PaneBookEntry } from "../lib/paneWorktree.ts";
import { liveTabFacts, resolveCardId, resolveWorktree } from "../lib/tabFacts.ts";
import { readBranchPrs, writeBranchPrs, readCardPrios, writeCardPrios, type RememberedPr, type RememberedPrio } from "../lib/paneFacts.ts";
import { lanternRows } from "../lib/lanternStore.ts";
import { base64Of, pastedImageType, pathPaste, takesImagePaste } from "../lib/terminalImagePaste.ts";
import { askOnBench } from "../lib/lanternAsk.ts";
import { JOB } from "../lib/benchJobs.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { checkoutConfirm, needsCheckoutConfirm } from "../lib/checkoutWarning.ts";
import { keepTermFocus } from "../lib/keepFocus.ts";
import { focusFollowsMouse, subscribeFocusFollowsMouse, shouldFocusOnHover } from "../lib/termFocusPref.ts";
import { cellAt, paneAt } from "../lib/tmuxHover.ts";
import { heldWindow } from "../lib/heldWindow.ts";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { answerDecrqm } from "../lib/xtermDecrqm.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { registerPathLinks } from "../lib/termPathLinks.ts";
import { TERM_URL } from "../lib/termUrls.ts";
import { followTerminalLink, oscLinkHandler } from "../lib/linkRouter.ts";
import type { GitRepoRef, GitBranch, PrBranchSummary, TerminalCommands, TmuxWindow, TmuxPane, PtyServerFrame, PtyClientFrame } from "../../../shared/types.ts";
import { chipTarget } from "../lib/chipTarget.ts";
import { openPr } from "../lib/openPrs.ts";
import { openCard } from "../lib/openCard.ts";
import { SidePane, SideDivider, type BadgeTone, type SideSubject } from "./terminal/SidePane.tsx";
import {
  forgetTab, closedWindows, sideCanShow, SIDE_SCROLLBAR_PX, SIDE_PAIR_GAP_PX, SIDE_OVERLAY_MARGIN_PX, SIDE_CELL_FALLBACK_PX, openSide, paneWidth, dragWidth, setWidth as setSideWidth, sectionForKey, setSection as setSideSection, setCompact,
  sidePaneVersion, subscribeSidePane, viewOf, MIN_TERM_COLS, SIDE_MIN, SIDE_USABLE, pendingResolved, resolveActiveWindow, type SideSection,
} from "../lib/sidePane.ts";
import { checksWords } from "../lib/paneChip.ts";
import { planPaneMount } from "../lib/paneMount.ts";
import { cardRef, chipAction } from "../lib/cardRef.ts";
import { useOwnerSetup } from "../lib/trackerView.ts";
import { PaneBar, BAR_MIN_H, BAR_MIN_W, SEAM_ZONE } from "./terminal/PaneBar.tsx";
import { bufferPlacement, cardSquare, checksOf, freshestPr, prForPane, prState, reviewOf, STRIP_H } from "../lib/paneChip.ts";
import { notePrs, onPrFacts, prFactOf, prFactsVersion } from "../lib/prFacts.ts";
import { noteFocusedPane } from "../lib/hangWatch.ts";
import { onChecksRead } from "../lib/prWatchStore.ts";
import { peekRollup, putRollup, rollupOf, onRollup } from "../lib/prRollupStore.ts";
import { cardOf, cardVersion, onCard } from "../lib/prCardStore.ts";
import { tabCardRef, twins } from "../lib/tabCard.ts";
import { paneAtCorner, paneFoot } from "../lib/paneBox.ts";
import { paneActionsMode, paneMarker, subscribePaneActions } from "../lib/paneActionsPref.ts";
import { useClickupSetup } from "../lib/clickupSetup.ts";
import { api, IS_DEMO, onRelay, ptyWsUrl, relayReady, relayTicketSoon, relayTurnedAway, hasToken, probeAuth, reauthPrompt, whenServerUp } from "../lib/api.ts";
import { coverIsUp, refusalFinal, useCoverHold } from "../lib/cover.ts";
import { shellSettled } from "../lib/coverStep.ts";
import { playDemoSession } from "../lib/demoTerm.ts";
import { CommandBar, loadCommands } from "./CommandBar.tsx";
import { SCROLLBAR_CSS } from "./diff/DiffLines.tsx";
import { wantsWebgl, wantsCanvas, fallBackToCanvas, rendererToHold, renderersToPark } from "../lib/termRenderer.ts";
import { isPluckChord, isFindChord, isAppChord, altDigit } from "../lib/termKeys.ts";
import { stripUp } from "../lib/termStripHost.ts";
import { ctrlAltDigit } from "../lib/sessionSlots.ts";
import { prefixStep } from "../lib/prefixArmed.ts";
import { registerClaim } from "../lib/findScope.ts";
import { typingWouldLandInApp } from "../lib/termForeground.ts";
import { THEMES, themeAnsi } from "../lib/themes.ts";
import { deriveAnsi } from "../lib/termPalette.ts";
import { termOptions, copyOnSelect, rightClickPaste } from "../lib/termPrefs.ts";
import { useModernWidths } from "../lib/termUnicode.ts";
import { dragHold } from "../lib/dragHold.ts";
import { osc52Text } from "../lib/osc52.ts";
import { mouseModeGuard, type MouseModeGuard } from "../lib/mouseModeGuard.ts";
import { holdRelease, holdStart, holdTake, mayHoldWrites, newWriteHold, shouldHoldWrites, type WriteHold } from "../lib/hiddenWrites.ts";
import { gridOk, termShown, termInputGuard } from "../lib/termInputGuard.ts";
import { CloseButton } from "./CloseButton.tsx";
import { FindArrow } from "./FindBar.tsx";
import { PlusButton, type PlusProps } from "./terminal/PlusButton.tsx";
import { LatestOutputPill } from "./terminal/LatestOutputPill.tsx";
import { PluckPalette } from "./terminal/PluckPalette.tsx";
import { buildGroups, openGroups, parseRules, setOpenGroups, subscribeTabGroups, tabGroupRulesText, tabGroupsOn, tabGroupsVersion, type TabGroup } from "../lib/tabGroups.ts";
import { LAYER } from "../lib/layers.ts";
import { agentCommand, appearedWindow, splitKeys } from "../lib/newWindow.ts";
import { prText } from "../lib/peekCard.ts";
import { Button, CTRL_H, EDGE, INPUT, INPUT_STYLE, LINE, tintEdge } from "./workspace/Chrome.tsx";

const ROOT_KEY = "agentglass.terminalRoot";
/** The repo the terminal view last used — what a docked console should open
 *  in, so the console and the terminal are the same shell in the same place. */
export function lastTerminalRoot(): string {
  try { return localStorage.getItem(ROOT_KEY) || ""; } catch { return ""; }
}

/** Marks the one shell per repo that belongs to a docked console strip. */
const CONSOLE_TITLE = "console";

/**
 * Where the docked console is pointed, remembered separately from the terminal
 * view's own repo.
 *
 * They are not the same question. The view is "where am I working"; the console
 * under Docker's logs is "which checkout do I want to run migrations in", and
 * on a machine with a worktree per ticket those are routinely different
 * directories. Sharing one key made picking a repo in the console silently move
 * the terminal view too.
 */
const CONSOLE_ROOT_KEY = "agentglass.consoleRoot";
export function consoleRoot(): string {
  try { return localStorage.getItem(CONSOLE_ROOT_KEY) || lastTerminalRoot(); } catch { return lastTerminalRoot(); }
}

/** Status dot, for anywhere that shows a shell's state. TermView builds a
 *  richer one that names the shell; this is the shared minimum. */
const SESS_DOT: Record<SessStatus, { color: string; label: string }> = {
  idle: { color: "var(--text2)", label: "Idle" },
  connecting: { color: "var(--warning-ink)", label: "Connecting…" },
  live: { color: "var(--success, #98c379)", label: "Live" },
  exited: { color: "var(--text2)", label: "Exited" },
  error: { color: "var(--error-ink)", label: "Disconnected" },
  unauthorized: { color: "var(--error-ink)", label: "Unauthorized" },
};
const repoName = (p: string) => p.split("/").pop() || p;

// xterm draws in its own DOM — resolve theme vars to concrete colors for it.
const rootStyle = () => getComputedStyle(document.documentElement); // one style-recalc per read batch
const readVar = (s: CSSStyleDeclaration, name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
const alpha = (hex: string, a: string) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex + a : hex);
/** Exported so a one-off terminal — the file peek — paints in the same colours
 *  as the panel, rather than deriving a second palette that drifts from it. */
export function themeFromCss() {
  const s = rootStyle();
  const bg = readVar(s, "--bg", "#0d1117");
  // The 16 ANSI colours: a theme's pinned palette when it has one, otherwise
  // derived from the same UI colours the rest of the panel already follows — so
  // switching theme repaints the terminal's own output too, not just its frame.
  const id = document.documentElement.getAttribute("data-theme") || "";
  const ansi = themeAnsi(id) ?? deriveAnsi({
    bg,
    text: readVar(s, "--text", "#e6edf3"),
    primary: readVar(s, "--primary", "#a78bfa"),
    error: readVar(s, "--error", "#f06c75"),
    success: readVar(s, "--success", "#98c379"),
    warning: readVar(s, "--warning", "#e5c07b"),
    info: readVar(s, "--info", "#61afef"),
  });
  return {
    background: bg,
    // The terminal's default text is the theme's PRIMARY text, not the dimmer
    // secondary — uncoloured output should read as bright/white (like a proper
    // editor surface), not the washed-out grey that --text2 gave it.
    foreground: readVar(s, "--text", "#e6edf3"),
    cursor: readVar(s, "--primary", "#a78bfa"),
    cursorAccent: bg,
    selectionBackground: alpha(readVar(s, "--primary", "#a78bfa"), "44"),
    ...ansi,
  };
}
/* Same order as the rest of the app, so the terminal and the panel around it
   are not set in two different faces. The Nerd Font stays in the list — behind
   the stock monospaces rather than in front of them — because prompts and agent
   CLIs print powerline and icon codepoints no stock monospace carries, and
   per-glyph fallback picks it up for exactly those and nothing else. */
const TERM_FONT = '"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Monaco, Consolas, "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace';


// --- persistent per-repo shell sessions (outlive the panel) ------------------
type SessStatus = "idle" | "connecting" | "live" | "exited" | "error" | "unauthorized";
type Sess = {
  id: string;             // many shells can share a repo, so the id is the key
  root: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  /** Per shell, because a match is a position in *this* scrollback: the find
   *  bar in the header drives whichever pane has the focus. */
  search: SearchAddon;
  holder: HTMLDivElement; // xterm's home element — reparented into the panel
  ws: WebSocket | null;
  status: SessStatus;
  mode: "pty" | "pipe" | null;
  shell: string;
  canResize: boolean;
  opened: boolean;
  /**
   * The 2D canvas renderer, held only while this shell is on screen.
   *
   * It allocates four full-size canvases — measured at 44 MB for one pane on
   * this machine's display — and it used to hold them for the life of the
   * session whether or not anybody could see it. Six shells open and one
   * visible meant a quarter of a gigabyte of texture for five terminals nobody
   * was looking at. `dispose()` gives all of it back.
   *
   * Null while parked. See `attachRenderer` / `parkRenderer`.
   */
  canvasAddon?: CanvasAddon | null;
  /** The WebGL renderer, held only while on screen like `canvasAddon`. A
   *  browser caps live GL contexts (~16); 30 sessions each holding one is how
   *  terminals go black and lose glyphs. */
  webglAddon?: WebglAddon | null;
  /** The pending `parkRenderer` timer, so a pane being MOVED between slots —
   *  which unmounts and remounts within the same frame — never actually loses
   *  its renderer. */
  parkTimer?: ReturnType<typeof setTimeout> | null;
  /** Has shown a rendered frame: never hidden for a first frame again. */
  painted?: boolean;
  /** Output kept back while the terminal view is hidden: see lib/hiddenWrites.ts. */
  hold?: WriteHold;
  /** A tmux client is running in this shell — the panel hides its own tabs and
   *  split while that's true, since tmux owns those. */
  tmux: boolean;
  /** The server refused an open and said why. Read once by whoever asked and
   *  then cleared: it is an answer to a request, not a state of the shell. */
  openFail?: string | null;
  /**
   * A console docked in another view, rather than one of this view's tabs.
   *
   * It changes one thing on the wire: the server resumes the tmux session the
   * desk was last in for any plain shell, and a docked console must not join
   * it. Measured on a development machine — three tmux clients, all on session `orbit` —
   * so the console under Docker's logs mirrored whichever tab the terminal view
   * had selected, and a `docker exec` typed there would have gone to the pane
   * running an agent. See PtyWsData.fresh.
   */
  console?: boolean;
  /** A one-use agent ticket this pane was created with, spent on first connect.
   *  Held rather than passed so a reconnect cannot try to spend it twice — the
   *  server would refuse the second, but a shell that silently became an agent
   *  on reconnect is worse than either. */
  agentTicket?: string | null;
  /** tmux's own windows, as tmux reports them. The panel draws these as tabs so
   *  the strip belongs to the app rather than to whatever .tmux.conf this
   *  machine carries; tmux still decides what is in it and which is active. */
  tmuxWindows: TmuxWindow[];
  /** Every session on this socket with a window in it — what the strip offers
   *  when somebody wants to go somewhere else. */
  tmuxSessions: { id: string; name: string; windows: number; locked?: boolean }[];
  /** This shell is on agentglass's own tmux, not the machine's. The strip hides
   *  "Use tmux's bar" there: that server's status line is off by design. */
  tmuxEngine?: boolean;
  /** A tmux popup — the scratch — is drawn over this terminal right now. */
  tmuxPopup?: boolean;
  /** The panes of the tmux window on screen, when it has more than one. Empty
   *  otherwise — see the server's sweep. */
  tmuxPanes: TmuxPane[];
  /** The pane tmux has selected in that window, split or not. `tmuxPanes` is
   *  empty for a single pane, and this is the id the bar over a worker's tab
   *  looks its row up by. */
  tmuxPane?: string;
  /** The session those windows belong to, for the status-line toggle. */
  tmuxSession: string | null;
  /** The grid tmux thinks THIS client has — the terminal on this desk, not the
   *  window it is drawing. They are the same number until something smaller
   *  attaches to the same session, which is the whole reason it is on the wire:
   *  the window's own size says nothing without the size it should have been. */
  tmuxClient: { cols: number; rows: number } | null;
  /** The keys tmux treats as its prefix, as tmux spells them ("C-f"). */
  tmuxPrefix: string[];
  /** Phones attached to this tmux, from the frame. Zero draws nothing. */
  tmuxPhones: number;
  /** When one of them was last pressed. The status line most configs draw
   *  flashes to say "tmux is listening"; hiding it for our tabs took that away,
   *  so the strip says it instead. */
  tmuxPrefixArmed: boolean;
  pending: string[]; // input queued while (re)connecting — flushed on ready
  /** First paint, for the launch cover (lib/cover.ts): the shell has drawn
   *  something, and — on the app's own tmux, which says so in `ready` — the
   *  window strip has arrived too. Set once; a reconnect does not unset it. */
  drawn?: boolean;
  tmuxDue?: boolean;
  settled?: boolean;
  /** The server found no tmux binary: the note under the pane says what that costs. */
  noTmux?: boolean;
  /** The socket the server reads windows from, shown when it cannot be reached. */
  tmuxSocket?: string;
  createdAt: number;
  lastUsed: number;
  retries: number;        // consecutive failed reconnects
  retryTimer: number | null;
  subs: Set<() => void>;
};
const sessions = new Map<string, Sess>();
let seq = 0;
/** Shells for one repo, in creation order. */
const sessionsFor = (root: string) => [...sessions.values()].filter((s) => s.root === root).sort((a, b) => a.createdAt - b.createdAt);
/** Shells the Terminal *view* owns: every one for a repo except the shell tagged
 *  for the docked console strip. That shell's xterm holder lives in the strip;
 *  a single holder can only be in one slot, so listing it here too would have the
 *  view mount it as a tab/pane and steal it — the console going blank the moment
 *  you open the terminal. The console strip keeps using sessionsFor to find it. */
const termSessionsFor = (root: string) => sessionsFor(root).filter((s) => s.title !== CONSOLE_TITLE);
const notify = (s: Sess) => { s.subs.forEach((fn) => fn()); rosterChanged(); };

/**
 * Tell every open session's server half whether this tab can be seen.
 *
 * Sessions outlive the panel on purpose (see the module comment above), which
 * means the server's 500ms tab-strip sweep has no idea the browser tab holding
 * it got backgrounded — it just keeps spawning `tmux` twice a second for a
 * strip nobody can see. One listener here, at module scope rather than per
 * panel, because a session is not tied to any one mounted component either.
 */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    const hidden = document.hidden;
    for (const s of sessions.values()) s.ws?.send(ptyFrame({ t: "visible", hidden }));
  });
}

/** Whether the window is minimized: a shell's output then waits (see the hold effect in TerminalPanel). */
const windowIsHidden = () => typeof document !== "undefined" && document.hidden;
function subscribeWindowHidden(fn: () => void): () => void {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}

/**
 * Fits owed to terminals the user is currently dragging inside.
 *
 * Reported as two bugs and it is one: a selection dragged up a pane stops on
 * its own halfway through the paragraph, and a tmux divider dragged sideways
 * stops halfway and needs grabbing again. Both gestures live entirely inside
 * tmux — with mouse mode on, xterm reports the pointer to the shell and tmux is
 * what selects and what resizes — and both end the instant tmux's client
 * changes size. `fitTerm` is that resize: it calls `term.resize()`, whose
 * `onResize` sends the new grid to the server, which SIGWINCHes the shell.
 *
 * Measured against a real tmux over a real pty, with the drag sent as the exact
 * SGR reports xterm produces: a 30-column divider drag moves 30 columns
 * untouched and 13 with one resize dropped in at column 15; a 25-row selection
 * holds all 25 rows untouched and 11 with one resize dropped in at row 12. In
 * both the drag dies exactly where the resize landed.
 *
 * The refit is not wrong, only badly timed — so it waits for the button rather
 * than being dropped. What arms this is a mousedown on a terminal's own holder,
 * so the panel's own drags (the console strip's top edge) still refit live as
 * they always have: those resize the slot on purpose and nothing is mid-gesture
 * inside the shell.
 */
const fitHold = dragHold<Sess>((s) => fitTerm(s));

/**
 * The second way a drag dies, which is not the panel's doing but is the panel's
 * to survive: xterm unbinds the `document` listener that reports the drag as
 * soon as the shell turns mouse tracking off, and putting the mode back does
 * not put the listener back. See mouseModeGuard for the measurement. One guard
 * per session, because the byte stream it filters is per terminal.
 */
const modeGuards = new Map<Sess, MouseModeGuard>();
const guardFor = (s: Sess) => {
  let g = modeGuards.get(s);
  if (!g) { g = mouseModeGuard(); modeGuards.set(s, g); }
  return g;
};

/** Released on the window rather than the element: a drag ends wherever the
 *  pointer happens to be by then, which is regularly outside the terminal it
 *  started in. `blur` too, because a window that loses focus mid-drag (an
 *  alt-tab, a dialog from another app) never sees the mouseup at all, and a
 *  latch left set would hold every fit for the rest of the session. */
function releaseTermDrag() {
  window.removeEventListener("mouseup", releaseTermDrag);
  window.removeEventListener("blur", releaseTermDrag);
  fitHold.end();
  // Hand the terminals back whatever was withheld from them, now that there is
  // no gesture left for it to interrupt.
  for (const [s, guard] of modeGuards) {
    const held = guard.flush();
    if (held.length) try { writeOut(s, held); } catch { /* disposed mid-drag */ }
  }
}
function armTermDrag() {
  if (fitHold.active()) return;
  fitHold.begin();
  window.addEventListener("mouseup", releaseTermDrag);
  window.addEventListener("blur", releaseTermDrag);
}

// --- roster: "is any shell alive?", for the workspace rail ---------------------
// Per-session `subs` answer "did *this* shell change"; nothing could answer
// "is anything running at all" without holding a session. The rail needs
// exactly that, and needs it while the terminal view is hidden.
const rosterSubs = new Set<() => void>();
export function subscribeSessions(fn: () => void) {
  rosterSubs.add(fn);
  return () => { rosterSubs.delete(fn); };
}
let liveCount = 0;
function recount() {
  let n = 0;
  for (const s of sessions.values()) if (s.status === "live" || s.status === "connecting") n++;
  liveCount = n;
}
/** Cached so useSyncExternalStore sees a stable value between real changes —
 *  recomputing per call would hand React a new number and loop. */
export function liveSessionCount() { return liveCount; }
const rosterChanged = () => { const before = liveCount; recount(); if (before !== liveCount) rosterSubs.forEach((fn) => fn()); };
// Set by the mounted panel so the terminal itself can close it (Shift+Esc).
let panelClose: () => void = () => {};

/**
 * Open the find bar, when there is one to open.
 *
 * Set by the terminal view while it is mounted, the same way `panelClose` is.
 * It stays a no-op returning false everywhere else — a shell in the docked
 * console strip has no find bar in front of it, and swallowing the key there
 * would take a chord away from the program running in it and give nothing back.
 */
let panelFind: () => boolean = () => false;
/** The pluck palette, from the keyboard over the focused pane — see lib/pluck.ts. */
let panelPluck: () => boolean = () => false;

/**
 * Open the pull request of the pane with the keyboard.
 *
 * The twin of the button that pane draws in its corner, and the only way in
 * when the block is folded away or switched off. Set by the mounted panel like
 * `panelFind`; false everywhere else, so the chord falls through to whatever
 * else wants it rather than being swallowed by a view that is not on screen.
 *
 * It answers about the FOCUSED pane, which is the one the keyboard is going to
 * — the same pane the strip at the top is describing, for the same reason.
 */
let paneDoor: (which: PaneDoor) => boolean = () => false;
/** Copy the branch of the pane with the keyboard — the ⧉ beside it, as a
 *  chord. False when there is no branch to copy, so the key falls through. */
let copyPaneBranch: () => boolean = () => false;
/** Ctrl+Shift+B: the keyboard goes to the focused pane's bar. Tab cannot do it
 *  from inside a terminal — the shell owns Tab — so the way in is a chord, and
 *  Tab reaches the bar from everywhere else. False when no bar is on screen. */
let focusPaneBar: () => boolean = () => false;

/*
 * THE SELECTION, AS A FACT THE BAR CAN READ.
 *
 * "Note down the terminal selection and send it to the agent": a traceback or a
 * table you want to ask about has to be copied, pasted somewhere else and
 * explained. xterm knows the selection; the bar that floats over the pane
 * did not. A one-line store — the text of the focused pane's selection —
 * that xterm's own selection event writes and the bar subscribes to, so the
 * "Ask about this" button appears the moment there is something to ask about
 * and goes the moment there is not.
 */
let paneSelection = "";
const selectionListeners = new Set<() => void>();
function noteSelection(text: string): void {
  if (text === paneSelection) return;
  paneSelection = text;
  for (const l of selectionListeners) l();
}
export const subscribeSelection = (l: () => void): (() => void) => { selectionListeners.add(l); return () => { selectionListeners.delete(l); }; };
export const currentSelection = (): string => paneSelection;

/**
 * The selection, quoted, with the note in front — what goes to the agent in
 * the pane. Quoted as Markdown so the agent reads it as material, not as an
 * instruction; trimmed of the blank tail a drag leaves; capped, because a
 * whole scrollback pasted into a prompt is not a question.
 */
export function askAboutText(selection: string, note: string): string {
  const body = selection.replace(/\s+$/, "").split("\n").slice(0, 120).map((l) => `> ${l}`).join("\n");
  return `${note.trim() || "About this:"}\n\n${body}\n`;
}
/** The four doors of the pane with the keyboard — the twins of the buttons it
 *  draws in its corner. */
export type PaneDoor = "git" | "diff" | "pr" | "card";
/** The worktree behind the focused pane; null unless the terminal is on screen. */
let paneRootNow: () => string | null = () => null;
export function focusedPaneRoot(): string | null { return paneRootNow(); }
export function openFocusedPaneDoor(which: PaneDoor): boolean { return paneDoor(which); }

/**
 * Tell the docked console that a command aimed at it was refused.
 *
 * `runInConsole` is called from other panels — the Docker one opens a shell
 * into a container this way — and those callers have nowhere to put the news.
 * The strip is where the shell is, so the strip is where the notice belongs.
 * A no-op while no strip is mounted, in which case the boolean return is the
 * only answer and the caller may ignore it.
 */
let consoleBlocked: (cmd: string) => void = () => {};

// The panel is built to keep many shells open at once, so eviction is a last
// resort rather than routine: it only runs at the server's own ceiling, and it
// never touches a shell that is still connected — closing a live job to make
// room for a new tab would lose work the user can't see.
//
// What it spares beyond that is what is ON SCREEN. It used to spare everything
// sharing the root of the shell being created, which worked only while the
// terminal had a repo picker and shells came in per-repo pools: with one root
// for the whole view, that clause spared every session there is and the ceiling
// quietly stopped applying. Panes are the honest version of the same intent —
// "don't close what I am looking at" — and they were what it meant all along.
const MAX_CLIENT_SESSIONS = 60;
/** Ids currently mounted in a pane, kept here because eviction is module-level
 *  and the panes are the view's state. Written by the view on every layout
 *  change; empty before it mounts, which is also when nothing is on screen. */
let onScreen: readonly string[] = [];
export function setOnScreenSessions(ids: readonly string[]): void { onScreen = ids; }
function evictLru() {
  if (sessions.size < MAX_CLIENT_SESSIONS) return;
  let lru: Sess | null = null;
  for (const s of sessions.values()) {
    if (onScreen.includes(s.id) || s.status === "live" || s.status === "connecting") continue;
    if (!lru || s.lastUsed < lru.lastUsed) lru = s;
  }
  if (!lru) return;
  const ws = lru.ws;
  lru.ws = null; // detach first so its handlers see a stale socket and stay quiet
  // An evicted session must not resurrect itself from a pending retry.
  if (lru.retryTimer) { clearTimeout(lru.retryTimer); lru.retryTimer = null; }
  try { ws?.close(); } catch { /* already gone */ }
  stopDemoFor(lru.id);
  try { lru.term.dispose(); } catch { /* already disposed */ }
  lru.holder.remove();
  sessions.delete(lru.id);
  rosterChanged();
}

/**
 * The demo's canned session, and the two things that have to be remembered
 * about it: which sessions have already played it, and how to stop one.
 *
 * Module scope rather than component state, because `sessions` is module scope
 * too — the panel unmounts and remounts as views are switched while a terminal
 * outlives it, and a replay tracked in a hook would restart on every remount.
 * A timer chain that writes into a disposed xterm throws from a callback nobody
 * is awaiting, so eviction and close both stop it first.
 */
const demoPlayed = new Set<string>();
const stopDemo = new Map<string, () => void>();
function stopDemoFor(id: string) {
  const stop = stopDemo.get(id);
  if (!stop) return;
  stop();
  stopDemo.delete(id);
}

/**
 * Keep a terminal's colours in step with the app's theme, while it's open.
 *
 * xterm takes a theme as a snapshot of concrete colours — it can't read a CSS
 * variable. The theme was therefore only ever sampled when the session was
 * created and when the panel was reopened, so switching theme with the terminal
 * on screen left it painted in the old palette. The visible symptom is a strip
 * down the right where the container (which follows `var(--bg)` live) no longer
 * matches the terminal's own background — which reads as a layout bug rather
 * than a stale colour.
 *
 * Watched at the root element, because that's where the theme toggle writes:
 * both the `data-theme` attribute and the inline custom properties land there.
 */
function applyThemeLive(s: Sess): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  let raf = 0;
  const restyle = () => {
    // Coalesced: a theme switch rewrites several properties in one tick, and
    // re-theming a terminal forces a full repaint of every cell.
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      try {
        s.term.options.theme = themeFromCss();
        // Terminal typography rides the same observer (termPrefs pings a root
        // var when font/size/cursor change). Font and size change the cell box,
        // so refit when either moves.
        const o = termOptions();
        // Line height changes the cell, so it refits for the same reason the
        // font does: the grid is laid out on a cell measured once.
        const needFit = s.term.options.fontFamily !== o.fontFamily || s.term.options.fontSize !== o.fontSize
          || s.term.options.lineHeight !== o.lineHeight;
        if (s.term.options.fontFamily !== o.fontFamily) s.term.options.fontFamily = o.fontFamily;
        if (s.term.options.fontSize !== o.fontSize) s.term.options.fontSize = o.fontSize;
        if (s.term.options.lineHeight !== o.lineHeight) s.term.options.lineHeight = o.lineHeight;
        if (s.term.options.cursorStyle !== o.cursorStyle) s.term.options.cursorStyle = o.cursorStyle;
        // Live, both of them: shrinking the scrollback trims the buffer, and a
        // word boundary is read on the next double click. Neither touches the
        // cell box, so neither needs a refit.
        if (s.term.options.scrollback !== o.scrollback) s.term.options.scrollback = o.scrollback;
        if (s.term.options.wordSeparator !== o.wordSeparator) s.term.options.wordSeparator = o.wordSeparator;
        if (needFit) fitTerm(s);
        // The WebGL renderer caches cells in a texture atlas and won't always
        // repaint already-drawn scrollback on a theme swap; force it. On the DOM
        // renderer this is a cheap no-op beyond the redraw it would do anyway.
        s.term.refresh(0, s.term.rows - 1);
      } catch { /* disposed */ }
    });
  };
  const mo = new MutationObserver(restyle);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", restyle);
  return () => { cancelAnimationFrame(raf); mo.disconnect(); mq?.removeEventListener?.("change", restyle); };
}

/**
 * A client frame out, as a string.
 *
 * The other half of the protocol had no declaration either: every send below
 * built its own object literal, so the desk and the phone and the server each
 * described `{t:"tmux", cmd:…}` separately and none of them could contradict
 * another. Going through here costs nothing — the guards each caller already
 * has are untouched — and buys the compiler a say in what leaves this file.
 */
const ptyFrame = (frame: PtyClientFrame): string => JSON.stringify(frame);

/** The focused tmux pane of this shell is a worker's. */
function workerPane(s: Sess): boolean {
  const paneId = s.tmuxPanes.find((p) => p.active)?.id ?? (s.tmuxPanes.length === 1 ? s.tmuxPanes[0]?.id : undefined);
  return !!paneId && takesImagePaste((lanternRows() ?? []).find((r) => r.paneId === paneId));
}

/** Ctrl+V in a worker's pane: a picture on the clipboard becomes a file and its
 *  path; anything else is the key itself, which is what the pane got before.
 *  When the picture cannot be saved the key goes through too, and the CLI's
 *  own "no image" stands: a reason typed into the prompt line would be sent. */
async function pasteImageOrKey(s: Sess): Promise<void> {
  const send = (d: string) => { if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(ptyFrame({ t: "in", d })); };
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = pastedImageType(item.types);
      if (!type) continue;
      const bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer());
      const saved = await api.terminalImage(base64Of(bytes));
      if (saved.ok && saved.file) { send(pathPaste(saved.file, !!s.term.modes?.bracketedPasteMode)); return; }
      break;
    }
  } catch { /* no clipboard permission, or the server refused: the key goes through */ }
  send("\x16");
}

/**
 * Mark a shell settled once it has drawn and, on the app's own tmux, its window
 * strip has come in. The strip rides the server's sweep, a beat after the
 * first bytes; if it never comes, the shell counts as settled anyway after
 * STRIP_WAIT_MS rather than holding the launch cover to its cap.
 */
const STRIP_WAIT_MS = 1200;
function settle(s: Sess) {
  if (s.settled || !s.drawn) return;
  // Only the launch waits on this; every shell opened after it is left alone.
  if (!coverIsUp()) { s.settled = true; return; }
  if (s.tmuxDue) {
    setTimeout(() => { if (!s.settled) { s.tmuxDue = false; settle(s); } }, STRIP_WAIT_MS);
    return;
  }
  s.settled = true;
  notify(s);
}

function connect(s: Sess) {
  if (s.ws || IS_DEMO) return;
  s.status = "connecting";
  notify(s);
  // The first terminal of a page would beat its relay ticket to the door: see relayReady.
  const wait = relayReady();
  if (wait) { void wait.then(() => { if (!s.ws && s.status === "connecting") openSocket(s); }); return; }
  openSocket(s);
}

/** The shell's bytes on their way to the terminal: straight in, or kept while its view is hidden. */
function writeOut(s: Sess, bytes: Uint8Array): void {
  if (!s.hold) { s.term.write(bytes); return; }
  for (const chunk of holdTake(s.hold, bytes)) s.term.write(chunk);
}

/** Write whatever was kept and stop keeping. Called wherever the terminal must be current: the view is
 *  back, the terminal is mounted somewhere, a socket opens or closes, the shell ends. */
function releaseHeld(s: Sess): void {
  if (!s.hold) return;
  for (const chunk of holdRelease(s.hold)) { try { s.term.write(chunk); } catch { /* disposed */ } }
}

function openSocket(s: Sess) {
  if (s.ws) return;
  // A new socket starts with tmux and the terminal talking to each other: nothing of that may wait.
  releaseHeld(s);
  const ticket = s.agentTicket ?? undefined;
  // Spent here, not on arrival: a reconnect after a drop must open a shell,
  // not start the agent a second time in the same worktree.
  s.agentTicket = null;
  const ws = new WebSocket(ptyWsUrl(s.root, s.term.cols, s.term.rows, undefined, false, ticket, s.console === true, s.console === true));
  ws.binaryType = "arraybuffer";
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (s.ws !== ws) return; // a stale socket (replaced by ⟲ new shell) must not touch the session
    if (typeof ev.data !== "string") {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      // Only while the user is dragging inside a terminal — see mouseModeGuard.
      // Every other chunk of every other second goes through untouched.
      writeOut(s, fitHold.active() ? guardFor(s).filter(bytes) : bytes);
      if (!s.drawn) { s.drawn = true; settle(s); }
      return;
    }
    /*
     * The protocol, from the one declaration of it.
     *
     * This was a bag of optional fields written out here, and the phone had its
     * own — a different one. Neither could be wrong about a frame it did not
     * name: this end declared no `pane`, no `fit` and no `by`, so the whole
     * `t:"pane"` frame could have changed shape and nothing on this side would
     * have said a word. Narrowing on `t` against the union is also what makes
     * each field readable only from the frame that carries it.
     */
    let f: PtyServerFrame;
    try { f = JSON.parse(ev.data) as PtyServerFrame; } catch { return; }
    if (f.t === "ready") {
      reconnected(s);
      s.noTmux = f.noTmux === true;
      s.status = "live"; s.mode = f.mode ?? null; s.shell = f.shell || "shell"; s.canResize = f.resize !== false;
      if (!s.settled) s.tmuxDue = f.engine === true;
      // Names the cure, not only the symptom: this mode is what a host with no
      // python3 gets, and "TUI apps won't render" alone left people believing
      // the terminal itself was broken.
      if (f.mode === "pipe") s.term.writeln("\x1b[2m(no pty on this host: plain-pipe shell, full-screen programs won't render. Install python3 and reopen; Settings ▸ Requirements has the details.)\x1b[0m");
      for (const d of s.pending.splice(0)) ws.send(ptyFrame({ t: "in", d }));
      // the fit that ran while connecting may not have reached the server
      ws.send(ptyFrame({ t: "resize", cols: s.term.cols, rows: s.term.rows }));
      // A reconnect can land while the tab is backgrounded (the socket drops
      // and comes back on its own — see below); tell the server where it
      // stands rather than leaving its 500ms sweep running at full tilt for a
      // tab strip nobody can see until the next visibilitychange.
      ws.send(ptyFrame({ t: "visible", hidden: document.hidden }));
      notify(s);
      void moveToRelay(s, ws);
    } else if (f.t === "tmux") {
      s.tmuxEngine = f.engine === true;
      if (typeof f.socket === "string") s.tmuxSocket = f.socket;
      s.tmuxPopup = f.popup === true;
      // tmux brings its own tabs, splits and status line. The panel's split and
      // its own shell tabs stand down while it runs, since two pane models is
      // how you get a split inside a split you didn't ask for. The *window*
      // list is different: we draw that one ourselves, from what tmux reports,
      // so it stops being the one strip of the workspace styled by a config
      // file the app has never seen.
      s.tmux = f.active === true;
      s.tmuxWindows = Array.isArray(f.windows) ? f.windows : [];
      noteWindowSet(s.tmuxWindows);
      /* The other sessions on this socket, for the strip's picker. */
      s.tmuxSessions = Array.isArray(f.sessions) ? f.sessions : [];
      s.tmuxPanes = Array.isArray(f.panes) ? f.panes : [];
      s.tmuxPane = typeof f.pane === "string" ? f.pane : undefined;
      s.tmuxSession = typeof f.session === "string" ? f.session : null;
      s.tmuxClient = f.client ?? null;
      s.tmuxPrefix = Array.isArray(f.prefix) ? f.prefix : [];
      s.tmuxPhones = typeof f.phones === "number" ? f.phones : 0;
      s.tmuxDue = false;
      settle(s);
      notify(s);
    } else if (f.t === "issue") {
      // The server's answer to a "start work in a window" request.
      if (typeof f.n === "number") resolveTermIssue(f.n, { ok: f.ok === true, error: f.error, ...(f.reused === true ? { reused: true } : {}) });
    } else if (f.t === "openfail") {
      // Not fatal to the shell — the socket is fine and this pane keeps
      // working. It is an answer to something that was asked, so it is recorded
      // for the asker and also written where the person is looking.
      s.openFail = f.error || "could not open that";
      notify(s);
    } else if (f.t === "exit" || f.t === "fatal") {
      s.status = f.t === "exit" ? "exited" : "error";
      releaseHeld(s); // the note below goes after the shell's last output, not before it
      if (f.t === "exit") s.term.write(`\r\n\x1b[2m— shell exited (${f.code ?? "?"}) · press Enter for a new one —\x1b[0m\r\n`);
      else s.term.writeln(`\r\n\x1b[31m${f.error || "terminal error"}\x1b[0m`);
      s.ws = null; // detach now so Enter can reconnect without waiting for onclose
      try { ws.close(); } catch { /* server closes it anyway */ }
      notify(s);
    }
  };
  ws.onclose = () => {
    if (s.ws !== ws) return; // stale socket — the session already moved on
    const wasLive = s.status === "live";
    s.ws = null;
    releaseHeld(s); // "disconnected" is written after what the shell had already said
    relayTurnedAway(ws.url, wasLive); // the retry below then takes the old door
    if (s.status === "connecting" || s.status === "live") {
      s.status = "error";
      notify(s);
      // The server is on this machine, so a drop is nearly always something
      // restarting rather than a real outage — the shell itself survives it.
      // Making the user press Enter to come back is asking them to do the
      // computer's job; retry on our own and say so, with the manual path
      // still there if the retries give up.
      maybeReconnect(s, wasLive);
    }
  };
}

/**
 * A terminal that came up on the old door moves to the relay once a ticket is in hand.
 *
 * The first connect waits for a ticket only briefly (relayReady), and on a cold
 * start that wait lost the race: the relay was up 337 ms after the server and
 * the window's one terminal was still bridged by the server, for its whole
 * life, so a server freeze froze typing again. Here the terminal is already
 * live, so it can wait; then it reconnects quietly: tmux re-attaches the same
 * session and keys typed in the gap are queued (`pending`), as on any reconnect.
 *
 * No loop: a relay that turns the new socket away keeps the old door for 60 s
 * (relayTurnedAway), so the retry lands there and relayTicketSoon says no.
 * What it does not do: a terminal that stays on the old door after that is not
 * moved again until its next reconnect.
 */
async function moveToRelay(s: Sess, ws: WebSocket): Promise<void> {
  if (onRelay(ws.url)) return;
  if (!(await relayTicketSoon())) return;
  if (s.ws !== ws || s.status !== "live") return; // closed, replaced or exited meanwhile
  s.ws = null; // the old socket is stale from here: its close does not reconnect or say "disconnected"
  try { ws.close(); } catch { /* already gone */ }
  s.status = "connecting";
  openSocket(s);
}

/** Reconnect delay, backing off so a server that's down for a while isn't
 *  hammered, but a quick restart is picked up almost immediately. */
const RETRY_MS = [400, 800, 1500, 3000, 5000, 8000];
// Stop after ~2 minutes of failed reconnects (the backoff tops out at 8s). Left
// unbounded, a wrong/rotated token — which rejects every upgrade with a 401 a
// browser WS can't read — printed a reconnect dot forever (~450/hour).
const MAX_RETRIES = 15;

/** Decide whether to keep reconnecting after a socket dropped. A close before
 *  the shell ever went live, on a token-protected server, is almost always the
 *  401 that rejects the WS upgrade — unreadable off a browser WebSocket — so we
 *  probe an authenticated endpoint to tell an auth wall from a plain outage and
 *  stop retrying (with a way back) instead of spinning forever. */
async function maybeReconnect(s: Sess, wasLive: boolean) {
  if (!wasLive && hasToken()) {
    const state = await probeAuth();
    if (s.ws) return; // a manual reconnect (Enter / ⟲) beat us to it
    if (state === "unauthorized") {
      if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
      s.retries = 0;
      s.status = "unauthorized";
      s.term.write("\r\n\x1b[31m— unauthorized: this server needs an access token —\x1b[0m\r\n\x1b[2m  reopen the dashboard with ?token=… (or click the Unauthorized status) to re-enter it\x1b[0m\r\n");
      notify(s);
      return;
    }
  }
  scheduleReconnect(s);
}

function scheduleReconnect(s: Sess) {
  if (s.retryTimer) return;
  if (s.retries >= MAX_RETRIES) {
    s.status = "error";
    s.term.write("\r\n\x1b[2m— still no server after many tries · press Enter to retry —\x1b[0m\r\n");
    notify(s);
    return;
  }
  const wait = RETRY_MS[Math.min(s.retries, RETRY_MS.length - 1)];
  s.retries++;
  if (s.retries === 1) s.term.write("\r\n\x1b[2m— disconnected · reconnecting…\x1b[0m");
  else s.term.write("\x1b[2m.\x1b[0m");
  s.retryTimer = setTimeout(() => {
    s.retryTimer = null;
    if (s.ws) return; // something else already reconnected it
    connect(s);
  }, wait) as unknown as number;
}

/** Called once a socket reports ready: the connection is good again. */
function reconnected(s: Sess) {
  if (s.retries) s.term.write("\r\n\x1b[2m— reconnected —\x1b[0m\r\n");
  s.retries = 0;
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
}

/** A brand-new shell for `root`. Repos hold as many as you open. */
function createSession(root: string, agentTicket?: string): Sess {
  evictLru();
  const tp = termOptions();
  const term = new Terminal({
    fontFamily: tp.fontFamily,
    fontSize: tp.fontSize,
    lineHeight: tp.lineHeight,
    cursorBlink: true,
    // Required before a custom width table can be registered, and harmless
    // otherwise — see termUnicode.
    allowProposedApi: true,
    cursorStyle: tp.cursorStyle,
    // Scrollback and word boundaries are preferences now — see termPrefs for
    // what each costs and why the default is what it is.
    scrollback: tp.scrollback,
    wordSeparator: tp.wordSeparator,
    theme: themeFromCss(),
    macOptionIsMeta: true,
    // A link the program printed with its own target (OSC 8). See oscLinkHandler.
    linkHandler: oscLinkHandler,
  });
  // Before anything is written: the width table decides how many columns each
  // character claims, and a line already parsed under the old one keeps the
  // widths it was parsed with.
  useModernWidths(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  /*
   * URLs in output become clickable, and open where the user's links open.
   *
   * `openExternal` rather than the addon's default handler: it is the one path
   * the whole app already uses, which the desktop shell intercepts
   * (`setWindowOpenHandler` in electron/main.js) to hand the URL to the OS
   * browser instead of opening a chromeless window inside the app. It also
   * refuses anything that is not http(s), which matters more here than
   * anywhere else — the text being linkified is whatever a program printed.
   */
  // Same guard as the file viewer. A shell here usually has tmux in front of
  // it, which answers DECRQM itself — but a bare shell running `nvim` does not,
  // and then xterm 6.0.0 throws inside its own parser and the screen stops
  // updating. See xtermDecrqm.
  answerDecrqm(term as never);
  // A pull request or a ClickUp card opens in the app; Ctrl/Cmd-click still
  // goes to the browser. See linkRouter.ts.
  term.loadAddon(new WebLinksAddon((e, uri) => { followTerminalLink(uri, e); }, { urlRegex: TERM_URL }));
  // A path that exists opens in the finder. `root` is where this shell began.
  // Ceiling: after a `cd`, or over ssh, a relative path that ALSO exists under
  // `root` links to that one. Absolute and ~/ paths are exact.
  registerPathLinks(term, root);
  /*
   * Draw on the GPU when the machine will let us.
   *
   * xterm's default renderer builds DOM for every cell, which is the single
   * biggest source of multi-second stalls when a shell is producing output
   * quickly — a build log or `cat` on anything large. The WebGL renderer draws
   * the same cells as textured quads and does not care how fast they arrive.
   *
   * Guarded twice, because a GPU is not a promise. The constructor throws where
   * there is no WebGL2 context at all (a software-rendered session, a remote
   * desktop, `--disable-gpu`), and a context can be lost *later* — a driver
   * reset, the compositor reclaiming memory, waking from suspend. Both paths
   * fall back to the DOM renderer, which is slower and always works; a terminal
   * that renders slowly is a terminal, a terminal that renders nothing is a
   * bug report. Neither case is worth a message: the shell keeps running and
   * the user has nothing to decide.
   */
  // Neither GPU nor canvas renderer is loaded here (WebGL used to be: one GL
  // context per session, never given back, past the browser's ~16 cap).
  // The canvas renderer is NOT loaded here. It is loaded when the shell is put
  // on screen and disposed a few seconds after it leaves — see attachRenderer.
  // A session created and never shown, or shown and then parked behind another
  // view, holds no canvases at all.

  // A program's own copy (a worker CLI behind the wall has no wl-copy): OSC 52 to the clipboard.
  term.parser.registerOscHandler(52, (data) => {
    const text = osc52Text(data);
    if (text) navigator.clipboard?.writeText(text).catch(() => { /* no clipboard permission */ });
    return true;
  });

  // Shift+Esc closes the panel — plain Esc belongs to the shell (vim, fzf…).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Escape" && e.shiftKey) { panelClose(); return false; }
    // Ctrl+V in a worker's pane: the CLI behind the wall cannot read the clipboard, so a picture is saved here and its path typed. See terminalImagePaste.ts.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "v" || e.key === "V") && workerPane(sess)) {
      e.preventDefault();
      void pasteImageOrKey(sess);
      return false;
    }
    /*
     * Ctrl+Shift+C copies the branch — when there is nothing selected.
     *
     * Asked for as "have it copy / trigger the worktree copy, that branch copy thing":
     * the same thing the ⧉ beside the branch does, from the keyboard, without
     * reaching for the block.
     *
     * A SELECTION still wins, and that is not a compromise: Ctrl+Shift+C is
     * every terminal's copy, and taking it from a person who has just dragged
     * over an error message to copy it would be a bad trade for a convenience.
     * With nothing selected that chord does nothing at all today, which is the
     * gap this fills.
     */
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "C" || e.key === "c") && !term.hasSelection() && copyPaneBranch()) return false;
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "B" || e.key === "b") && focusPaneBar()) return false;
    if (isFindChord(e) && panelFind()) return false;
    if (isPluckChord(e) && panelPluck()) return false;
    // The app's own chords — today the finder. Returning false keeps the
    // keystroke out of the PTY; the window listener in App still sees it, so
    // the palette opens and the shell never hears about it.
    // Alt+1..9 picks a strip tab; xterm would send it to the pane as Esc+digit.
    if (altDigit(e) && stripUp()) return false;
    // Ctrl+Alt+1..9 is a session slot (the strip answers it); keep it out of the pane too.
    if (ctrlAltDigit(e) && stripUp()) return false;
    if (isAppChord(e)) return false;
    return true;
  });
  // Copy on select, the tmux way: the instant a selection is made it is on the
  // clipboard — no Ctrl+Shift+C, no right-click menu (a terminal has none), no
  // fighting the shell over Ctrl+C. A cleared selection (a plain click) returns
  // "" and is skipped, so clicking away never wipes what you just copied. Writes
  // may fail mid-drag if the document is momentarily unfocused; the settled
  // selection on mouse-up lands, and the failures are silent.
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    noteSelection(sel.trim() ? sel : "");
    // Read at selection time rather than captured here: the switch has to take
    // effect on the next drag, not on the next shell.
    if (!copyOnSelect()) return;
    if (sel) navigator.clipboard?.writeText(sel).catch(() => { /* no clipboard permission */ });
  });
  const holder = document.createElement("div");
  // Every gesture that can be interrupted by a refit starts here — see fitHold.
  // On the holder rather than on xterm's own element because xterm calls
  // `preventDefault` on its mousedown, and because the holder is what outlives
  // a renderer swap.
  holder.addEventListener("mousedown", armTermDrag);
  // Opaque themed backing, so any frame where the renderer paints nothing (a
  // WebGL context loss, a swap to the DOM renderer) shows the terminal's own
  // background colour instead of a white flash.
  holder.style.cssText = "width:100%;height:100%;background:var(--bg)";
  /*
   * Right-click pastes, when asked for.
   *
   * Off by default because a right click opens a menu everywhere else in this
   * app, and a terminal that silently swallows it is a terminal you cannot get
   * a menu out of. Ctrl+right-click is left alone either way, so the menu is
   * always one modifier away.
   *
   * The text is written to the shell rather than to xterm's own paste path: the
   * pty is what needs the bytes, and this is the same route every other write
   * takes.
   */
  holder.addEventListener("contextmenu", (e) => {
    if (!rightClickPaste() || (e as MouseEvent).ctrlKey) return;
    e.preventDefault();
    navigator.clipboard?.readText()
      .then((text) => { if (text) sess.ws?.send(JSON.stringify({ t: "d", d: text })); })
      .catch(() => { /* no clipboard permission — the menu stayed shut, nothing pasted */ });
  });
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const sess: Sess = { id, root, title: `shell ${sessionsFor(root).length + 1}`, term, fit, search, holder, ws: null, status: "idle", mode: null, shell: "shell", canResize: true, opened: false, tmux: false, openFail: null, agentTicket: agentTicket ?? null, tmuxWindows: [], tmuxSessions: [], tmuxPanes: [], tmuxSession: null, tmuxClient: null, tmuxPrefix: [], tmuxPhones: 0, tmuxPrefixArmed: false, pending: [], createdAt: Date.now(), lastUsed: Date.now(), retries: 0, retryTimer: null, subs: new Set() };
  // One per shell: it remembers the last press that has not been released.
  const inputGuard = termInputGuard();
  term.onData((raw) => {
    // A mouse report computed while the terminal is off screen is NaN — see
    // termInputGuard. Dropped here, the one place everything bound for the pty
    // passes, so no renderer or view switch can leak one into the prompt.
    const d = inputGuard.filter(raw, termShown(term.element));
    if (!d) return;
    sess.lastUsed = Date.now();
    /*
     * "tmux is listening."
     *
     * Read off the keystroke on its way past rather than asked of tmux,
     * because this has to land on the same frame as the keypress: a poll, at
     * any interval anyone would accept, answers after the moment it is meant
     * to describe. tmux is told which key it is (see prefixKeys), so a rebound
     * prefix — and anyone who rebinds it is exactly who notices this missing —
     * lights up the same as the default.
     *
     * A best-effort mirror of tmux's own state, not a model of it: the byte is
     * also the prefix when it is being sent *through* to a nested tmux or to
     * an application that wants it. Wrong in that case until the next key, and it
     * never touches what the shell receives.
     */
    if (sess.tmux) {
      // The whole decision is lib/prefixArmed.ts. There is no clock: tmux waits
      // as long as it is left alone, so the halo does too, and ends with the
      // next key (or a click, handled where pointers are).
      const { armed } = prefixStep(sess.tmuxPrefixArmed, { type: "key", data: d }, sess.tmuxPrefix);
      if (armed !== sess.tmuxPrefixArmed) { sess.tmuxPrefixArmed = armed; notify(sess); }
    }
    if (sess.status === "live" && sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(ptyFrame({ t: "in", d }));
    else if (sess.status === "connecting") sess.pending.push(d); // don't drop keys typed before the shell is up
    else if (sess.status === "unauthorized" && d.includes("\r")) reauthPrompt(); // Enter → re-enter the token
    else if ((sess.status === "exited" || sess.status === "error") && d.includes("\r")) { sess.retries = 0; connect(sess); } // Enter → new shell, scrollback kept
  });
  term.onResize(({ cols, rows }) => {
    if (!gridOk(cols, rows)) return;
    if (sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(ptyFrame({ t: "resize", cols, rows }));
  });
  sessions.set(id, sess);
  return sess;
}

/** xterm's private handle on its renderer. The exact CSS cell size lives only
 *  in there — FitAddon reads the very same field. */
type TermCore = {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width: number; height: number } } };
      clear?: () => void;
    };
  };
};

/** The exact CSS cell size, or undefined before the first render: the fit and the side pane's 80-column floor read it the same way. */
function cellSizeOf(term: unknown): { width: number; height: number } | undefined {
  return (term as TermCore | undefined)?._core?._renderService?.dimensions?.css?.cell;
}

/**
 * Give this shell its renderer back, because it is on screen again.
 *
 * The canvas renderer allocates four full-size canvases — measured at 44 MB for
 * one pane on this display — and it used to hold them for the life of the
 * session, on screen or not. Six shells open with one visible is a quarter of a
 * gigabyte of texture for terminals nobody can see.
 *
 * Called from the mount effects, immediately after the holder is attached and
 * before the first fit. Attached matters: the addon only defers its own setup
 * when `terminal.element` is missing, and here the terminal was opened long ago
 * — a detached element would have it measure a zero-size screen.
 *
 * WebGL is held the same way now: its contexts are capped by the browser, and
 * one per session for 30 sessions exceeded the cap. See `rendererToHold`.
 */
/** Opacity 0 until the next render after the GL addon loads (or 400 ms, whichever first). */
function hideUntilFirstFrame(s: Sess): void {
  if (s.painted) return; // already showed frames: hiding it again IS the flicker
  s.painted = true;
  s.holder.style.opacity = "0";
  let done = false;
  let sub: { dispose(): void } | undefined;
  const show = () => { if (done) return; done = true; sub?.dispose(); clearTimeout(timer); s.holder.style.opacity = ""; };
  sub = s.term.onRender(() => requestAnimationFrame(show));
  const timer = setTimeout(show, 400);
}

export function attachRenderer(s: Sess): void {
  if (s.parkTimer) { clearTimeout(s.parkTimer); s.parkTimer = null; }
  recentlyParked = recentlyParked.filter((x) => x !== s); // on screen again: it keeps its renderer, no re-creation
  const want = rendererToHold(wantsWebgl(), wantsCanvas(), true);
  if (want === "webgl" && !s.webglAddon) {
    try {
      const gl = new WebglAddon();
      // Rebuilt renderer: xterm paints the DOM renderer first. Keep the shell
      // invisible (opacity, not display:none, so fit still measures) until the
      // GL addon has drawn its first frame, then show it in one step.
      hideUntilFirstFrame(s);
      // A lost context can leave the terminal blank-white with no repaint. Drop
      // off the GPU app-wide and remember it, to canvas rather than slow DOM.
      gl.onContextLoss(() => {
        fallBackToCanvas();
        try { gl.dispose(); } catch { /* already gone */ }
        if (s.webglAddon === gl) s.webglAddon = null;
        // attachRenderer cancels a pending park; a shell lost during the park grace
        // window is off screen (disposeRenderer's own test) and must stay parked.
        if (s.holder.parentElement) attachRenderer(s);
      });
      s.term.loadAddon(gl);
      s.webglAddon = gl;
    } catch {
      s.holder.style.opacity = ""; /* no WebGL2 here: the DOM renderer, or canvas on the next attach */ }
  }
  if (want === "canvas" && !s.canvasAddon) {
    try {
      const addon = new CanvasAddon();
      s.term.loadAddon(addon);
      s.canvasAddon = addon;
    } catch {
      // The DOM renderer takes over and the shell never noticed.
      s.canvasAddon = null;
    }
  }
}

/**
 * Take it away again, a few seconds after the shell leaves the screen.
 *
 * The delay is not a heuristic about idleness — it is because the panel MOVES a
 * holder between slots when the split changes, which unmounts and remounts
 * inside the same frame. Disposing immediately would thrash the texture atlas
 * on every layout change, and `attachRenderer` cancels this timer, so a move
 * costs nothing at all.
 *
 * `dispose()` puts xterm back on the DOM renderer rather than on nothing, which
 * is why the swap back has to happen in the same tick as the reattach and
 * before the first frame: otherwise the catch-up repaint is drawn by the
 * renderer that cannot draw box-drawing characters, and the seams this app
 * chose canvas to remove would flash for a frame.
 *
 * Nothing about the shell changes. It keeps running, its scrollback is intact,
 * and xterm pauses an off-screen terminal's rendering anyway — so the output
 * that arrives while it is parked costs nothing either.
 */
export function parkRenderer(s: Sess): void {
  if (s.parkTimer) clearTimeout(s.parkTimer);
  // A tab switch parks one shell and attaches another. Disposing the parked
  // one's renderer meant the next switch back built a new GL context and
  // atlas: DOM paint, then GL paint, then a refit — the flicker. The last few
  // shells you left keep their renderer (bounded, well under the context cap).
  const { keep, release } = renderersToPark(recentlyParked, s, RECENT_RENDERERS_KEPT);
  recentlyParked = keep;
  for (const old of release) disposeRenderer(old);
  s.parkTimer = setTimeout(() => {
    s.parkTimer = null;
    if (recentlyParked.includes(s)) return;
    disposeRenderer(s);
  }, PARK_RENDERER_MS);
}

/** The shells left most recently, newest last; they keep their renderer. */
let recentlyParked: Sess[] = [];
/**
 * Chromium caps live ~16 WebGL contexts per page and silently kills the
 * oldest past that (a blank terminal). 12 recent shells keep theirs, leaving
 * headroom for the console strip, the side pane and the browser's own use.
 */
export const RECENT_RENDERERS_KEPT = 12;

function disposeRenderer(s: Sess): void {
  if (s.holder.parentElement) return; // on screen again: never strip a visible shell
  const addon = s.canvasAddon;
  const gl = s.webglAddon;
  s.canvasAddon = null;
  s.webglAddon = null;
  try { addon?.dispose(); } catch { /* already gone with the terminal */ }
  // Frees the GL context. Parks the RENDERER only: the socket stays open and
  // bytes still parse into the xterm buffer, so nothing is redrawn from tmux.
  try { gl?.dispose(); } catch { /* already gone with the terminal */ }
}

/** Long enough that switching views and coming straight back keeps the
 *  renderer, short enough that leaving for a minute gives the memory back. */
export const PARK_RENDERER_MS = 3000;

/**
 * Size a terminal to its slot. Ours, not `FitAddon.fit()`.
 *
 * The addon subtracts a flat 14px from the width whenever scrollback is on —
 * `options.overviewRuler?.width || 14`. That is a constant, not a measurement
 * of anything, so hiding the scrollbar in CSS cannot win it back, and asking
 * for `{ width: 0 }` lands on 14 again because 0 is falsy. At this font size
 * it costs two whole columns, and they show up as a dead strip down the right

 * of anything that draws edge to edge: nano's title bar, vim's status line,
 * tmux's border. Nothing is reserved here — the viewport's scrollbar is an
 * overlay (see the style block below) and takes no layout width.
 */
function fitTerm(s: Sess) {
  // Not while the user is dragging inside this terminal — see fitHold. The fit
  // is owed, not cancelled: it runs on the release, when there is no gesture
  // left for the SIGWINCH to interrupt.
  if (fitHold.hold(s)) return;
  const el = s.term.element;
  const parent = el?.parentElement;
  const cell = cellSizeOf(s.term);
  // Before the first render there is no cell size to divide by; the addon has
  // its own guards for that, so let it decide there's nothing to do yet.
  if (!el || !parent || !cell?.width || !cell?.height) { s.fit.fit(); return; }
  const box = getComputedStyle(parent);   // computed width/height are content-box px
  const own = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const w = px(box.width) - px(own.paddingLeft) - px(own.paddingRight);
  const h = px(box.height) - px(own.paddingTop) - px(own.paddingBottom);
  const cols = Math.max(2, Math.floor(w / cell.width));
  const rows = Math.max(1, Math.floor(h / cell.height));
  if (cols === s.term.cols && rows === s.term.rows) return;
  (s.term as unknown as TermCore)._core?._renderService?.clear?.(); // as the addon does — drop the old grid before reflowing
  s.term.resize(cols, rows);
  /*
   * And back to the bottom, every time.
   *
   * A resize keeps xterm's viewport where it was in the SCROLLBACK, not at the
   * end of it — so a terminal that grows by a row comes back one line up, and
   * under tmux that is unmistakable: tmux repaints its whole frame into the
   * grid, the frame's last row lands in the line above the fold, and what you
   * see at the TOP of the pane is the bottom line of the window. Reported
   * exactly that way, twice, with the second screenshot showing Claude Code's
   * footer sitting under the tab bar: "notice that the missing line of text
   * is at the top".
   *
   * Measured on the live server while it was happening: tmux's client and its
   * window were both 249x62 and agreed with each other, so nothing was the
   * wrong SIZE — the grid was simply being read from one row too high.
   */
  try { s.term.scrollToBottom(); } catch { /* disposed mid-fit */ }
}

/** Close a shell and drop it: its socket, its terminal and its pending retry. */
function killSession(s: Sess) {
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  const ws = s.ws;
  s.ws = null; // detach first so the close handler stays quiet
  try { ws?.close(); } catch { /* already gone */ }
  stopDemoFor(s.id);
  modeGuards.delete(s);
  try { s.term.dispose(); } catch { /* already disposed */ }
  s.holder.remove();
  sessions.delete(s.id);
  rosterChanged();
}

/**
 * Find in scrollback, for whichever pane has the focus.
 *
 * Top right, over the shell, wearing the same face as the app's own find (see
 * FindBar.tsx): the icon, the count, the two arrows, the close. It searches a
 * canvas rather than the document so it cannot share that one's logic — but a
 * screen where the same chord opens two different-looking boxes is a screen you
 * have to learn twice.
 *
 * The header keeps nothing of it — no button, no slot. It used to live up there
 * so an overlay could never cover output, and the price was a permanent control
 * for something that is a chord and is open for ten seconds at a time.
 *
 * The highlight colours are the app's own tokens rather than xterm's defaults,
 * which are a fixed yellow that disappears on the light themes.
 */
function FindBar({ sess, onClose }: { sess: Sess | undefined; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // `onDidChangeResults` is the only honest source for "3 of 17": the addon
  // counts as it walks the buffer, and a running shell keeps adding to it.
  useEffect(() => {
    if (!sess) return;
    const sub = sess.search.onDidChangeResults((r) => setAt(r ? { index: r.resultIndex + 1, count: r.resultCount } : null));
    return () => { sub.dispose(); };
  }, [sess]);

  /*
   * The decorations, and the one that was wrong.
   *
   * `matchBackground` was `#00000000` — fully transparent — so every match but
   * the current one was drawn with a thin border and nothing else, and on a
   * screen of code that is invisible: "I can't tell where the match is". They
   * are filled now. Eight-digit hex because that is what xterm's colour parser
   * takes; a `color-mix()` from a CSS variable is a string it cannot read, and
   * it fails by drawing nothing rather than by complaining.
   */
  /* The same two colours the rest of the app finds with — `--find-hit` and
     `--find-on`, the amber and the loud magenta of `::highlight()` in
     index.css. The terminal's old pair was quieter than the rest of the app and
     the app already had the louder colour. One search
     that looks the same everywhere beats two that each have to be learned.

     Alpha on the fills because xterm draws these as a layer and the shell's own
     text has to stay readable through it; the borders go on at full strength,
     which is what makes a match findable at a glance across a wide window. */
  const hit = readVar(rootStyle(), "--find-hit", "#ffd23f");
  const on = readVar(rootStyle(), "--find-on", "#ff2bd1");
  const opts = {
    decorations: {
      matchBackground: `${hit}66`,
      matchBorder: hit,
      matchOverviewRuler: hit,
      // The one you are on, told apart by HUE rather than by brightness: the
      // same colour at double strength reads as "bigger" on a dark ground
      // rather than as "this one".
      activeMatchBackground: `${on}cc`,
      activeMatchBorder: on,
      activeMatchColorOverviewRuler: on,
    },
  };

  const step = (back: boolean) => {
    if (!sess || !q) return;
    if (back) sess.search.findPrevious(q, opts); else sess.search.findNext(q, opts);
  };

  // Clearing the term clears the highlights with it — leaving them on screen
  // after the box is empty is the kind of stale state nobody can dismiss.
  const change = (v: string) => {
    setQ(v);
    if (!sess) return;
    if (!v) { sess.search.clearDecorations(); setAt(null); return; }
    sess.search.findNext(v, { ...opts, incremental: true });
  };

  const close = () => { try { sess?.search.clearDecorations(); } catch { /* disposed */ } onClose(); };

  const nothing = !!q && !at?.count;
  return (
    <div
      className="absolute flex items-center gap-1.5 rounded-lg px-2 py-1.5 agx-menu"
      /* Top right, where every find bar in this app and in every browser lives.
         Inside the panel rather than fixed to the window, so it lands in the
         terminal's own corner and never sits on top of the app-wide find. */
      style={{ top: 8, right: 12, zIndex: LAYER.pane, boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
      role="search" aria-label="Find in the scrollback"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span aria-hidden className="flex" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.xs} /></span>
      <input
        ref={inputRef}
        value={q}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey); }
          // The bar owns its own arrows, or the shell behind it scrolls instead.
          else if (e.key === "ArrowDown") { e.preventDefault(); step(false); }
          else if (e.key === "ArrowUp") { e.preventDefault(); step(true); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        }}
        placeholder="Find in the scrollback"
        aria-label="Find"
        className={`min-w-[180px] ${INPUT}`}
        style={{ ...INPUT_STYLE, color: nothing ? "var(--error)" : "var(--text)", caretColor: "var(--primary)" }}
      />
      {/* `0/0` rather than blank while you type: an empty counter reads as
          "still thinking". Same shape as the app's own. */}
      <span className="tabular-nums text-[10px] shrink-0" style={{ color: nothing ? "var(--error)" : "var(--text4)" }}>
        {at?.count ? `${at.index}/${at.count}` : q ? "0/0" : ""}
      </span>
      <FindArrow dir={-1} disabled={!at?.count} onClick={() => step(true)} />
      <FindArrow dir={1} disabled={!at?.count} onClick={() => step(false)} />
      <CloseButton onClick={close} title="Close (Esc)" className="rounded hover:bg-white/10 shrink-0" style={{ color: "var(--text3)" }} />
    </div>
  );
}

/**
 * "That did not go anywhere, and here is what to do about it."
 *
 * Shown when a command was refused because a full-screen program had the
 * screen. Silence would be worse than the old behaviour: a chip that does
 * nothing reads as broken, where a chip that types into vim at least tells you
 * what happened, eventually, badly.
 */
function BlockedNotice({ cmd, onSend, onDismiss }: { cmd: string; onSend: () => void; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 text-[10.5px] px-2 py-1 rounded-lg min-w-0"
      style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--warning) 12%, var(--surface-card))", border: tintEdge("var(--warning)", 35), boxShadow: "0 8px 22px -10px var(--shadow)" }}>
      <span className="truncate" data-tip={`Not sent: ${cmd}`}>
        A full-screen program is running — <b className="font-mono">{cmd}</b> was not typed
      </span>
      <Button size="compact" onClick={onSend} className="shrink-0">Send anyway</Button>
      <CloseButton onClick={onDismiss} title="Dismiss" className="shrink-0" />
    </div>
  );
}

/** A grid width in the "somebody took your columns" notice. The two numbers are
 *  the entire content of that sentence — everything around them is there to say
 *  which is which — so they are the only bright thing in the row. */
const Cols = ({ n }: { n: number }) => <b className="tabular-nums" style={{ color: "var(--text)" }}>{n}</b>;

/**
 * Type a command into the repo's shell (starting one if needed).
 *
 * Returns false without typing anything when a full-screen program has the
 * screen — vim, htop, lazygit — because the keystrokes would land in it rather
 * than at a prompt: `:wq` typed into a buffer, `git status` inserted into the
 * file you were editing. `force` sends it anyway, which is what the notice the
 * caller shows offers, since only the person watching knows whether the program
 * on screen wants that line.
 */
function runInShell(s: Sess, cmd: string, force = false): boolean {
  /*
   * tmux is the exception the guard has to make.
   *
   * `typingWouldLandInApp` exists so a command is never typed into vim or less,
   * where it would be read as keystrokes rather than run. tmux trips it — it is
   * a full-screen program by every test there is — but it is the one that hands
   * what you type straight to the shell in its active pane. So under tmux the
   * guard was answering a question nobody asked: not "will this land in an
   * application" but "is an application on screen", and refusing every command
   * with "was not typed. Send anyway".
   *
   * That made `keep running` and any saved recipe mutually exclusive, which is
   * the opposite of the point: a long build is exactly what you want in tmux.
   *
   * Only tmux, and only because the app already knows: `s.tmux` is set from
   * tmux's own report, not guessed from what the screen looks like. A pager
   * INSIDE a tmux pane is still a pager, and that is a real limit of this — the
   * guard cannot see through tmux to what is running in the pane.
   */
  if (!force && !s.tmux && typingWouldLandInApp(s.term.buffer.active)) return false;
  const line = cmd + "\r";
  s.lastUsed = Date.now();
  if (s.status === "live" && s.ws?.readyState === WebSocket.OPEN) s.ws.send(ptyFrame({ t: "in", d: line }));
  else { s.pending.push(line); if (!s.ws) connect(s); }
  s.term.focus();
  return true;
}

/**
 * Type a command into the docked console, opening its shell if needed.
 *
 * Finds the session the same way ConsoleStrip does — by title, per repo — so
 * calling this before the strip has mounted converges on one shell rather than
 * racing it into two. `runInShell` queues into `pending` when the socket is not
 * up yet, so the command still runs once it connects.
 *
 * Returns false when a full-screen program is holding that shell and the
 * command was therefore not typed. Callers from other panels get a plain answer
 * rather than a command that vanished into somebody's editor.
 */
/**
 * Whether the console for this checkout is already inside tmux.
 *
 * Exported because the button that puts it there needs to know not to do it
 * twice. Pressing again typed the command AT tmux rather than at a prompt, and
 * the panel's own full-screen guard then had to explain itself — a warning
 * about a keystroke nobody meant to send, over a state the button could simply
 * have read.
 */
export function consoleInTmux(root: string): boolean {
  if (!root) return false;
  return !!sessionsFor(root).find((x) => x.title === CONSOLE_TITLE)?.tmux;
}

export function runInConsole(root: string, cmd: string): boolean {
  if (!root || IS_DEMO) return false;
  const existing = sessionsFor(root).find((x) => x.title === CONSOLE_TITLE);
  const s = existing ?? createSession(root);
  s.title = CONSOLE_TITLE;
  // Its own shell, never the desk's tmux session — see Sess.console.
  s.console = true;
  const sent = runInShell(s, cmd);
  if (!sent) consoleBlocked(cmd);
  return sent;
}

// --- the panel ---------------------------------------------------------------
/** The terminal as a workspace view.
 *
 *  `onClose` is still needed here (unlike the other views) because the shell
 *  itself can dismiss the workspace with Shift+Esc — see `panelClose`. */
/**
 * A shell strip that lives at the bottom of another panel.
 *
 * Same machinery as the terminal view — same module-level session store, same
 * PTY, same xterm — deliberately: a second, lesser terminal would be a second
 * set of bugs, and a console you cannot run `make migrate` in properly is not
 * worth the room it takes.
 *
 * Keyed on the repo, not on the panel's selection, which is the point. Docker's
 * console must not restart because you clicked a different container: the whole
 * value of a console under the logs is that it keeps its history and its
 * running job while you look around above it.
 */
export function ConsoleStrip({ root: fallbackRoot, open, height, onHeight, onClose }: {
  root: string; open: boolean; height: number; onHeight: (h: number) => void; onClose: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [sid, setSid] = useState<string>("");
  /** Whether a hover takes the keyboard — see lib/termFocusPref.ts. */
  const ffm = useSyncExternalStore(subscribeFocusFollowsMouse, focusFollowsMouse, () => false);
  /**
   * Which checkout this console is in — its own choice, falling back to the
   * terminal view's repo until someone makes one. Changing it swaps which
   * per-repo console session the strip is showing; the one you were in keeps
   * running, which is the same promise the strip already makes when you close
   * it.
   */
  const [picked, setPicked] = useState<string>(() => { try { return localStorage.getItem(CONSOLE_ROOT_KEY) || ""; } catch { return ""; } });
  /** The checkout menu has the keyboard, so focus-follows-mouse must leave it
   *  alone — hovering the shell while you are typing into the filter would drag
   *  the cursor out from under the letters. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const root = picked || fallbackRoot;
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const { ask, dialog } = useDialogs();
  /** The row for the directory we are standing in — what "here" means, by name,
   *  what it currently holds, and whether it has uncommitted work in it. */
  const here = repos.find((r) => r.root === root) ?? null;
  /** Put the cursor back in the console after a menu that had to borrow the
   *  focus (the repo filter, the commands filter) closes again. Deferred a
   *  frame so it lands after the menu's own input has finished unmounting —
   *  otherwise the browser moves focus to <body> right after we set it. */
  const focusConsole = useCallback(() => {
    const s = sessions.get(sid);
    if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [sid]);

  // Every time the picker OPENS — not once. The `repos.length` short-circuit was
  // a fetch-once, so a worktree cut after this strip first loaded never showed:
  // the list stayed frozen until a full app restart. Re-reading on each open is
  // cheap and is the only way new worktrees (and branches) appear here the way
  // they already do in Source control.
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[] }>({ current: "", branches: [] });
  const refreshPicker = useCallback(() => {
    if (IS_DEMO) return;
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
    if (root) api.gitBranches(root).then(setBranchData).catch(() => {});
  }, [root]);
  const chooseRepo = (next: string) => {
    setPicked(next);
    try { localStorage.setItem(CONSOLE_ROOT_KEY, next); } catch { /* private mode — lasts the session */ }
    focusConsole();
  };
  // A local branch with no worktree of its own: switch by checking it out in the
  // console's current directory, then refresh so the list reflects the move.
  const checkoutHere = async (name: string) => {
    // Never silently. See lib/checkoutWarning.ts for why each sentence is there.
    const t = { branch: name, dir: here?.name ?? root.split("/").pop() ?? root, displacing: here?.branch ?? null, dirty: here?.dirty ?? 0 };
    if (needsCheckoutConfirm(t) && !(await ask(checkoutConfirm(t)))) return;
    api.gitCheckout(root, name).then((r) => {
      if (!r.ok) return;
      api.gitRepos().then(({ repos: rr }) => setRepos(rr)).catch(() => {});
      focusConsole();
    }).catch(() => {});
  };
  /** Same guard as the terminal view: a chip must not type into vim. */
  const [blocked, setBlocked] = useState<string | null>(null);
  // Also carries refusals from `runInConsole`, which other panels call.
  useEffect(() => {
    if (!open) return;
    consoleBlocked = setBlocked;
    return () => { consoleBlocked = () => {}; };
  }, [open]);
  const runHere = useCallback((cmd: string, force = false) => {
    const s = sessions.get(sid);
    if (!s || IS_DEMO) return;
    if (runInShell(s, cmd, force)) setBlocked(null);
    else setBlocked(cmd);
  }, [sid]);

  // One console shell per repo, reused. `sessionsFor` already orders by
  // creation, so the first console-tagged one is stable across remounts.
  useEffect(() => {
    if (!open || !root || IS_DEMO) return;
    const existing = sessionsFor(root).find((x) => x.title === CONSOLE_TITLE);
    const s = existing ?? createSession(root);
    s.title = CONSOLE_TITLE;
    // Its own shell, never the desk's tmux session — see Sess.console.
    s.console = true;
    setSid(s.id);
  }, [open, root]);

  useEffect(() => {
    if (!open || IS_DEMO) return;
    const s = sessions.get(sid);
    const el = slot.current;
    if (!s || !el) return;
    el.appendChild(s.holder);
    releaseHeld(s); // on screen here, whatever the terminal view is doing
    if (!s.opened) { s.term.open(s.holder); s.opened = true; }
    // On screen: it gets its canvases. Before the fit below, so the first
    // measurement is the one the renderer that will draw it makes.
    attachRenderer(s);
    s.term.options.theme = themeFromCss();
    const unTheme = applyThemeLive(s);
    s.subs.add(redraw);
    // Debounced: a ResizeObserver fires on every frame of a drag, and each fit
    // reflows the entire scrollback *and* sends a resize ioctl to the shell.
    // Undebounced that is the drag stuttering and the shell being told sixty
    // different sizes on the way to the one that matters.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const doFit = () => { try { fitTerm(s); } catch { /* not measurable yet */ } };
    const fitSoon = () => { if (fitTimer) clearTimeout(fitTimer); fitTimer = setTimeout(doFit, 100); };
    doFit();
    /* The first shell waits for a server; nothing else here does.
       A pty socket opened before the sidecar is listening is a refused
       connection, and Chromium logs it whether or not the reconnect picks it
       up — the same reason the fetch layer and the live socket stopped asking
       early. `connect` keeps its own `s.ws` guard and its onmessage still
       checks identity, so this only delays the FIRST attempt; the status is
       re-read after the wait because a session connected meanwhile must not be
       connected twice. `then(go, go)`: a latch that rejected still opens the
       shell rather than leaving a dead panel. */
    if (s.status === "idle") {
      const go = () => { if (s.status === "idle") connect(s); };
      void whenServerUp().then(go, go);
    }
    // Opening a shell is asking to type in it. The strip mounted focused on
    // nothing, so every open cost a click on the black area before the first
    // keystroke landed — and a click that does nothing visible is a click you
    // forget you have to make. Same rAF as the terminal view's own focus: the
    // element has to be attached and laid out first.
    requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
    const ro = new ResizeObserver(fitSoon);
    ro.observe(el);
    return () => {
      if (fitTimer) clearTimeout(fitTimer);
      ro.disconnect();
      unTheme();
      s.subs.delete(redraw);
      // Detached, never killed: the shell and its scrollback outlive the strip
      // being closed, so reopening lands you back in the same session. What it
      // does give back is the renderer's memory — see parkRenderer.
      if (s.holder.parentElement === el) el.removeChild(s.holder);
      parkRenderer(s);
    };
  }, [open, sid]);

  // Drag the top edge. Bounded so it can neither vanish nor swallow the panel
  // it is a strip of.
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => {
      const next = Math.min(0.85, Math.max(0.08, startH + (startY - ev.clientY) / window.innerHeight));
      onHeight(next);
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sess = sessions.get(sid);
  if (!open) return null;
  return (
    <div className="shrink-0 flex flex-col" style={{ height: `${Math.round(height * 100)}%`, borderTop: LINE }}>
      {/* Rendered, or the question it asks is a promise nobody ever answers. */}
      {dialog}
      {/* The strip's own toolbar. Everything in it stops the drag from
          starting — the whole bar is the resize handle, so a click that also
          began a drag would move the console every time you opened a menu. */}
      <div onMouseDown={drag}
        className="shrink-0 flex items-center gap-2 px-3 py-1 cursor-row-resize select-none"
        style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
        <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: "var(--primary-hover)" }}>console</span>

        {/* Which checkout this shell is in. The console is where migrations get
            run, and on a worktree-per-ticket repo the right directory is rarely
            the one the terminal view happens to be sitting in — so it picks its
            own, and remembers it. */}
        <div className="shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          {/* keepTermFocus so opening the picker does not blur the console; the
              filter input inside autofocuses on its own, and closing hands the
              cursor back. */}
          <span onMouseDown={keepTermFocus}>
            <CheckoutPicker
              repos={repos} value={root} onPick={chooseRepo}
              branches={{ items: branchData.branches, onCheckout: checkoutHere }}
              onOpenChange={(o) => { setPickerOpen(o); if (o) refreshPicker(); }} onDismiss={focusConsole}
              disabled={IS_DEMO} placeholder="No repo" triggerMaxWidth={200}
              emptyLabel="Reading repos…"
            />
          </span>
        </div>

        {sess && <span className="text-[10px] shrink-0" style={{ color: SESS_DOT[sess.status].color }}>● {SESS_DOT[sess.status].label}</span>}

        {/* The same control the terminal view mounts — commands and pins, one
            component, so the two shells cannot drift apart again. Opens upward:
            there is nothing below this strip to open into. */}
        <div className="flex items-center gap-2 min-w-0" onMouseDown={(e) => e.stopPropagation()}>
          <CommandBar root={root} disabled={!sid} font={TERM_FONT} onRun={runHere} runTargetInTmux={consoleInTmux(root)} onClose={focusConsole} dropUp />
        </div>

        {blocked && (
          <div className="min-w-0" onMouseDown={(e) => e.stopPropagation()}>
            <BlockedNotice cmd={blocked} onSend={() => { runHere(blocked, true); setBlocked(null); }} onDismiss={() => setBlocked(null)} />
          </div>
        )}

        <span className="ml-auto text-[10px] t-dim2 shrink-0">Drag to resize</span>
        <CloseButton onClick={(e) => { e.stopPropagation(); onClose(); }} onMouseDown={(e) => e.stopPropagation()} title="Hide the console (the shell keeps running)" className="shrink-0" />
      </div>
      {/* The strip is a terminal pane too, and the one with the strongest case:
          it lives UNDER another panel, so you arrive at it from above every
          time. Same switch and the same guards — a picker open above it is
          somebody typing, and a held button is a selection being dragged. */}
      <div ref={slot} className="flex-1 min-h-0" style={{ background: "var(--bg)" }}
        onClick={() => sess?.term.focus()}
        onMouseEnter={(e) => {
          if (shouldFocusOnHover({ enabled: ffm, buttons: e.buttons, typing: pickerOpen, visible: open })) focusConsole();
        }} />
    </div>
  );
}

/**
 * The worktree the focused pane's agent is working in, read from what it prints.
 *
 * The process cwd is no help — every agent's shell, its `claude`, and their
 * children sit in the PARENT repo; the agent reaches into a worktree with
 * `git -C` and `cd` in subcommands without moving its own directory. But the
 * tool calls it prints DO name the checkout it edits (`Update(~/code/orbit-
 * WEB-1042/…)`), and that is on screen. So scan the scrollback bottom-up for the
 * most recently named worktree folder — matched as a whole path segment, so
 * `code/orbit` is not caught inside `code/orbit-WEB-1042`. Only linked worktrees
 * are candidates; the parent repo is the shell's own cwd (the noise) and never
 * what we mean. Null when nothing recognisable is there (a fresh agent, one in
 * the repo root), where the caller falls back to the picker.
 *
 * Best-effort by nature: it reads output, not a fact the app was handed. Bounded
 * to the last screens so a stale line from a tmux window switched away from does
 * not win over the window on screen now.
 */
function detectPaneWorktree(term: Terminal | undefined, worktrees: GitRepoRef[]): GitRepoRef | null {
  if (!term || !worktrees.length) return null;
  const cands = worktrees.map((r) => ({ r, leaf: dirName(r.root) }));
  const AFTER = "/ ):'\",";
  try {
    const buf = term.buffer.active;
    const top = buf.baseY + buf.cursorY;
    for (let y = top; y >= Math.max(0, top - 250); y--) {
      const line = buf.getLine(y)?.translateToString(true);
      if (!line) continue;
      for (const c of cands) {
        let i = line.indexOf(c.leaf);
        while (i >= 1) {
          const after = line[i + c.leaf.length];
          if (line[i - 1] === "/" && (after === undefined || AFTER.includes(after))) return c.r;
          i = line.indexOf(c.leaf, i + 1);
        }
      }
    }
  } catch { /* buffer not ready — fall back to the picker */ }
  return null;
}

/**
 * The card this branch came from, beside the pull request it became.
 *
 * The same id the pull request panel reads, off the same branch name — a
 * worktree is cut per card here, so the branch says which one far more reliably
 * than anything else on screen. It earns its place in the terminal's chrome for
 * the same reason the PR chip does: this bar is the answer to "what am I in",
 * and until now it could name the branch and its pull request but not the thing
 * both of them are about.
 *
 * Its own component so the ClickUp lookup is a hook in a component that always
 * renders it, never a hook inside the conditional block that draws the bar.
 *
 * Silent when there is no id in the branch, and when there is one from a tracker
 * this machine cannot resolve — see `chipAction`. A dead pill in permanent
 * residence would be worse than no pill.
 */



/**
 * Resolves one tab's card, pull request and checks, and writes them into
 * that tab's own record (lib/tabFacts.ts) — nothing here is returned for a
 * caller to build props from on every render. `root`/`branch` are this tab's
 * own, already resolved (see the detection effect below, and `SlotBar`); this
 * hook is what used to be `usePaneFacts`, changed only in where the answer
 * goes.
 *
 * `active` gates the one real fetch (the pull request itself, and its
 * checks) — see `refreshTargets` in lib/tabFacts.ts: only the active tab
 * pays for either, and an inactive tab simply keeps whatever this hook wrote
 * the last time it WAS active.
 */
function useTabFactsWriter(tabId: string, root: string | null, branch: string, worktreeOf: string | null | undefined, active: boolean, named?: string | null) {
  const setup = useOwnerSetup(useClickupSetup());
  /* The card the start named wins over the branch guess; an old key from the
     branch shows its Jira twin (lib/tabCard.ts, looked up once per key). */
  const twinV = useSyncExternalStore(twins.subscribe, twins.version, () => 0);
  const ref = useMemo(() => tabCardRef(named, branch, setup?.jira ? twins.twinOf : () => null, setup?.jira), [named, branch, twinV, setup?.jira]);
  const go = chipAction(ref, setup);
  /* The card comes from the SAME store the card view reads (prCardStore), so a
     status changed there is the status drawn here and nothing in this file keeps
     a second copy of it. The priority also lives in the module-level memory the
     pane's own reads fill, which is what draws the colour on the first frame of
     a launch before the store has answered. */
  useSyncExternalStore(onCard, cardVersion, () => 0);
  /* Nothing to ask when no tracker is connected: without the gate every
     pane bar on a machine that never set one up sent a lookup per hover,
     each answered with the same "not connected". With Jira connected too, a
     card that is Jira's is not looked up in ClickUp. */
  const gated = !!ref && !!setup?.connected && !(setup.ownerOf && setup.ownerOf(ref, true).owner !== "clickup");
  const task = gated && ref ? cardOf(ref.query)?.task ?? null : null;
  useEffect(() => { if (gated && ref && task) rememberPrio(ref.query, task.priority ?? null); }, [gated, ref?.query, task?.priority]);
  const prio = (task?.priority ?? (gated && ref ? cardPrioCache.get(ref.query)?.priority : null) ?? null);
  const square = cardSquare(task?.status, task?.statusColor);

  /* The pull request itself: this tab's own fetch, kept warm for a minute
     (BRANCH_PR_TTL) so switching tabs several times a minute costs nothing.
     Only while `active` — an inactive tab's record is left exactly as this
     ran it last. */
  const [raw, setRawPr] = useState<{ repo: string; pr: PrBranchSummary; root: string; branch: string } | null>(null);
  useEffect(() => {
    if (!active || IS_DEMO || !root || !branch) { setRawPr(null); return; }
    const key = `${root}\u0000${branch}`;
    const mine = (repo: string, pr: PrBranchSummary) => ({ repo, pr, root, branch });
    const seen = branchPrCache.get(key);
    if (seen && Date.now() - seen.at < BRANCH_PR_TTL) {
      const t = chipTarget(seen.repo, seen.pr);
      setRawPr(t.kind === "open" ? mine(t.repo, t.pr) : null);
      return;
    }
    setRawPr(null);
    let live = true;
    void (async () => {
      const r = await api.prsForBranch(root, branch);
      let from = r.from ?? null;
      /* `for-branch` answers OPEN pull requests only. A branch whose pull
         request has landed would draw nothing, so when there is no open one the
         branch is asked once more in any state. A main checkout has no branch of
         its own to ask about. */
      if (!from && worktreeOf !== undefined && r.repo) {
        const h = await api.prForHead(root, branch).catch(() => null);
        const found = h?.ok ? h.pr : null;
        if (found && found.state !== "OPEN") from = { number: found.number, title: "", author: "", state: found.state, isDraft: found.isDraft, headRefName: found.headRefName, baseRefName: found.baseRefName, url: found.url, updatedAt: "", reviewDecision: null };
      }
      rememberBranchPr(key, { at: Date.now(), repo: r.repo ?? null, pr: from });
      if (r.repo && from) notePrs(r.repo, [from]);
      if (!live) return;
      const t = chipTarget(r.repo, from);
      setRawPr(t.kind === "open" ? mine(t.repo, t.pr) : null);
    })().catch(() => { if (live) setRawPr(null); });
    return () => { live = false; };
  }, [active, root, branch, worktreeOf]);
  const pr = prForPane(raw, root ?? "", branch);

  useSyncExternalStore(onPrFacts, prFactsVersion, () => 0);
  useSyncExternalStore(onRollup, () => peekRollup(root ?? "", pr?.pr.number ?? 0)?.at ?? 0, () => 0);
  const prNumber = pr?.pr.number ?? 0;
  const read = pr ? freshestPr(pr.pr, 0, prFactOf(pr.repo, pr.pr.number)) : null;
  const rollup = prNumber ? peekRollup(root ?? "", prNumber) : null;
  const checks = checksOf(rollup);
  /* The server's watch reads checks for pull requests somebody follows; when it
     says so, the store takes it with no request. */
  useEffect(() => {
    if (!pr) return;
    return onChecksRead((r) => { if (r.repo === pr.repo && r.number === pr.pr.number) putRollup(root ?? "", r.number, r.checks); });
  }, [pr?.repo, prNumber, root]);
  /* Reads the checks once per pull request while active (the store dedups and
     holds them a minute); an inactive tab is left with its last answer. */
  useEffect(() => { if (active && prNumber) rollupOf(root ?? "", prNumber); }, [active, prNumber, root]);
  const reviewWord = read?.reviewDecision === "APPROVED" ? "Approved" : read?.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : read?.reviewDecision === "REVIEW_REQUIRED" ? "Review required" : undefined;
  const status = pr && read ? { number: pr.pr.number, title: pr.pr.title, state: prState(read), author: pr.pr.author, base: pr.pr.baseRefName } : null;

  useEffect(() => {
    liveTabFacts.write(tabId, {
      card: ref ? {
        label: ref.label, query: ref.query, ...(go?.in === "tasks" && go.tracker ? { tracker: go.tracker } : {}),
        status: square?.title ?? null, color: square?.color ?? null, priority: prio, action: go,
      } : null,
      pr: status ? { repo: pr!.repo, number: status.number, title: status.title, state: status.state, author: status.author, base: status.base, checks, review: read ? reviewOf(read.reviewDecision, status.state) : "none", ...(reviewWord ? { reviewWord } : {}) } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, ref?.label, ref?.query, go, square?.title, square?.color, prio, status?.number, status?.title, status?.state, status?.author, status?.base, checks.state, checks.passed, checks.total, reviewWord]);
}

/**
 * The bar for one pane: a pure reader of its own tab's record
 * (lib/tabFacts.ts) — card, pull request and checks are drawn exactly as
 * `useTabFactsWriter` last resolved them for `tabId`, never re-derived here.
 */
function PaneBarFor({ foot, near, blocked, flash, mode, marker, pill, at, tabId, onDown, onGit, onDiff, onPr, onCopy, onEscape, selection, onAsk, onSide }: {
  foot: { left: number; top: number; width: number; atRight?: boolean };
  near: boolean;
  blocked: boolean;
  flash: number;
  mode: "edge" | "summary" | "always";
  marker: "line" | "arrow";
  pill: { lift: boolean; translucent: boolean };
  at: GitRepoRef;
  /** Which tab's own record to read. */
  tabId: string;
  onDown: (e: React.MouseEvent) => void;
  onGit: () => void;
  onDiff: () => void;
  onPr: () => void;
  onCopy: () => void;
  onEscape: () => void;
  /** The focused pane's selection, when there is one — the bar offers to ask about it. */
  selection?: string;
  onAsk?: () => void;
  /** Card, pull request and Diff open the pane beside the terminal on that section; the full views are its pop out. */
  onSide?: (section: SideSection) => void;
}) {
  useSyncExternalStore(liveTabFacts.subscribe, liveTabFacts.version, () => 0);
  const card = liveTabFacts.get(tabId)?.card ?? null;
  const pr = liveTabFacts.get(tabId)?.pr ?? null;
  return (
    <PaneBar
      foot={foot}
      mode={mode}
      marker={marker}
      pill={pill}
      near={near}
      blocked={blocked}
      flash={flash}
      kind={at.worktreeOf ? "worktree" : "main"}
      repo={at.name}
      branch={at.branch || at.name}
      dirty={at.dirty}
      ahead={at.ahead}
      behind={at.behind}
      onDown={onDown}
      onGit={onGit}
      onDiff={onSide ? () => onSide("diff") : onDiff}
      onCopy={onCopy}
      onEscape={onEscape}
      ask={selection && onAsk ? { lines: selection.split("\n").length, onAsk } : null}
      pr={pr ? { number: pr.number, title: pr.title, state: pr.state, author: pr.author, base: pr.base } : null}
      checks={pr?.checks}
      review={pr?.review ?? "none"}
      reviewWord={pr?.reviewWord}
      onPr={pr ? (onSide ? () => onSide("pr") : onPr) : undefined}
      onPrReach={pr ? () => { rollupOf(at.root, pr.number); } : undefined}
      card={card ? { id: card.label, priority: card.priority ? card.priority.toLowerCase() : null, status: card.status, statusColor: card.color, inApp: card.action?.in === "tasks" } : null}
      onCard={card?.action ? () => {
        if (card.action!.in === "tasks") { if (onSide) onSide("card"); else openCard(card.query, card.label, card.tracker); } else openExternal(card.action!.url);
      } : undefined}
    />
  );
}

interface SidePaneFactsProps {
  tab: string;
  view: ReturnType<typeof viewOf>;
  width: number;
  active: boolean;
  at: GitRepoRef | null;
  overlay: boolean;
  hidden?: boolean;
  onPopOut: (section: SideSection) => void;
  focusTerm: () => void;
  onType: (text: string) => void;
}

/**
 * The side pane for the focused pane's checkout — a pure reader of the SAME
 * tab record the bar reads, keyed by `tab`, so the two never disagree and a
 * switch never fetches, spins or shows an empty frame: the record is read as
 * it stands, and a background refresh (`useTabFactsWriter`, above) can only
 * update the ACTIVE tab's own row.
 */
function SidePaneFor(p: SidePaneFactsProps) {
  return <SidePaneWithFacts {...p} />;
}

function SidePaneWithFacts({ tab, view, width, active, at, overlay, hidden, onPopOut, focusTerm, onType }: SidePaneFactsProps) {
  useSyncExternalStore(liveTabFacts.subscribe, liveTabFacts.version, () => 0);
  const facts = liveTabFacts.get(tab);
  const pr = facts?.pr ?? null;
  const card = facts?.card ?? null;
  const tone: BadgeTone = !pr ? "accent"
    : pr.checks.state === "failing" ? "bad" : pr.checks.state === "passing" ? "good" : pr.checks.state === "running" ? "warn" : "none";
  const prText = !pr ? "new"
    : pr.checks.state === "failing" ? `${pr.checks.failing.length} failing`
    : pr.checks.state === "passing" ? "passing" : pr.checks.state === "running" ? "running" : `#${pr.number}`;
  const subject: SideSubject | null = !at ? null : {
    key: `${at.root}:${at.branch}`,
    root: at.root,
    branch: at.branch || at.name,
    card: card ? { query: card.query, label: card.label, ...(card.tracker ? { tracker: card.tracker } : null) } : null,
    cardStatus: card?.status ?? null,
    cardColor: card?.color ?? null,
    pr: pr ? { repo: pr.repo, number: pr.number, title: pr.title } : null,
    prText,
    prTone: tone,
    reviewText: pr ? [pr.reviewWord, pr.checks.state === "none-read-yet" ? "" : checksWords(pr.checks)].filter(Boolean).join(" · ") : "",
    diffText: at.dirty ? `${at.dirty} changed` : "clean",
    filter: dirName(at.root),
  };
  return <SidePane tab={tab} view={view} width={width} active={active} subject={subject} overlay={overlay} hidden={hidden} onPopOut={onPopOut} focusTerm={focusTerm} onType={onType} />;
}

/**
 * The chip under a pane that is NOT the focused one, in Always open.
 *
 * A pure reader, like the bar and the pane above: it draws `liveTabFacts`'s
 * record for this slot's own tmux window, and fetches nothing — only the
 * ACTIVE tab refreshes (`useTabFactsWriter`, bound to the focused pane
 * below), so an inactive slot shows exactly what was last resolved for it,
 * which in practice is "whatever it answered the last time it WAS the
 * focused tab" (every window is focused once, the moment it is made). A
 * window nothing has ever focused shows nothing, honestly, rather than a
 * guess — see `TabFactsStore.get` in lib/tabFacts.ts. A plain shell with no
 * tmux window at all still falls back to its own scrollback scan, as before.
 */
function SlotBar({ sessId, foot, repos, project, open, canSide, flash, onOpenProject, onFocusMe, onSide }: {
  sessId: string;
  foot: { left: number; top: number; width: number; atRight?: boolean };
  repos: GitRepoRef[];
  project: string;
  open: boolean;
  /** False when the pane cannot draw (commands off, no root): the chips keep their full-view jumps. */
  canSide: boolean;
  flash: number;
  onOpenProject: (name: string) => void;
  onFocusMe: () => void;
  /** `tab` is the clicked slot's own window: the focus has not moved yet when this runs. */
  onSide: (section: SideSection, tab: string) => void;
}) {
  const sess = sessions.get(sessId);
  const win = sess?.tmuxWindows?.find((w) => w.active)?.id ?? "";
  useSyncExternalStore(liveTabFacts.subscribe, liveTabFacts.version, () => 0);
  const facts = win ? liveTabFacts.get(win) : undefined;
  const cands = useMemo(() => paneCandidates(repos, project), [repos, project]);
  const scanned = !win && sess ? detectPaneWorktree(sess.term, cands) : null;
  const wt = facts?.root ? cands.find((r) => r.root === facts.root) ?? null : scanned;
  const focusMine = (e: React.MouseEvent) => { onFocusMe(); keepTermFocus(e); };
  if (!wt) {
    return (
      <PaneBar foot={foot} mode="always" marker="line" pill={{ lift: false, translucent: false }} near={false} blocked={!!sess?.tmuxPopup} branch="" dirty={0}
        kind="none" loading={false}
        note={win ? "Not opened yet — select this tab once" : paneNote(false, null, "", dirName(project))}
        onDown={focusMine} onGit={() => {}} onDiff={() => {}} onCopy={() => {}} onEscape={() => { try { sess?.term.focus(); } catch { /* disposed */ } }} />
    );
  }
  return (
    <PaneBarFor
      foot={foot} mode="always" marker="line" pill={{ lift: false, translucent: false }} near={false} blocked={!!sess?.tmuxPopup} flash={flash}
      at={wt} tabId={win} onSide={canSide ? (sec) => { onFocusMe(); onSide(sec, win || sessId); } : undefined}
      onDown={focusMine}
      onGit={() => requestWorktreeJump({ view: "git", root: wt.root })}
      onDiff={() => requestWorktreeJump({ view: "diff", filter: dirName(wt.root) })}
      onPr={() => { if (facts?.pr) openPr(facts.pr.repo, facts.pr.number); }}
      onCopy={() => { void navigator.clipboard?.writeText(wt.worktreeOf ? wt.branch : wt.name).catch(() => { /* no permission */ }); }}
      onEscape={() => { try { sess?.term.focus(); } catch { /* disposed */ } }}
    />
  );
}

/** Card id → its priority, or null for a card that has none. Module level, so
 *  it survives the panel closing — and written down, so it survives the app
 *  closing: a card's priority changes about as often as somebody says so out
 *  loud, and asking ClickUp for it costs 450 ms per card. See lib/paneFacts. */
const cardPrioCache = new Map<string, RememberedPrio>(readCardPrios());
const rememberPrio = (key: string, priority: string | null) => {
  cardPrioCache.set(key, { priority, at: Date.now() });
  writeCardPrios(cardPrioCache);
};

/**
 * The pull request out of a branch, remembered for a minute.
 *
 * The chip re-asks whenever the focused pane changes worktree, and switching
 * between two tmux tabs is something you do several times a minute — without a
 * cache that is a GitHub call per switch, on a rate limit shared with the whole
 * PR panel. A minute is short enough that opening a pull request and coming
 * back shows it, and long enough that flipping between tabs costs nothing.
 *
 * Module-level, so it survives the panel being closed and reopened. Keyed by
 * root AND branch: the same branch name in two checkouts is two branches. Not
 * cwd- or focus-keyed, so it was never part of the cross-tab bug and is kept.
 */
const branchPrCache = new Map<string, { at: number; repo: string | null; pr: PrBranchSummary | null }>(
  readBranchPrs() as [string, { at: number; repo: string | null; pr: PrBranchSummary | null }][]);
const rememberBranchPr = (key: string, v: { at: number; repo: string | null; pr: PrBranchSummary | null }) => {
  branchPrCache.set(key, v);
  writeBranchPrs(branchPrCache as unknown as Map<string, RememberedPr>);
};
/*
 * A minute before it is asked again — and a remembered answer is still DRAWN
 * while that happens.
 *
 * The two are different questions. "How old before I re-ask" is a minute,
 * because a pull request can appear at any time. "How old before I refuse to
 * draw it" is a day (see FACTS_MAX_AGE): the number and title of a branch's
 * pull request are the same tomorrow, and showing them instantly while the
 * answer is on its way is the difference between a block that is there and one
 * that arrives a second later, per pane, every launch.
 */
const BRANCH_PR_TTL = 60_000;

export function TermView({ active, onClose = () => {} }: { active: boolean; onClose?: () => void }) {
  const open = active;
  /** Whether a hover takes the keyboard — see lib/termFocusPref.ts. Subscribed
   *  rather than read once, so flipping the switch in Settings takes effect in
   *  the terminal you are looking at rather than at the next reload. */
  const ffm = useSyncExternalStore(subscribeFocusFollowsMouse, focusFollowsMouse, () => false);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const { askText, dialog } = useDialogs();
  const [root, setRoot] = useState<string>(() => { try { return localStorage.getItem(ROOT_KEY) || ""; } catch { return ""; } });
  /* The focused pane's selection, for the bar's "Ask about this". */
  const selection = useSyncExternalStore(subscribeSelection, currentSelection, () => "");
  /** The row for the directory we are standing in — what "here" means, by name,
   *  what it currently holds, and whether it has uncommitted work in it.
   *
   *  Below the `root` it reads, and that is not a style point: it sat above,
   *  and `root` is a `const` from useState, so the lookup ran in its temporal
   *  dead zone and threw on the panel's first render — a white window for
   *  anyone whose last view was the terminal. tsc cannot see it because the
   *  read is inside the `find` callback, where it looks deferred. */
  const here = repos.find((r) => r.root === root) ?? null;
  /** Only whether the server allows commands at all — the list, its dropdown
   *  and the pins are the shared CommandBar's business now. */
  const [cmds, setCmds] = useState<TerminalCommands | null>(null);
  /** Both dropdowns live in here, so one listener can tell "clicked outside"
   *  from "clicked a row". */
  // The "jump to a worktree's git / changes" dropdown. Separate from the repo
  // picker above (which switches the terminal itself): this one leaves the
  // terminal where it is and takes you to Source control / File changes for the
  // chosen worktree — with the one the focused pane's agent is in pinned on
  // top, which is a question the server answers (see panewt.ts) rather than one
  // this end guesses from the pane's own directory: that is the parent repo for
  // every agent in a fleet, which is what made it look unanswerable.
  /** No stored record for the focused tab YET. Distinct from "no worktree":
   *  the first is a read in flight and says so, the second is silence. Shown
   *  only on a genuine first visit — a tab `liveTabFacts` already has a
   *  record for (lib/tabFacts.ts) never shows this, whatever the read in
   *  flight finds. */
  const [wtDetecting, setWtDetecting] = useState(false);
  /** Where the pane says it is, when that is somewhere this app has no repo for.
   *  A pane in a checkout nobody scanned is not "no checkout": it is a place,
   *  and saying the place is both true and useful. */
  const [paneDir, setPaneDir] = useState<string | null>(null);
  const [paneOutside, setPaneOutside] = useState("");
  const wtRunRef = useRef<(() => void) | null>(null);
  const fillRef = useRef<(() => void) | null>(null);
  /*
   * The whole window's panes, asked for once instead of one per hover.
   *
   * The detection below needs the dirs of the pane under the pointer, and the
   * route answers about the pane tmux has SELECTED — so it could only be asked
   * after selecting, once per pane, as the pointer wandered. `all=1` brings the
   * lot back in one request off one `list-panes`, in the background, so the
   * first hover of every pane is already answered.
   */
  const paneBook = useRef(new Map<string, PaneBookEntry>());
  const paneBookWin = useRef("");
  /** Directories the repo list has already been asked about — see
   *  `unlistedWorktree`. */
  const askedRepos = useRef(new Map<string, number>());
  const containerRef = useRef<HTMLDivElement>(null);
  // The value is used, not just the dispatch: a session is MUTATED in place
  // and notified through `subs`, so an effect watching `sess.openFail` has no
  // identity change to fire on. This tick is that change.
  const [sessTick, force] = useReducer((x: number) => x + 1, 0);

  /*
   * Where a new shell opens. Not a choice any more — the open project.
   *
   * `repos[0]` is that project: the scoped repo list leads with it and orders
   * the worktrees after. A remembered root that is no longer in the list is
   * DROPPED rather than kept, because a stale one from a previous scope would
   * silently open shells, and list commands, in a repo outside the project.
   */
  /*
   * Asked for on MOUNT, not on becoming visible.
   *
   * This was gated on `open`, and the checkout it settles is not the terminal's
   * — Git, the pull requests and the boards all read it. This view is always
   * mounted, so on a machine that reopened on Git the effect simply never ran:
   * the panel sat there with nothing in it until you stepped through Terminal
   * once, and then everything worked at once. Reported exactly that way.
   *
   * `open` stays in the deps so the list is also re-read when you come back to
   * this view, which is where a worktree made elsewhere shows up.
   */
  const [reposKnown, setReposKnown] = useState(false);
  useEffect(() => {
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      setRoot((cur) => (cur && repos.some((r) => r.root === cur) ? cur : repos[0]?.root || ""));
    }).catch(() => {}).finally(() => setReposKnown(true));
  }, [open]);
  /*
   * Still written, even though nobody picks it.
   *
   * The docked console falls back to this key when it has no pick of its own
   * (see `consoleRoot`). Dropping the write is what would silently break
   * `docker exec` and recipe runs on a profile that has never opened the
   * console's own picker — `runInConsole` just returns false, with no error and
   * no toast.
   */
  useEffect(() => { if (root) { try { localStorage.setItem(ROOT_KEY, root); } catch { /* ignore */ } } }, [root]);
  useEffect(() => {
    if (!open || !root) return;
    setCmds(null);
    loadCommands(root).then(setCmds);
  }, [open, root]);

  // Which shells are on screen. One id per visible pane: a single pane is the
  // plain case, and a split shows several at once the way tmux does — the point
  // being to watch a build in one while working in another.
  const [paneIds, setPaneIds] = useState<string[]>([]);
  // Eviction is module-level and the panes are here, so it is told rather than
  // left to guess — see setOnScreenSessions.
  useEffect(() => { setOnScreenSessions(paneIds); }, [paneIds]);
  const [focusIdx, setFocusIdx] = useState(0);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);
  type Mounted = { s: Sess; el: HTMLDivElement; ro: ResizeObserver; unTheme: () => void; stopFit: () => void };
  const mountedRef = useRef(new Map<string, Mounted>());
  const mountedIdsRef = useRef<string[]>([]);
  const unmountAllRef = useRef<() => void>(() => {});
  /*
   * The four buttons drawn ON a pane — see components/terminal/PaneActions.
   *
   * Two pieces of state and no new data: WHICH slot the pointer is in, and
   * where the block goes inside it. Everything the buttons open is already
   * resolved for the bar at the top (chipWt, and the tab's own record for its card and pull request),
   * because the pane under the pointer is the pane tmux has just been told to
   * select — the same one the bar is describing.
   *
   * The box is measured rather than laid out: tmux panes are rectangles of
   * character cells painted into one xterm canvas, so there is no element to
   * hang a corner off. See lib/paneBox.ts.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [actionsIdx, setActionsIdx] = useState<number | null>(null);
  const [footBox, setFootBox] = useState<{ left: number; top: number; width: number; atRight?: boolean } | null>(null);
  /** Always open draws under EVERY pane: each slot's own foot (null when too narrow). */
  const [slotFoots, setSlotFoots] = useState<({ left: number; top: number; width: number; atRight?: boolean } | null)[]>([]);
  /* The pointer is in the seam's zone. Kept here rather than in the bar because
     the seam takes no pointer events at all — the terminal's bottom rows keep
     every click — so the pane slot, which is already watching the pointer for
     tmux, is what reports it. */
  const [seamNear, setSeamNear] = useState(false);
  /* A stamp rather than a boolean: two copies in a row are two answers, and a
     boolean that is already true has nothing to say the second time. */
  const [copyFlash, setCopyFlash] = useState(0);
  const footRef = useRef<{ left: number; top: number; width: number; atRight?: boolean } | null>(null);
  const wrapRect = useRef<{ left: number; top: number } | null>(null);
  const [actionsMode, setActionsMode] = useState(paneActionsMode);
  const [marker, setMarker] = useState(paneMarker);
  useEffect(() => subscribePaneActions(() => { setActionsMode(paneActionsMode()); setMarker(paneMarker()); }), []);
  /** Summary's pill steps out of the way of the last line (pillPlacement). */
  const [pill, setPill] = useState({ lift: false, translucent: false });
  /** Bumped by anything that can move a pane under the pointer: a split, a
   *  resize, tmux redrawing its layout. */
  const [actionsTick, setActionsTick] = useState(0);

  /** Put the cursor back in the pane you were in. Called when a menu that had
   *  to borrow the focus for its own input — the repo filter, the commands
   *  filter, a window rename — closes again: the terminal is where typing
   *  should resume. Deferred a frame so it lands after the menu's input has
   *  unmounted, or the browser moves focus to <body> straight after we set it. */
  const focusTerm = useCallback(() => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [paneIds, focusIdx]);
  /**
   * ASK THE AGENT IN THIS PANE ABOUT WHAT IS SELECTED.
   *
   * A note is asked for (Enter with none sends "About this:"), then the note
   * and the quoted selection go into the pane through the same pty the keys
   * do — bracketed, so a CLI with an input box takes it as one paste, then
   * Enter. The agent that lives in the pane reads it as its next message; a
   * shell would read it as commands, which is why the button only stands when
   * the pane's worktree is one the board knows an agent in — see PaneBarFor.
   */
  const askAboutSelection = useCallback(async () => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    const sel = currentSelection();
    if (!s || !sel.trim()) return;
    /* Is there an agent in THIS pane? The board knows the panes agents fire
       hooks from; a pane it does not know is a shell, and a quoted traceback
       typed into a shell is a row of `>` redirects creating files. So: an
       agent's pane takes the message directly; anything else gets a fresh
       chat on the bench with the same message, in this checkout. */
    const paneId = s.tmuxPanes.find((p) => p.active)?.id ?? (s.tmuxPanes.length === 1 ? s.tmuxPanes[0]?.id : undefined);
    const agentHere = !!paneId && (lanternRows() ?? []).some((r) => r.paneId === paneId && r.role !== "lantern");
    const note = await askText({
      title: agentHere ? "Ask the agent in this pane" : "Ask about this in a new chat",
      body: sel.split("\n").slice(0, 6).join("\n").slice(0, 400) + (sel.length > 400 ? "\n…" : ""),
      input: { label: "Your note (what you want to know about it)", placeholder: "why does this fail?" }, confirmLabel: "Send",
    });
    if (note === null) return;
    const text = askAboutText(sel, note);
    try { s.term.clearSelection(); } catch { /* fine */ }
    if (!agentHere) { void askOnBench(s.root, text, "ask", undefined, JOB.askAboutSelection(text)); return; }
    if (s.status !== "live" || s.ws?.readyState !== WebSocket.OPEN) return;
    /* A shell that never asked for bracketed paste would print the markers as text. */
    if (!s.term.modes?.bracketedPasteMode) { s.ws.send(ptyFrame({ t: "in", d: text })); return; }
    s.ws.send(ptyFrame({ t: "in", d: `\x1b[200~${text}\x1b[201~` }));
    setTimeout(() => { if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(ptyFrame({ t: "in", d: "\r" })); }, 120);
  }, [paneIds, focusIdx, askText]);

  // Keep the focused pane's worktree fresh.
  //
  // The server answers first, from the agent's own working directory and the
  // transcript it is writing — see panewt.ts for why the screen cannot. The
  // scan of the terminal buffer stays behind it as a fallback, for a machine
  // whose agents do not report to this app at all: it can only add an answer
  // where there was none, and it is what this feature did on its own before.
  //
  // Polled rather than read on render because neither source changes in a way
  // React can see, and re-asked whenever the focused pane or the repo list
  // changes. Both ends are bounded — one tmux call and a cached tail.
  //
  // WHICH pane has the focus is not polled, though, and that was the bug: the
  // window id came off the same 4-second tick, so `^f n` moved the terminal
  // instantly and both worktree readouts sat on the previous tab's answer for
  // up to four seconds — long enough to read them, believe them, and click one.
  // tmux pushes the window and pane lists (~70ms after a switch redraws the
  // pane, see terminal.ts), so the focus is a value this render already holds:
  // read it here, key the effect on it, and the re-ask happens on the switch.
  const focusSess = sessions.get(paneIds[focusIdx] ?? "");
  /*
   * The window a click already jumped to, ahead of tmux's own confirmation —
   * see `resolveActiveWindow` in lib/sidePane.ts. Declared here, not only
   * where the strip reads it (`activeWindow` below): `focusWin` used to read
   * tmux's own (not yet updated) active window on its own, so the chip bar
   * and the side pane kept the window the click just left on screen for as
   * long as the select-and-push round trip to the server took, under the tab
   * the strip had already flipped to. One state, one function, read by both.
   */
  const [pendingWindow, setPendingWindow] = useState<string | null>(null);
  const focusWin = resolveActiveWindow(pendingWindow, focusSess?.tmuxWindows ?? []) ?? "";
  // Panes are only reported while the window is split, so this is "" for an
  // unsplit window — which is right: there is nothing to move between. When
  // there is, `^f o` changes the answer without changing the window, and the
  // server reads the ACTIVE pane of the window it is given.
  const focusPane = focusSess?.tmuxPanes?.find((p) => p.active)?.id ?? "";
  const focusKey = focusWin ? `${focusWin}:${focusPane}` : "";
  // What the hang watchdog reports as "the pane": the tmux window:pane when the
  // window is split, otherwise the shell's own id, which is the pane a person
  // points at either way.
  useEffect(() => { noteFocusedPane(focusKey || paneIds[focusIdx] || ""); }, [focusKey, paneIds, focusIdx]);
  /** The tab this record is written and read under: the tmux window when
   *  there is one, the session's own id for a plain shell (never a cwd,
   *  never a pane id, never a "currently focused" slot — see tabFacts.ts). */
  const identTabId = focusWin || paneIds[focusIdx] || "";
  useEffect(() => {
    if (!open || IS_DEMO) return;
    const project = here?.worktreeOf || here?.root || root;
    const cands = paneCandidates(repos, project);
    /* A plain shell has no tmux window to bind a card to and no pane to ask
       the server about: its own checkout is the only answer there is, known
       synchronously already — nothing to detect. */
    if (!focusWin) {
      if (identTabId) liveTabFacts.write(identTabId, { root: here?.root ?? null, branch: here?.branch ?? "" });
      setWtDetecting(false);
      return;
    }
    /* A revisit shows this tab's own stored record at once — see
       lib/tabFacts.ts. The skeleton below is for a genuine first visit only:
       a fresh read neither blanks what is already correct nor waits for one
       before showing it. */
    setWtDetecting(!liveTabFacts.get(focusWin));
    /* The tab's own bound card, pinned at launch and never touched by pane
       content — see `namedWorktree`. Decides ahead of the pane's own cwd
       whenever it names one of `cands`' own branches; this is what still
       tells two tabs apart once their cwd stops discriminating (several
       workers started in the SAME parent checkout, each reaching into its
       own worktree by absolute path rather than `cd`). */
    const win = focusSess?.tmuxWindows?.find((w) => w.id === focusWin);
    const { cardId } = resolveCardId(win?.name, win?.card, (s) => cardRef({ headRefName: s })?.label ?? null);
    let stopped = false;
    const run = async () => {
      try {
        /* The book first: it holds every pane of this window and is filled
           while nobody is waiting. A hover that finds its pane there costs
           nothing at all; one that does not falls back to the single-pane
           call, which is the case for a pane that appeared since. */
        /* Only an answer that was read for THIS window: on a tab switch this effect runs before the fill effect clears the book, and the previous tab's active pane (under "") answered for the new one. */
        const booked = bookedFor(paneBook.current, paneBookWin.current, focusWin, focusPane);
        let dirs: string[] = [];
        let outside = "";
        try {
          const r = booked ?? await api.paneDirs(focusWin);
          dirs = r.dirs; outside = r.outside ?? "";
        } catch { /* server busy or offline: the cwd fallback below is simply unknown this round */ }
        if (stopped) return;
        setPaneDir(dirs[0] ?? null);
        setPaneOutside(outside);
        const cwd = dirs[0] ?? project;
        const wt = resolveWorktree(cardId, cwd, cands, namedWorktree);
        /* The pane stands somewhere no candidate names: a worktree cut since
           the list was read. Read it again, once for that directory. */
        if (!wt && unlistedWorktree(dirs, cands, askedRepos.current)) {
          api.gitRepos().then(({ repos: rr }) => setRepos(rr)).catch(() => { /* next open re-reads it anyway */ });
        }
        liveTabFacts.write(focusWin, { root: wt?.root ?? null, branch: wt?.branch ?? "" });
      } finally { if (!stopped) setWtDetecting(false); }
    };
    void run();
    wtRunRef.current = () => { void run(); };
    return () => { stopped = true; wtRunRef.current = null; };
  }, [open, focusWin, focusPane, identTabId, paneIds, focusIdx, repos, root, here?.worktreeOf, here?.root, here?.branch]);
  /* Filled for the whole window as soon as there is one, and again when its
     panes change — a split, a new agent, a pane that went. Cheap: one request,
     one `list-panes`, and it runs while the pointer is somewhere else. */
  useEffect(() => {
    if (!open || !focusWin) return;
    let live = true;
    // The last window's panes must not answer for this one while the first read is out.
    paneBook.current = new Map();
    paneBookWin.current = focusWin;
    const fill = () => {
      void api.paneDirsAll(focusWin).then((r) => {
        if (!live || !r?.ok) return;
        /* Replaced, not added to: a pane that went must not answer for the
           pane that gets its id next. */
        paneBook.current = bookPanes(r.panes ?? []);
        paneBookWin.current = focusWin;
      }).catch(() => { /* the per-pane call still answers */ });
    };
    fill();
    fillRef.current = fill;
    return () => { live = false; fillRef.current = null; };
  }, [open, focusWin, paneIds.length]);
  /* ONE timer for both reads above, and only while the window is looked at.
     They were two setIntervals on the same 4 s beat, ungated: 15 identical
     `pane-dirs?all=1` requests a minute (one `list-panes` each) for a window
     nobody had focused. The ceiling: an agent that moves worktree while the
     window is unfocused shows on the next focus, which polls at once. */
  usePoll(open, () => { wtRunRef.current?.(); fillRef.current?.(); }, PANE_BEAT_MS);
  /* The server says a git write happened (or a re-root), or tmux said a window opened/closed or a pane's directory moved (`panedirs`): read at once, so the beat is only the backstop for a change nobody pushes. */
  useEffect(() => open ? subscribeGitChanged(() => { wtRunRef.current?.(); fillRef.current?.(); }) : undefined, [open]);
  useEffect(() => open ? subscribePaneDirsChanged(() => { wtRunRef.current?.(); fillRef.current?.(); }) : undefined, [open]);
  /* A re-root (recwd, enlist) is pushed by the server: read this pane and the
     repo list NOW. The directory is forgotten as "asked" so the list is read
     again for it; nothing waits for the 4 s beat or the 60 s retry. */
  useEffect(() => onTabRoot((n) => {
    askedRepos.current.delete(n.cwd);
    api.gitRepos().then(({ repos: rr }) => setRepos(rr)).catch(() => { /* the poll asks again */ }).finally(() => { fillRef.current?.(); wtRunRef.current?.(); });
  }), []);

  /* The first render after a tab switch still holds the previous tab's answer (the effect that
     replaces it runs after paint); a checkout read for another pane is nothing for this one.
     `liveTabFacts` stands in for that gap instead of leaving it blank: keyed by `identTabId`
     alone, it already holds this exact tab's own last resolved answer (never another one's —
     nothing here is keyed by cwd, by the focused pane, or by a "current" slot), so a revisit
     shows it at once instead of waiting for a fresh read. */
  useSyncExternalStore(liveTabFacts.subscribe, liveTabFacts.version, () => 0);
  const identCands = paneCandidates(repos, here?.worktreeOf || here?.root || root);
  const storedRoot = identTabId ? liveTabFacts.get(identTabId)?.root ?? null : null;
  const rawWt = storedRoot ? identCands.find((r) => r.root === storedRoot) ?? null : null;
  const chipWt = chipWorktree(rawWt, wtDetecting, !!focusSess?.tmux, here);
  /** The scanned project a checkout outside this window's own belongs to, when this app knows one by that name. */
  const outsideRepo = paneOutside ? repos.find((r) => r.name === paneOutside || dirName(r.root) === paneOutside) ?? null : null;
  const wtRef = useRef<GitRepoRef | null>(null);
  useEffect(() => { wtRef.current = chipWt; }, [chipWt]);
  /** The same tab id, readable from outside React — see `paneDoor`, which
   *  reads `liveTabFacts.get(identTabIdRef.current)` directly rather than
   *  shadowing the card/pull-request fields in refs of their own. */
  const identTabIdRef = useRef("");
  useEffect(() => { identTabIdRef.current = identTabId; }, [identTabId]);
  /* The card, the pull request and their checks: resolved and written into
     this tab's own record by `useTabFactsWriter` (above) — the bar and the
     side pane both read it from there, never from a hook each one calls for
     itself. */
  useTabFactsWriter(identTabId, storedRoot, chipWt?.branch ?? "", chipWt?.worktreeOf, open, focusSess?.tmuxWindows?.find((w) => w.id === focusWin)?.card);
  /* The pill's own beat: the focused pane's checkout, re-read through the
     single-row route so a rename or an edit shows in seconds. Same gate as the
     poll above (the window is looked at); the list the row lives in is held by
     the server for 15 s and was read once, on open. See repoPulse.ts. */
  const readPill = () => {
    const at = wtRef.current?.root;
    if (!at) return;
    void api.gitRepo(at).then((r) => setRepos((cur) => withFreshRepo(cur, r.repo))).catch(() => { /* the next beat asks again */ });
  };
  usePoll(open && !IS_DEMO, readPill, PILL_POLL_MS);
  useEffect(() => open && !IS_DEMO ? subscribeGitChanged(readPill) : undefined, [open]); // eslint-disable-line react-hooks/exhaustive-deps


  const barMode = actionsMode === "off" ? "edge" : actionsMode;
  const focusedBar = (foot: { left: number; top: number; width: number; atRight?: boolean }) => (
                  !chipWt ? (
                    <PaneBar foot={foot} mode={barMode} marker={marker} pill={pill} near={seamNear} blocked={!!sess?.tmuxPopup} branch="" dirty={0}
                      kind={wtDetecting ? "loading" : paneDir ? "none" : paneOutside ? "outside" : "none"}
                      loading={wtDetecting}
                      note={paneNote(wtDetecting, paneDir, paneOutside, dirName(here?.worktreeOf || here?.root || root || ""), focusSess?.tmuxWindows?.find((w) => w.active)?.cwd ?? "")}
                      noteAction={!wtDetecting && !paneDir && paneOutside && outsideRepo ? { label: "Open its project", onClick: () => setRoot(outsideRepo.root) } : undefined}
                      onDown={keepTermFocus} onGit={() => {}} onDiff={() => {}} onCopy={() => {}} onEscape={focusTerm} />
                  ) : (
                    <PaneBarFor
                      foot={foot}
                      mode={barMode}
                      marker={marker}
                      pill={pill}
                      near={seamNear}
                      blocked={!!sess?.tmuxPopup}
                      flash={copyFlash}
                      at={chipWt}
                      tabId={identTabId}
                      onDown={keepTermFocus}
                      onGit={() => requestWorktreeJump({ view: "git", root: chipWt.root })}
                      onDiff={() => requestWorktreeJump({ view: "diff", filter: dirName(chipWt.root) })}
                      onPr={() => { const pr = liveTabFacts.get(identTabId)?.pr; if (pr) openPr(pr.repo, pr.number); }}
                      onCopy={() => { copyPaneBranch(); }}
                      onEscape={focusTerm}
                      selection={selection}
                      onAsk={() => { void askAboutSelection(); }}
                      onSide={sideCan ? (sec) => openSide(sideTab, sec) : undefined}
                    />
                  )
  );

  const tabs = root ? termSessionsFor(root) : [];

  /* On screen at launch, the terminal holds the launch cover until every shell
     in view has drawn (see `settle`) — the checkout first, then the shells it
     opens. Re-read on every render, which each of those shells triggers. */
  const shellsSettled = paneIds.length > 0 && paneIds.every((id) => {
    const s = sessions.get(id);
    return !!s && shellSettled(s, refusalFinal());
  });
  useCoverHold("terminal", open && !IS_DEMO && (!reposKnown || (root !== "" && !shellsSettled)));

  // Every repo opens with a shell, and the panes always name shells that still
  // exist — closing one must not leave an empty frame behind.
  //
  // The demo creates them too. `createSession` builds an xterm and touches
  // nothing else — `connect` is the only step that opens a socket, and it
  // returns early in a demo build — so what the demo gets is the real terminal
  // with nothing talking to it, which is what `playDemoSession` then fills.
  useEffect(() => {
    if (!open || !root) return;
    const live = termSessionsFor(root);
    const first = live[0] ?? createSession(root);
    setPaneIds((prev) => {
      const kept = prev.filter((id) => sessions.get(id)?.root === root);
      return kept.length ? kept : [first.id];
    });
    setFocusIdx(0);
  }, [open, root]);

  // Mount each pane's terminal into its slot. xterm keeps its own DOM, so the
  // holder is moved between slots rather than re-created — that's what keeps
  // scrollback and running jobs intact across splits and reopens.
  // Held in a ref and read through it, so `onClose` can change identity without
  // this effect — the one that moves the live xterm DOM between slots — tearing
  // down. Callers pass what they like; terminals do not remount for it.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  /** The find bar is open over the focused pane. Reset when the repo changes:
   *  a search is about one shell's scrollback, not about the panel. */
  const [findOpen, setFindOpen] = useState(false);
  /* The pluck palette: the screen's rows are read when it opens, not tracked
     — a palette over a running shell that re-lettered itself as lines
     scrolled would move the key from under your finger. */
  const [pluckOpen, setPluckOpen] = useState(false);
  const [pluckRows, setPluckRows] = useState<{ text: string; wrapped: boolean }[]>([]);
  useEffect(() => {
    if (!pluckOpen) return;
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (!s) { setPluckOpen(false); return; }
    const buf = s.term.buffer.active;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let y = 0; y < s.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
    }
    setPluckRows(rows);
  }, [pluckOpen, paneIds, focusIdx]);
  const pluckPaste = useCallback((token: string) => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (!s || s.status !== "live" || s.ws?.readyState !== WebSocket.OPEN) return;
    s.ws.send(ptyFrame({ t: "in", d: `\x1b[200~${token}\x1b[201~` }));
  }, [paneIds, focusIdx]);
  const pluckCopy = useCallback((token: string) => {
    void navigator.clipboard?.writeText(token).catch(() => { /* no permission */ });
    setCopyFlash(Date.now());
  }, []);
  useEffect(() => { setFindOpen(false); }, [root]);

  /**
   * Hovering a pane types into it — when that has been asked for.
   *
   * Two things are set, and they are not the same thing: the pane INDEX is what
   * the chrome acts on (find, the window strip, the worktree readout), and
   * xterm's own focus is where the next character lands. A click sets both
   * because it lands inside xterm's textarea; a hover has to say so.
   *
   * Declared down here, below `findOpen`, and that placement is load-bearing: a
   * `useCallback` reads its dependency array during render, so naming a `const`
   * declared further down the component is a temporal dead zone — which in this
   * app means a white window rather than a warning.
   */
  /* Measured after paint, and only for one slot: one getBoundingClientRect per
     hover rather than per mousemove.
     The slot is the one the pointer is in, or — when the pointer is somewhere
     else entirely — the focused one. The seam is a 3px line a pane wears the
     way it wears a border, and measuring only under the pointer meant taking
     the pointer to the sidebar took the whole feature off the screen, with
     nothing left to say the pane still had a bar. */
  useLayoutEffect(() => {
    const clear = () => { footRef.current = null; setFootBox(null); };
    if (actionsMode === "always") {
      const wrap = wrapRef.current;
      if (!wrap) { clear(); setSlotFoots((cur) => (cur.length ? [] : cur)); return; }
      const w = wrap.getBoundingClientRect();
      const next = paneIds.map((_, i) => {
        const el = paneRefs.current[i];
        if (!el) return null;
        const sr = el.getBoundingClientRect();
        const width = Math.round(sr.width - 2);
        return width < BAR_MIN_W ? null : { left: Math.round(sr.left - w.left + 1), top: Math.round(sr.bottom - w.top - 1), width };
      });
      clear();
      setSlotFoots((cur) => (cur.length === next.length && cur.every((c, i) => c?.left === next[i]?.left && c?.top === next[i]?.top && c?.width === next[i]?.width) ? cur : next));
      return;
    }
    setSlotFoots((cur) => (cur.length ? [] : cur));
    const idx = actionsIdx ?? focusIdx;
    if (actionsMode === "off" || idx == null || !paneIds[idx]) { clear(); return; }
    const wrap = wrapRef.current;
    const s = sessions.get(paneIds[idx] ?? "");
    const screenEl = (s?.term.element?.querySelector(".xterm-screen") ?? s?.term.element) as HTMLElement | null;
    if (!wrap || !s || !screenEl) { clear(); return; }
    const w = wrap.getBoundingClientRect();
    const sc = screenEl.getBoundingClientRect();
    const rect = (r: DOMRect) => ({ left: r.left, top: r.top, width: r.width, height: r.height });
    // The pane tmux says is current — which, with focus-follows-mouse, is the
    // one under the pointer. Null covers the cases where there is no rectangle
    // to speak of: one pane, a zoomed pane, a shell with no tmux at all.
    const pane = s.tmuxPanes.length > 1 ? (s.tmuxPanes.find((x) => x.active) ?? null) : null;
    const cells = pane ? { left: pane.left, top: pane.top, right: pane.right, bottom: pane.bottom } : null;
    /* The pane's own bottom edge, which is NOT where its last row ends: xterm
       draws whole rows only, so the slot is a few pixels taller than a whole
       number of them, and that strip is where the seam goes. Measured on the
       slot rather than on the grid — the grid's bottom is the pane BELOW this
       one when the terminal is split. */
    const slotEl = paneRefs.current[idx];
    const edge = slotEl ? slotEl.getBoundingClientRect().bottom - w.top : undefined;
    const foot = paneFoot({ screen: rect(sc), slot: rect(w), cols: s.term.cols, rows: s.term.rows, pane: cells, edge });
    /* A pane too small to give the bar room is left alone: the keyboard chords
       do the same job without covering the prompt the bar is describing. */
    const cellH = s.term.rows > 0 ? sc.height / s.term.rows : 0;
    const tall = cells ? (cells.bottom - cells.top + 1) * cellH : sc.height;
    const room = actionsMode === "summary" ? 80 : BAR_MIN_H;
    if (foot.width < BAR_MIN_W || tall < room) { clear(); return; }
    /* Summary's pill keeps clear of text somebody is reading: what the last
       two rows hold, and where the cursor is, against the pill's columns. */
    if (actionsMode === "summary") {
      const next = bufferPlacement(s.term.buffer.active, {
        c0: cells ? cells.left : 0, c1: cells ? cells.right : s.term.cols - 1, bottom: cells ? cells.bottom : s.term.rows - 1,
        cellW: s.term.cols > 0 ? sc.width / s.term.cols : 8,
      });
      setPill((cur) => (cur.lift === next.lift && cur.translucent === next.translucent ? cur : next));
    }
    /* The pointer is compared against this in the slot's own mousemove, which
       is why the wrapper's own position is kept with it: the alternative is a
       getBoundingClientRect on every mouse event, on a panel that already
       repaints a terminal. */
    wrapRect.current = { left: w.left, top: w.top };
    footRef.current = foot;
    setFootBox((prev) => (prev && prev.left === foot.left && prev.top === foot.top && prev.width === foot.width && prev.atRight === foot.atRight ? prev : foot));
  }, [actionsIdx, focusIdx, actionsMode, actionsTick, paneIds, sessTick]);

  /* Is the pointer on the seam? Arithmetic against the rectangle measured
     above — no DOM reads — so this can run on every mousemove. */
  const nearFoot = useCallback((e: { clientX: number; clientY: number }) => {
    const w = wrapRect.current, f = footRef.current;
    if (!w || !f) { setSeamNear(false); return; }
    const x = e.clientX - w.left, y = e.clientY - w.top;
    const on = y >= f.top - SEAM_ZONE && y <= f.top + 2 && x >= f.left && x <= f.left + f.width;
    setSeamNear((cur) => (cur === on ? cur : on));
  }, []);

  /* A split, a resize or a tmux redraw all move the corner the block sits in.
     Observed rather than polled — the wrapper is one element. */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => setActionsTick((n) => n + 1));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const hoverFocus = useCallback((i: number, buttons: number) => {
    if (!shouldFocusOnHover({ enabled: ffm, buttons, typing: findOpen, visible: active && open })) return;
    const s = sessions.get(paneIds[i] ?? "");
    if (!s) return;
    // Only when it moves. Re-entering the pane you are already in would re-run
    // the mount effect below, which detaches and re-attaches a live terminal.
    setFocusIdx((cur) => (cur === i ? cur : i));
    requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [ffm, findOpen, active, open, paneIds]);

  /** The tmux pane last asked for, so a pointer resting inside one does not
   *  re-send for every mousemove in the half-second before the sweep reports
   *  it active. */
  const askedPane = useRef<string | null>(null);

  /**
   * The same idea one level down: inside tmux.
   *
   * Giving the terminal the keyboard is not enough when tmux is running in it.
   * tmux has its own idea of which pane is current, and keystrokes go THERE —
   * so hovering the right-hand split and typing still lands on the left one
   * until you click. The click works because tmux's own mouse mode acts on the
   * button; hovering has no such event, so the pane is worked out here from the
   * geometry tmux reports and tmux is told to select it.
   *
   * Rate is not the concern the shape of the guard suggests: `mousemove` fires
   * often, but the send happens only when the pane UNDER the pointer changes,
   * so crossing a divider is one command and sitting in a pane is none.
   */
  const hoverTmuxPane = useCallback((i: number, e: { clientX: number; clientY: number; buttons: number }) => {
    if (!shouldFocusOnHover({ enabled: ffm, buttons: e.buttons, typing: findOpen, visible: active && open })) return;
    const s = sessions.get(paneIds[i] ?? "");
    // Fewer than two panes and there is nothing to choose between — the server
    // sends an empty list for exactly that case.
    if (!s || !s.tmux || s.tmuxPanes.length < 2 || s.ws?.readyState !== WebSocket.OPEN) return;
    // xterm's screen element, not the container: the container can be a few
    // pixels taller than a whole number of rows, and dividing by the wrong
    // height puts the pointer a row off at the bottom of a tall pane.
    const screen = s.term.element?.querySelector(".xterm-screen") ?? s.term.element;
    if (!screen) return;
    const cell = cellAt(screen.getBoundingClientRect(), s.term.cols, s.term.rows, e.clientX, e.clientY);
    if (!cell) return;
    const pane = paneAt(s.tmuxPanes, cell.col, cell.row);
    // No pane owns this cell (tmux's status line), it is already the current
    // one, or we have just asked for it.
    if (!pane || pane.active || askedPane.current === pane.id) return;
    askedPane.current = pane.id;
    s.ws.send(ptyFrame({ t: "tmux", cmd: "selectpane", pane: pane.id }));
  }, [ffm, findOpen, active, open, paneIds]);

  useEffect(() => {
    if (!open) return;
    panelClose = () => closeRef.current();
    /* Reads the refs rather than closing over them: this is set once on mount,
       and what is behind the focused pane changes several times a minute. */
    copyPaneBranch = () => {
      const wt = wtRef.current;
      if (!wt) return false;
      const name = wt.worktreeOf ? wt.branch : wt.name;
      if (!name) return false;
      /* Still no toast — there is none over a terminal in this app, and a line
         written into the shell would be a line in somebody's command history.
         The pane's own bar answers instead: up for a moment with a green tick,
         which says WHICH branch went to the clipboard rather than merely that
         something did. */
      void navigator.clipboard?.writeText(name).catch(() => { /* no permission */ });
      setCopyFlash(Date.now());
      return true;
    };
    focusPaneBar = () => {
      const el = document.querySelector<HTMLElement>("[data-pane-bar] [data-chip-stop], [data-pane-pill]");
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    };
    paneRootNow = () => wtRef.current?.root ?? null;
    paneDoor = (which) => {
      const wt = wtRef.current;
      if (which === "pr") {
        const pr = liveTabFacts.get(identTabIdRef.current)?.pr;
        if (!pr) return false;
        openPr(pr.repo, pr.number);
        return true;
      }
      if (which === "card") {
        const card = liveTabFacts.get(identTabIdRef.current)?.card;
        if (!card?.action) return false;
        if (card.action.in === "tasks") openCard(card.query, card.label, card.tracker); else openExternal(card.action.url);
        return true;
      }
      if (!wt) return false;
      requestWorktreeJump(which === "git" ? { view: "git", root: wt.root } : { view: "diff", filter: dirName(wt.root) });
      return true;
    };
    // Claim the find chord only while this view is on screen and has a pane to
    // search — see `panelFind`.
    panelFind = () => { setFindOpen(true); return true; };
    panelPluck = () => { setPluckOpen(true); return true; };
    /* And the shell's Ctrl+F, when the focus is anywhere but inside the pane
       itself — the tab strip, a toolbar. Inside the pane the key still belongs
       to the program running there (readline reads it as forward-char), which
       is why the panel's own chord is Ctrl+Shift+F and why the shell's bar
       never offers to search a canvas. */
    const unclaim = registerClaim(() => { setFindOpen(true); return true; });
    /* Only what changed moves: `planPaneMount` says which holders left their slot and which are
       new. A holder that stays is never taken out of the DOM or parked, so a tab switch never
       blanks the pane next to it. The entries live in `mountedRef`, not in this run, because this
       run's cleanup must not detach them (the `[open]` effect below does that). */
    const mounted = mountedRef.current;
    const unmountPane = (id: string) => {
      const m = mounted.get(id);
      if (!m) return;
      mounted.delete(id);
      m.ro.disconnect(); m.stopFit(); m.unTheme();
      m.s.subs.delete(force);
      if (m.s.holder.parentElement === m.el) m.el.removeChild(m.s.holder);
      parkRenderer(m.s);
    };
    const plan = planPaneMount(mountedIdsRef.current, paneIds);
    const stale = new Set(plan.leave);
    paneIds.forEach((id, i) => { const m = mounted.get(id); if (m && m.el !== paneRefs.current[i]) stale.add(id); });
    for (const id of stale) { unmountPane(id); }
    for (const id of mountedIdsRef.current) if (!paneIds.includes(id)) unmountPane(id);
    mountedIdsRef.current = paneIds;
    unmountAllRef.current = () => { for (const id of [...mounted.keys()]) unmountPane(id); };
    paneIds.forEach((id, i) => {
      if (mounted.has(id)) return; // kept: never re-appended. A slot that could not mount yet retries here.
      const s = sessions.get(id);
      const el = paneRefs.current[i];
      if (!s || !el) return;
      el.appendChild(s.holder);
      if (!s.opened) { s.term.open(s.holder); s.opened = true; }
      attachRenderer(s); // see the console strip above
      // A kept renderer is blank for a frame after the holder moves; repaint
      // before the next paint rather than after the observer notices.
      try { s.term.refresh(0, s.term.rows - 1); } catch { /* not open yet */ }
      s.term.options.theme = themeFromCss(); // pick up theme switches between opens
      const unTheme = applyThemeLive(s);
      s.subs.add(force);
      // Same debounce as the console strip: one fit when the drag settles, not
      // one per frame of it — each costs a full reflow of the scrollback and a
      // resize ioctl to the shell.
      let fitTimer: ReturnType<typeof setTimeout> | null = null;
      const doFit = () => { try { fitTerm(s); } catch { /* not measurable yet */ } };
      const fitSoon = () => { if (fitTimer) clearTimeout(fitTimer); fitTimer = setTimeout(doFit, 100); };
      doFit();
      /* The first shell waits for a server; nothing else here does.
         A pty socket opened before the sidecar is listening is a refused
         connection, and Chromium logs it whether or not the reconnect picks it
         up — the same reason the fetch layer and the live socket stopped asking
         early. `connect` keeps its own `s.ws` guard and its onmessage still
         checks identity, so this only delays the FIRST attempt; the status is
         re-read after the wait because a session connected meanwhile must not be
         connected twice. `then(go, go)`: a latch that rejected still opens the
         shell rather than leaving a dead panel. */
      if (s.status === "idle") {
        const go = () => { if (s.status === "idle") connect(s); };
        void whenServerUp().then(go, go);
      }
      // Once per session, not once per mount: switching views and coming back
      // would otherwise replay the same test run on top of itself, and the
      // scrollback would read as a shell stuck in a loop.
      if (IS_DEMO && !demoPlayed.has(s.id)) {
        demoPlayed.add(s.id);
        stopDemo.set(s.id, playDemoSession(s.term));
      }
      const ro = new ResizeObserver(fitSoon);
      ro.observe(el);
      mounted.set(id, { s, el, ro, unTheme, stopFit: () => { if (fitTimer) clearTimeout(fitTimer); } });
    });
    return () => {
      panelClose = () => {};
      paneRootNow = () => null;
      panelFind = () => false;
      panelPluck = () => false;
      unclaim();
    };
    // `onClose` deliberately absent: see closeRef above. Re-running this for a
    // callback identity detaches a live terminal, which loses the selection you
    // were dragging and cycles focus mid-keystroke.
  }, [open, paneIds]);
  // Closing the view (or leaving) detaches every holder; a mere change of panes does not.
  useEffect(() => () => {
    unmountAllRef.current();
    mountedIdsRef.current = [];
  }, [open]);

  // Focus follows the focused pane without touching any holder. without touching any holder.
  useEffect(() => {
    if (!open) return;
    const focused = sessions.get(paneIds[focusIdx] ?? "");
    if (focused) requestAnimationFrame(() => focused.term.focus());
  }, [open, paneIds, focusIdx]);

  /* Output waits (lib/hiddenWrites.ts has the why, the cap and the ceilings) for a shell nobody can see:
     the shells in these panes while another view is on screen, and, while this view is shown, any shell
     that is in none of its panes (another checkout's, a closed side pane). Layout, not passive: what was
     kept is handed to xterm before the view is painted again, and before a pane that takes a held shell
     paints it, because the cleanup runs when `paneIds` changes. `visibility:hidden` still counts as on
     screen to xterm, which is why a hidden view needs this at all. That also means it runs before the
     mount effect above in the same commit, so a view that mounts hidden holds nothing until it has been
     shown once (its holders are not in their panes yet): a shell is only ever held from a pane it was
     already drawn in. `focusIdx` is here because the mount effect re-runs on it and takes the holders out
     and back. A minimized window (`document.hidden`) holds every shell, this view's or not: its frames
     stop, so xterm draws nothing, but it still parsed every byte. */
  const windowHidden = useSyncExternalStore(subscribeWindowHidden, windowIsHidden, () => false);
  useLayoutEffect(() => {
    if (!open) return;
    const held: Sess[] = [];
    const take = (s: Sess, inOwnPane: boolean, inShownPane: boolean) => {
      if (!shouldHoldWrites({ open, viewActive: active, canHold: mayHoldWrites(s), inOwnPane, inShownPane, holderAttached: !!s.holder.parentElement, windowHidden })) return;
      holdStart(s.hold ??= newWriteHold());
      held.push(s);
    };
    if (active || windowHidden) {
      const shown = new Set(paneIds);
      for (const [id, s] of sessions) take(s, false, shown.has(id));
    } else {
      paneIds.forEach((id, i) => {
        const s = sessions.get(id);
        const el = paneRefs.current[i];
        // In this view's own pane, and not lent to the console strip or anywhere else that shows it.
        if (s && el && s.holder.parentElement === el) take(s, true, true);
      });
    }
    return () => { for (const s of held) releaseHeld(s); };
  }, [active, open, paneIds, focusIdx, windowHidden]);

  // Return the keyboard focus to the shell when the terminal view becomes
  // visible again — e.g. after clicking the left sidebar to another view and
  // coming back, or dismissing the app header. The mount effect above
  // deliberately omits `active` so returning does not detach/reload the
  // terminal, so it never refocuses on return; this does, and only that. Guard
  // on the rising edge (hidden → visible) so an already-focused shell is not
  // re-grabbed on every unrelated re-render.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && open) {
      const s = sessions.get(paneIds[focusIdx] ?? "");
      if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
    }
    wasActive.current = active;
  }, [active, open, paneIds, focusIdx]);

  // The same session the worktree read above is keyed on — one lookup, so the
  // two can never disagree about which pane is in front of you.
  const sess = focusSess;
  // tmux is running in the shell you're looking at, so it owns the tabs and the
  // splits. Ours would be a second set of controls doing the same job worse —
  // and two competing pane models is exactly how you end up with a split inside
  // a split you didn't ask for.
  const tmuxActive = !!sess?.tmux;
  const status: SessStatus = sess?.status ?? "idle";
  /* Whether a request can be SENT at all — a question about the transport.
     What used to gate these was `tmuxActive`, which is a question about the
     machine, and answering it in the client is what made six buttons do
     nothing on every Mac. The server answers the tmux question now. */
  const socketLive = status === "live";
  /** The dispatch we are waiting on an answer for, so a refusal can be served
   *  by the pane path rather than only reported. */
  const lastIssue = useRef<TermIssue | null>(null);

  /*
   * tmux's windows, drawn by us.
   *
   * The panel stands down from tabs and splits while tmux runs, because two
   * pane models fight. Its *window list* is a different case: it is the one
   * strip of the workspace styled by a file the app has never seen, so the same
   * user on two machines gets two different looking bars across an otherwise
   * coherent panel. So the list comes from tmux and the pixels come from here.
   *
   * Nothing about the keyboard changes. Every button below sends a command tmux
   * would have run anyway, and "which window is active" is always tmux's answer
   * arriving on the next poll, never a local guess that could disagree with it.
   */
  const tmuxWindows = sess?.tmuxWindows ?? [];
  /*
   * Re-fit the terminal when tmux takes the panel over, or its window list
   * changes shape.
   *
   * The moment tmux is detected, the panel's own chrome changes height — the
   * shell-tab strip is swapped for tmux's window strip, the status hint row
   * changes — so the number of rows that fit is not what it was a frame ago.
   * The mount effect above measures ONCE, before any of that, and then keys on
   * `[open, paneIds, focusIdx]` (deliberately not `tmuxActive`, so returning to
   * the view never detaches a live terminal) — so nothing re-measures when tmux
   * arrives. A view-switch does, but only incidentally: the panel goes to zero
   * size and back, and the mount effect's ResizeObserver fires on the way in.
   * The initial attach has no such transition, so the tmux window kept the
   * taller pre-tmux grid and its bottom rows — an agent's input box — were drawn
   * below the panel until the user happened to switch views. This is the missing
   * re-fit, on the same rising edge a view-switch gets for free.
   *
   * rAF so it runs after the new chrome has laid out; `fitTerm` no-ops when the
   * grid is unchanged, so the common re-render costs a measurement and no
   * resize.
   */
  useEffect(() => {
    if (!open || IS_DEMO) return;
    const raf = requestAnimationFrame(() => {
      for (const id of paneIds) {
        const s = sessions.get(id);
        if (s) try { fitTerm(s); } catch { /* not measurable yet */ }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, tmuxActive, tmuxWindows.length, paneIds]);
  // Lit while tmux is waiting for the rest of a prefix sequence: set by the key
  // that armed it, cleared by the next key or a click (lib/prefixArmed.ts). There
  // is no clock — a timer would end the halo while tmux still waits.
  const prefixArmed = !!sess?.tmuxPrefixArmed;
  useEffect(() => {
    if (!prefixArmed || !sess) return;
    const disarm = () => {
      sess.tmuxPrefixArmed = prefixStep(true, { type: "pointer" }, sess.tmuxPrefix).armed;
      notify(sess);
    };
    document.addEventListener("pointerdown", disarm, true);
    return () => document.removeEventListener("pointerdown", disarm, true);
  }, [prefixArmed, sess]);
  /*
   * The tab you clicked highlights now, not when tmux confirms it.
   *
   * The server re-reads tmux the moment the command returns, so the real answer
   * is a round trip away rather than a poll away — but a round trip is still
   * long enough to feel like the click missed, and this is the one interaction
   * where the user already knows what the answer will be. Cleared on the next
   * frame, so if tmux disagrees (the window went away underneath), tmux wins.
   */
  useEffect(() => { if (pendingResolved(pendingWindow, tmuxWindows)) setPendingWindow(null); }, [tmuxWindows, pendingWindow]);
  const activeWindow = resolveActiveWindow(pendingWindow, tmuxWindows);

  /* THE SIDE PANE. A tab is the tmux window (the focused shell without tmux); what it remembers lives in lib/sidePane.
     Identity must be something tmux never reuses and never shares between tabs. `root` is the project's own path —
     the SAME string for every window of this project — so it is only the answer for a shell with no tmux at all.
     While tmux is active, a window list that has not caught up with a just-made switch answers with the window id
     this tab had a moment ago, never with a pane id (a different kind of identity) or the shared project path:
     either one would hand this tab's cached facts to the next tab that landed on the same fallback key. */
  const lastActiveWindow = useRef<string | null>(null);
  if (activeWindow) lastActiveWindow.current = activeWindow;
  const sideTab = activeWindow ?? (tmuxActive ? lastActiveWindow.current : null) ?? paneIds[focusIdx] ?? root;
  /* A window that closed takes what the pane remembered about it. */
  const knownWindows = useRef<{ sid: string; ids: string[] } | null>(null);
  const focusSid = paneIds[focusIdx] ?? "";
  /* The list is one tmux SESSION's windows: switching session inside the same pty swaps it wholesale, and the
     windows of the session left are not closed, so the key carries the session name or they would be forgotten. */
  const listKey = `${focusSid}\t${sess?.tmuxSession ?? ""}`;
  useEffect(() => {
    const ids = tmuxWindows.map((w) => w.id);
    closedWindows(knownWindows.current, listKey, ids).forEach((id) => { forgetTab(id); });
    knownWindows.current = { sid: listKey, ids };
  }, [tmuxWindows, listKey]);
  useSyncExternalStore(subscribeSidePane, sidePaneVersion, () => 0);
  const sideView = viewOf(sideTab);
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const [rowW, setRowW] = useState(0);
  useEffect(() => {
    if (!rowEl) return;
    const ro = new ResizeObserver(() => setRowW(rowEl.clientWidth));
    ro.observe(rowEl);
    setRowW(rowEl.clientWidth);
    return () => ro.disconnect();
  }, [rowEl]);
  const sideCell = cellSizeOf(sessions.get(paneIds[focusIdx] ?? "")?.term)?.width || SIDE_CELL_FALLBACK_PX;
  const sideCols = paneIds.length > 1 ? 2 : 1;
  /* The terminal keeps 80 columns per pane (plus the scrollbar xterm reserves); the pane takes what is left, never more. */
  const termMinPx = sideCols * (MIN_TERM_COLS * sideCell + SIDE_SCROLLBAR_PX) + (sideCols > 1 ? SIDE_PAIR_GAP_PX : 0);
  const sideCan = sideCanShow(!!root, !IS_DEMO && !!cmds && !cmds.enabled, rowW);
  const sideOn = sideView.open && sideCan;
  const sideSeen = useRef(false);
  if (sideOn) sideSeen.current = true;
  const sideFit = sideOn ? paneWidth(sideView.maxWidth ? Infinity : sideView.width, rowW, termMinPx, sideView.compact) : 0;
  /* A window with no room for the pane AND 80 columns gets the pane over the terminal instead of squeezing it. */
  const sideOverlay = sideOn && sideFit < SIDE_USABLE;
  const sideW = sideOverlay ? Math.min(SIDE_MIN, Math.max(0, rowW - SIDE_OVERLAY_MARGIN_PX)) : sideFit;
  const typeIntoPane = useCallback((text: string) => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (!s || s.status !== "live" || s.ws?.readyState !== WebSocket.OPEN) return;
    /* A shell that never asked for bracketed paste would print the markers as text. */
    if (!s.term.modes?.bracketedPasteMode) { s.ws.send(ptyFrame({ t: "in", d: text })); return; }
    s.ws.send(ptyFrame({ t: "in", d: `\x1b[200~${text}\x1b[201~` }));
  }, [paneIds, focusIdx]);
  /*
   * The strip's groups (lib/tabGroups.ts): by project, the one you are in open,
   * the rest folded into chips. Null draws the strip flat — grouping switched
   * off in Settings, or everything in one group, where a header says nothing.
   *
   * `rememberedGroup` holds each window's last group for the one sweep after
   * a new directory appears, before the server has resolved its project, so a
   * tab does not drop into "other" and straight back out.
   */
  const tgVersion = useSyncExternalStore(subscribeTabGroups, tabGroupsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groupsOn = useMemo(() => tabGroupsOn(), [tgVersion]);
  const rememberedGroup = useRef(new Map<string, string>());
  const sessionLabel = sess?.tmuxSession || "tmux";
  const sessionKey = `session:${sessionLabel}`;
  const stripGroups = useMemo<TabGroup[]>(() => {
    // Off, the strip is one project named after the session: the chip still
    // says where you are, and nothing is grouped by folder.
    if (!groupsOn) return [{ key: sessionKey, label: sessionLabel, windows: tmuxWindows, status: undefined, marks: [], first: 0 }];
    // Window ids are per tmux server, so the memory is per session name and
    // holds only the windows on screen now.
    const remembered = new Map<string, string>();
    for (const w of tmuxWindows) {
      const had = rememberedGroup.current.get(`${sess?.tmuxSession ?? ""}\t${w.id}`);
      if (had) remembered.set(w.id, had);
    }
    const gs = buildGroups(tmuxWindows, parseRules(tabGroupRulesText()), remembered);
    rememberedGroup.current = new Map(gs.flatMap((g) => g.windows.map((w) => [`${sess?.tmuxSession ?? ""}\t${w.id}`, g.label] as const)));
    return gs;
    // tgVersion stands for the rules, which are read fresh inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmuxWindows, tgVersion, groupsOn, sessionKey, sessionLabel]);
  const tmuxSessionName = sess?.tmuxSession ?? "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keptOpen = useMemo(() => openGroups(tmuxSessionName), [tmuxSessionName, tgVersion]);
  const groupOfWindow = useMemo(() => {
    const m = new Map<string, TabGroup>();
    for (const g of stripGroups) for (const w of g.windows) m.set(w.id, g);
    return m;
  }, [stripGroups]);
  const activeGroup = activeWindow ? groupOfWindow.get(activeWindow)?.key ?? null : null;
  const toggleKeptOpen = (key: string) => {
    const next = new Set(keptOpen);
    if (next.has(key)) next.delete(key); else next.add(key);
    setOpenGroups(tmuxSessionName, next);
  };
  const tmuxClient = sess?.tmuxClient ?? null;
  /*
   * The window is bigger than the pane you can see.
   *
   * `window-size largest` keeps a phone from shrinking the desk, and its cost
   * is this: with anything BIGGER attached — another agentglass window, a
   * `tmux attach` in a real terminal — tmux sizes the window to that one and
   * this panel shows its top-left corner. Measured on a private server, one
   * 80x24 client gives `window 80x23`; a 240x60 client joining takes it to
   * `window 240x59` while the small client stays 80x24.
   *
   * What that costs is not "some rows": it is the LAST row of the pane, which
   * is where every editor puts its status line. Reported as exactly that,
   * because "nvim has no status bar" is how it presents and is a different
   * thing to go looking for.
   */
  const hiddenRows = (() => {
    const rows = tmuxClient?.rows ?? 0;
    if (!tmuxActive || !rows) return 0;
    const deepest = (sess?.tmuxPanes ?? []).reduce((n, p) => Math.max(n, p.bottom + 1), 0);
    return deepest > rows ? deepest - rows : 0;
  })();
  // Narrowed or zoomed by somebody else — see heldWindow for what counts.
  const held = heldWindow(tmuxActive, tmuxWindows, activeWindow, tmuxClient);
  /* Corner-ness comes from the focused pane's cells, not from footBox: that is null before the first measure and in the "off" and "always" modes. */
  const cardSess = sessions.get(paneIds[actionsIdx ?? focusIdx ?? 0] ?? "");
  const cardPane = cardSess && cardSess.tmuxPanes.length > 1 ? (cardSess.tmuxPanes.find((x) => x.active) ?? null) : null;
  const cardAtCorner = !cardSess || paneAtCorner(cardPane, cardSess.term.cols, cardSess.term.rows);
  /**
   * The state the card is describing, as one string.
   *
   * Only used to decide whether a dismiss still applies. Closing the card puts
   * this key in `heldHidden`, so the card stays gone while nothing changes and
   * comes back by itself the moment the situation is a different one: another
   * window, another width, or a zoom on top of a width that was already wrong.
   * That keeps the dismiss from turning into the optimistic flag the button
   * below deliberately does not have — nothing here is remembered ACROSS a
   * change of state, so a phone that grabs the window again is announced again.
   */
  const heldKey = held ? `${held.win.id}:${held.narrow?.winCols ?? 0}:${held.zoomed ? "z" : "-"}` : null;
  const [heldHidden, setHeldHidden] = useState<string | null>(null);
  const tmuxCmd = useCallback((body: TmuxCmdBody) => {
    const s = sess;
    if (!s || s.ws?.readyState !== WebSocket.OPEN) return;
    s.ws.send(ptyFrame({ t: "tmux", ...body }));
  }, [sess]);
  /** A tab, a Go-list row, an Alt number or "needs you": select it now (see
   *  pendingWindow) and give the keyboard back to the pane. */
  const pickWindow = (id: string) => {
    if (id !== activeWindow) { setPendingWindow(id); tmuxCmd({ cmd: "select", window: id }); }
    focusTerm();
  };
  /*
   * NO LABEL UNDER THE TAB NAME. Removed, not fixed.
   *
   * The idea was that `AI01` is an address and says nothing, so a line of what
   * the agent is doing would earn its place beside it. In practice every tab
   * printed the SAME sentence — the owner was matched with
   * `cwd.startsWith(worktree)`, so every window in one checkout resolved to
   * whichever agent sorted first, and five tabs all read "Investigando p…".
   *
   * The prefix match is fixable and the label still went: a tab is read by its
   * address, and a description repeated across five of them is noise wherever
   * the matching bug ends up.
   */
  /*
   * Whether tmux keeps drawing its own status line underneath our tabs.
   *
   * Hidden by default, because leaving it on means two window lists stacked on
   * top of each other and the point of this was to stop the workspace carrying
   * a strip it does not control. It is only ever hidden when we actually have
   * tabs to put in its place, it is one click to bring back, the choice is
   * remembered, and the server restores it when the panel closes.
   *
   * The caveat, and the reason the button is right there in the strip rather
   * than buried in settings: `status` is a session option, not a client one.
   * Someone attached to the same session from a real terminal loses their
   * status line too, and some people keep things there we do not draw — the
   * session name, a battery, a prefix indicator.
   */
  const [tmuxBar, setTmuxBar] = useState<boolean>(() => {
    try { return localStorage.getItem("agentglass-tmux-bar") === "on"; } catch { return false; }
  });
  useEffect(() => {
    // Nothing to replace it with means nothing to hide: if the session never
    // resolved (no /proc, an unusual socket, a tmux we could not reach), the
    // user keeps exactly the bar they had.
    if (!tmuxActive || !tmuxWindows.length) return;
    tmuxCmd({ cmd: "status", visible: tmuxBar });
    try { localStorage.setItem("agentglass-tmux-bar", tmuxBar ? "on" : "off"); } catch { /* private mode */ }
  }, [tmuxActive, tmuxBar, tmuxCmd, tmuxWindows.length]);

  /*
   * A review asked for from the pull request panel.
   *
   * It waits here until there is a tmux to open a window in — the button can be
   * pressed while this view has never been opened, so the socket may still be
   * connecting, and a request dropped for arriving early would look like a
   * button that sometimes does nothing. Cleared on send, not on arrival.
   */
  const review = useSyncExternalStore(subscribeTermReview, termReview, termReview);
  useEffect(() => {
    if (!review || !socketLive) return;
    tmuxCmd({ cmd: "review", root: review.root, number: review.number, recipe: review.recipe, card: review.card, ...(review.mode ? { mode: review.mode } : {}), ...(review.kind ? { kind: review.kind } : {}) });
    clearTermReview();
  }, [review, socketLive, tmuxCmd]);

  /** The same door for starting work on an issue: a worktree the server has
   *  already cut, and a prompt it wrote. Never a command — see termIssue.ts. */
  const issue = useSyncExternalStore(subscribeTermIssue, termIssue, termIssue);
  useEffect(() => {
    if (!issue || !socketLive) return;
    if (issue.resumeId) {
      // The server's `resume` has no answer of its own; a refusal arrives as `openfail`.
      tmuxCmd({ cmd: "resume", id: issue.resumeId, cwd: issue.cwd, split: false, yolo: false });
      resolveTermIssue(issue.n, { ok: true });
      clearTermIssue();
      return;
    }
    // Remembered before it is sent, because the fallback below needs it and the
    // slot is cleared here: a second press must not be blocked waiting on the
    // first one's answer.
    lastIssue.current = issue;
    tmuxCmd({ cmd: "issue", n: issue.n, cwd: issue.cwd, name: issue.name, prompt: issue.prompt, agent: issue.agent, yolo: issue.yolo, title: issue.title, model: issue.model, effort: issue.effort, reuse: issue.reuse, kind: issue.kind, ...(issue.mode ? { mode: issue.mode } : {}), ...(issue.cardId ? { cardId: issue.cardId } : {}), ...(issue.subject ? { subject: issue.subject } : {}) });
    clearTermIssue();
  }, [issue, socketLive, tmuxCmd]);

  /*
   * The server refused, so open the agent in a pane instead.
   *
   * This is the half of the dispatch that did not exist. Both effects above
   * used to require `tmuxActive`, so on a machine with no tmux client the
   * request was dropped before it was sent — and `tmuxActive` came from a
   * detection that read /proc and returned false on every Mac, whatever was
   * installed. Six buttons, no message, nothing in a log.
   *
   * The gate is the SOCKET now, not tmux: whether this can be sent at all is a
   * question about the transport, and whether tmux can serve it is the server's
   * to answer — it resolves its own sweep before refusing, so "not looked up
   * yet" is never mistaken for "no tmux here".
   *
   * A refusal is not an error to show and move on from. It is the request
   * arriving at the other path: a pane, opened in the same worktree, running
   * the same agent with the same argv.
   */
  useEffect(() => {
    const why = sess?.openFail;
    if (!why || !sess) return;
    sess.openFail = null;
    const want = lastIssue.current;
    lastIssue.current = null;
    if (!want) { sess.term.writeln(`\r\n\x1b[33m${why}\x1b[0m`); return; }
    void (async () => {
      const r = await api.termAgentTicket(want.cwd, want.agent ? want.prompt : "", !!want.yolo, want.title ?? "")
        .catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; ticket?: string; error?: string }));
      if (!r.ok || !r.ticket) {
        // Said in the terminal the person is looking at, rather than swallowed.
        // This is the case the audit was about, so it does not get to be quiet.
        sess.term.writeln(`\r\n\x1b[33mcould not start the agent here: ${r.error ?? "no ticket"}\x1b[0m`);
        resolveTermIssue(want.n, { ok: false, error: `could not start the agent: ${r.error ?? "no ticket"}` });
        return;
      }
      resolveTermIssue(want.n, { ok: true });
      const pane = createSession(want.cwd, r.ticket);
      setPaneIds((ids) => (ids.length >= 4 ? [...ids.slice(1), pane.id] : [...ids, pane.id]));
      setFocusIdx((i) => Math.min(i + 1, 3));
    })();
  }, [sess, sessTick]);

  /*
   * The first run's last step mints the ticket and leaves the pane here: the
   * wizard is not the terminal and cannot make a session, so the view that can
   * takes the ticket the moment it is mounted. One slot, taken once.
   */
  const handed = useSyncExternalStore(subscribeSetupPane, setupPane, () => null);
  useEffect(() => {
    if (!handed) return;
    const s = createSession(handed.root, handed.ticket);
    setPaneIds((ids) => (ids.length >= 4 ? [...ids.slice(1), s.id] : [...ids, s.id]));
    setFocusIdx((i) => Math.min(i + 1, 3));
    takeSetupPane();
  }, [handed]);

  const addShell = useCallback(() => {
    if (!root || IS_DEMO) return;
    const s = createSession(root);
    setPaneIds([s.id]);
    setFocusIdx(0);
  }, [root]);

  /** Show one more shell beside the current one (new if there isn't a spare). */
  const splitPane = useCallback(() => {
    if (!root || IS_DEMO) return;
    setPaneIds((prev) => {
      if (prev.length >= 4) return prev; // beyond four a pane is too small to use
      const spare = termSessionsFor(root).find((s) => !prev.includes(s.id)) ?? createSession(root);
      return [...prev, spare.id];
    });
  }, [root]);

  const showOnly = useCallback((id: string) => { setPaneIds([id]); setFocusIdx(0); }, []);

  const closeShell = useCallback((id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    const r = s.root;
    killSession(s);
    setPaneIds((prev) => {
      const kept = prev.filter((x) => x !== id);
      if (kept.length) return kept;
      const next = termSessionsFor(r)[0] ?? createSession(r);
      return [next.id];
    });
    setFocusIdx(0);
  }, []);

  /** The command a full-screen program stopped, kept so it can still be sent. */
  const [blocked, setBlocked] = useState<string | null>(null);
  const run = useCallback((cmd: string, force = false) => {
    if (!root || IS_DEMO) return;
    const s = sessions.get(paneIds[focusIdx] ?? "") ?? createSession(root);
    if (runInShell(s, cmd, force)) setBlocked(null);
    else setBlocked(cmd);
  }, [root, paneIds, focusIdx]);

  const restart = useCallback(() => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (!s || IS_DEMO) return;
    if (s.ws) { s.status = "exited"; s.ws.close(); s.ws = null; }
    s.term.write("\r\n\x1b[2m— restarting shell —\x1b[0m\r\n");
    connect(s);
    s.term.focus();
  }, [paneIds, focusIdx]);

  /* Every close goes through one door: it asks only when an agent would be
     stopped, and offers Reopen afterwards (lib/closeRules.ts). */
  const closer = useWindowClose(tmuxWindows, root, tmuxCmd);
  const [noteOff, setNoteOff] = useState(noTmuxNoteDismissed);
  const stage = termState({
    status: sess?.status ?? "idle", tmux: !!sess?.tmux, due: !!sess?.tmuxDue, settled: !!sess?.settled,
    windows: tmuxWindows.length, retrying: !!sess?.retryTimer, noTmux: !!sess?.noTmux, noteDismissed: noteOff,
  });

  /* The demo has no server to ask, so `loadCommands` answers with a terminal
     that is switched off — and the overlay that message drives was covering the
     canned session. The demo's terminal is not disabled: it has no shell, which
     is a different thing and is what the status line says. */
  const disabled = !IS_DEMO && cmds ? !cmds.enabled : false;

  /*
   * New agent: a window like New shell, and when tmux reports the window that
   * was not there before (lib/newWindow.ts), the agent's command typed at its
   * prompt. The trigger is the window appearing in the frame, never a timer;
   * the line goes only once that window is the focused one, so it cannot land
   * in the window you were looking at.
   */
  const [agentFrom, setAgentFrom] = useState<ReadonlySet<string> | null>(null);
  const agentSelect = useRef(false);
  const newAgent = useCallback(() => {
    if (!sess?.tmux) { addShell(); setAgentFrom(new Set()); return; }
    agentSelect.current = false;
    setAgentFrom(new Set(tmuxWindows.map((w) => w.id)));
    tmuxCmd({ cmd: "new", root, window: focusWin || undefined });
  }, [sess, tmuxWindows, tmuxCmd, root, focusWin, addShell]);
  useEffect(() => {
    if (!agentFrom) return;
    // No tmux: the shell addShell made is the focused pane; type into it.
    if (!sess?.tmux) { setAgentFrom(null); run(agentCommand(), true); return; }
    const id = appearedWindow(agentFrom, tmuxWindows);
    if (!id) return;
    const w = tmuxWindows.find((x) => x.id === id);
    if (w && !w.active) {
      if (!agentSelect.current) { agentSelect.current = true; setPendingWindow(id); tmuxCmd({ cmd: "select", window: id }); }
      return;
    }
    setAgentFrom(null);
    run(agentCommand(), true);
  }, [agentFrom, tmuxWindows, sess, run, tmuxCmd]);

  /** Split this window: under tmux, tmux's own split binding typed as its prefix then `%`; otherwise the panel's second pane. */
  const splitKeysNow = sess?.tmux ? splitKeys(sess.tmuxPrefix) : null;
  const splitHere = useCallback(() => {
    if (!sess?.tmux) { splitPane(); return; }
    if (splitKeysNow && sess.ws?.readyState === WebSocket.OPEN) { sess.ws.send(ptyFrame({ t: "in", d: splitKeysNow })); focusTerm(); }
  }, [sess, splitKeysNow, splitPane]);
  const plus: Omit<PlusProps, "root" | "title"> = {
    disabled: !root || IS_DEMO || disabled,
    newShell: () => (sess?.tmux ? tmuxCmd({ cmd: "new", root, window: focusWin || undefined }) : addShell()),
    newAgent,
    split: sess?.tmux ? (splitKeysNow ? splitHere : null) : paneIds.length >= 4 ? null : splitHere,
    splitWhy: sess?.tmux ? "tmux's prefix is not a key this page can send, so it cannot press its split binding" : "Four panes is as many as fit",
    canResume: !!sess?.tmux && !disabled,
    onResume: (sn, how) => { tmuxCmd({ cmd: "resume", id: sn.id, cwd: sn.cwd, split: how.split, yolo: how.yolo }); focusTerm(); },
    onGo: (at) => { void api.focusPane({ sessionId: at.sessionId, windowId: at.windowId, paneId: at.paneId }); },
  };


  /*
   * What is left of the terminal's own chrome, and where it went.
   *
   * The row that stood above the tabs is gone. It carried the worktree chip —
   * branch, Diff, PR, card — and every one of those is now a door in the pane's
   * own block, drawn on the pane it describes. That is the difference that made
   * the row a duplicate rather than a summary: with four panes on screen it
   * named exactly one of them, and never the one you were reading, so the row
   * goes and only Commands and Sessions stay.
   *
   * So the survivors ride the tabs row instead, pinned to its right and OUTSIDE
   * its scroller — a right-hand group inside `overflow-x-auto` scrolls away the
   * moment there are more tabs than fit, which is precisely when somebody goes
   * looking for it. The workspace is one row shorter at rest, which is what the
   * move was for.
   */
  const barRight = (
    <>
      {/* The one piece of the old status pill worth keeping: when the shell is
          NOT fine, and only then. Unauthorised is a button because the remedy
          is a token; disconnected says so and reconnects on press. */}
      {(status === "unauthorized" || status === "error" || status === "exited") && (
        <Button
          size="strip"
          tone="danger"
          onClick={() => (status === "unauthorized" ? reauthPrompt() : restart())}
          title={status === "unauthorized"
            ? "This server needs an access token — click to enter it"
            : "The shell is not connected — click to attach again"}>
          <span aria-hidden>●</span>
          {status === "unauthorized" ? "Token needed" : "Reconnect"}
        </Button>
      )}
      {/* The way back, and it lives here because the way out lives in the
          session menu — which is on the strip being hidden. A toggle whose "off"
          state removes the button that turns it on is a one-way door. */}
      {tmuxActive && tmuxWindows.length > 0 && tmuxBar && (
        <Button size="strip" onClick={() => setTmuxBar(false)}
          title="Draw the window list here instead, and take tmux's row back for the shell">
          Use agentglass bar
        </Button>
      )}
      {/* Pinned pull requests keep their own button; Commands is one quiet icon
          (the console has the full control, the terminal the quiet one); the
          gear is Settings. All 24 px, so the right end is one rhythm. */}
      <PrPinsButton repo={liveTabFacts.get(identTabId)?.pr?.repo} />
      <CommandsPopover root={root} disabled={disabled} font={TERM_FONT} onRun={run} runTargetInTmux={!!sess?.tmux}
        onFind={() => setFindOpen(true)} onClose={focusTerm} />
      <Button size="strip" tone="quiet" square label="Terminal settings" title="Terminal settings…" onClick={() => openSettings("terminal")}><GearIcon size={ICON.sm} /></Button>
    </>
  );
  /* Exactly one of the two window lists is ever on screen, and either one can be
     absent — tmux drawing its own bar, a repo with no shell yet. `barRight` has
     to exist in all three cases or Commands and Sessions become unreachable. */
  const tabsRowShown = (!IS_DEMO && !disabled && !tmuxActive) || (tmuxActive && tmuxWindows.length > 0 && !tmuxBar);


  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      {dialog}
                {/* The plan meters live in the top bar, which is over every view
                    rather than only over the terminal. */}
                <style>{SCROLLBAR_CSS}</style>
                {/* Pin xterm's own boxes flush. The stylesheet ships no padding
                    today, but it has before and it is one release away from
                    doing so again — and the symptom (a TUI missing its bottom
                    border) reads as a bug in tmux, not as a stray CSS rule.

                    The scrollbar rule keeps the viewport from covering the last
                    column with a real 15px gutter — an overlay scrollbar takes
                    no layout width, and the wheel still scrolls. It does NOT
                    win back the strip down the right on its own: the columns
                    are counted in `fitTerm`, which is where that was actually
                    fixed, because FitAddon reserves its 14px unconditionally
                    and never looks at what the scrollbar really costs. */}
                <style>{`.xterm,.xterm-screen,.xterm-viewport{padding:0!important;margin:0!important}
.xterm-viewport{scrollbar-width:none!important}
.xterm-viewport::-webkit-scrollbar{width:0!important;height:0!important}`}</style>

                <h2 className="sr-only">Terminal</h2>
                {/* shells open in this repo — scrolls, so the count can grow.
                    keepTermFocus on the strip so switching, closing or adding a
                    shell by click doesn't blur the terminal underneath. */}
                {!IS_DEMO && !disabled && !tmuxActive && (
                  <StripFrame onMouseDown={keepTermFocus}>
                    <div role="tablist" aria-label="Shells" className="min-w-0 flex-1 self-stretch flex items-center gap-1 overflow-x-auto agw-noscrollbar">
                    {tabs.map((t) => {
                      const shown = paneIds.includes(t.id);
                      const focused = t.id === paneIds[focusIdx];
                      return (
                        <div key={t.id} role="tab" aria-selected={focused} onClick={() => showOnly(t.id)}
                          className="group flex items-center gap-1.5 px-2 rounded-lg text-[11px] cursor-pointer shrink-0"
                          style={{
                            height: CTRL_H.strip,
                            ...(focused
                              ? { background: "var(--bg)", border: EDGE, color: "var(--text)" }
                              : shown
                                ? { background: "var(--surface-inset)", color: "var(--text2)" }
                                : { color: "var(--text3)" }),
                          }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.status === "live" ? "var(--success, #98c379)" : t.status === "error" ? "var(--error)" : "color-mix(in srgb, var(--text4) 60%, transparent)" }} />
                          <span>{t.title}</span>
                          <CloseButton onClick={(e) => { e.stopPropagation(); closeShell(t.id); }} title="Close shell" className="opacity-0 group-hover:opacity-100" />
                        </div>
                      );
                    })}
                    <PlusButton root={root} {...plus} title="New shell, agent or split in this repo" />
                    </div>
                    <span className="shrink-0 flex items-center gap-1">{barRight}</span>
                  </StripFrame>
                )}

                {/* tmux's windows, as our own tabs.
                    Same shape as the shell tabs above on purpose: from the
                    user's side this is the same control, and which program is
                    behind it should not change how the workspace looks. */}
                {/* One window list or the other, never both. `tmuxBar` is the
                    user's answer to "whose bar is this", so it gates the strip
                    as well as tmux's row — a blanked row under our tabs was two
                    bars pretending to be one, and a row we keep for a prompt
                    that no longer arrives there is just a gap. */}
                {tmuxActive && tmuxWindows.length > 0 && !tmuxBar && (
                  <TermStrip shown={open} windows={tmuxWindows} groups={stripGroups} projects={groupsOn}
                    active={activeWindow} activeGroup={activeGroup} kept={keptOpen} onToggleKept={toggleKeptOpen}
                    session={{ name: tmuxSessionName, list: sess?.tmuxSessions ?? [], engine: !!sess?.tmuxEngine, prefix: sess?.tmuxPrefix ?? [] }}
                    phones={sess?.tmuxPhones ?? 0} clientCols={tmuxClient?.cols ?? null} prefixArmed={prefixArmed}
                    activePr={(() => { const pr = liveTabFacts.get(identTabId)?.pr; return pr ? prText(pr) : null; })()}
                    root={root} focusWin={focusWin} cmd={tmuxCmd} onPick={pickWindow} focusTerm={focusTerm}
                    closeWindows={closer.request} askText={askText} plus={plus}
                    onUseTmuxBar={() => setTmuxBar(true)} right={barRight} />
                )}

                {/* Neither window list is on screen — tmux is drawing its own
                    bar, or there is no shell to tab through yet — and these are
                    the only way in to a command or to a session you left. One
                    row, holding exactly what the tabs row would have held. */}
                {!tabsRowShown && (
                  <StripFrame onMouseDown={keepTermFocus}>
                    {tmuxActive && !tmuxBar && !IS_DEMO && (stage === "loading" || stage === "empty") && (
                      stage === "loading" ? <SkeletonTabs /> : <PlusButton root={root} {...plus} title="New window or agent" />
                    )}
                    <span className="flex-1" />
                    {barRight}
                  </StripFrame>
                )}

                {/* the terminals — one slot per visible pane */}
                <div ref={setRowEl} className="flex-1 min-h-0 min-w-0 flex relative">
                <div ref={wrapRef} className="flex-1 min-w-0 min-h-0 relative" style={{ background: "var(--bg)" }}
                  onMouseLeave={() => { setActionsIdx(null); setSeamNear(false); }}>
                  {/* Find and the pluck palette float over the shell, in the pane area
                      and not over the tab strip, so More and the gear stay reachable.
                      Find opens with Ctrl+Shift+F (see panelFind), closes with Escape
                      and hands the cursor back to the terminal on the way out. */}
                  {/* A notice, not a bar: the one thing the old row carried that
                      has to interrupt — a command that was NOT typed, because a
                      full-screen program had the keyboard. It floats over the
                      pane's bottom edge so it costs the terminal no rows, and the
                      Latest-output pill rides above it while it is up. */}
                  {blocked && (
                    <div onMouseDown={keepTermFocus} className="absolute flex items-center" style={{ left: 12, right: 68, bottom: 10, zIndex: LAYER.pane }}>
                      <BlockedNotice cmd={blocked} onSend={() => { run(blocked, true); setBlocked(null); }} onDismiss={() => setBlocked(null)} />
                    </div>
                  )}
                  <TermOverlays state={stage} windows={tmuxWindows} active={activeWindow} session={tmuxSessionName || null}
                    socket={sess?.tmuxSocket ?? null} root={root} canResume={plus.canResume} cmd={tmuxCmd} closer={closer}
                    onRetry={restart} onShell={plus.newShell} onAgent={newAgent} onResume={plus.onResume} onGo={plus.onGo}
                    onNoteDismissed={() => setNoteOff(true)} />
                  <LatestOutputPill term={sessions.get(paneIds[focusIdx] ?? "")?.term} noteUp={!!blocked} z={LAYER.pane} />
                  {pluckOpen && (
                    <PluckPalette rows={pluckRows} onPick={pluckPaste} onCopy={pluckCopy} onClose={() => { setPluckOpen(false); focusTerm(); }} />
                  )}
                  {findOpen && (
                    <FindBar sess={sessions.get(paneIds[focusIdx] ?? "")} onClose={() => { setFindOpen(false); focusTerm(); }} />
                  )}
                  {/* The gap survives — it separates two panes and is doing real
                      work. The outer padding does not: with one pane it is pure
                      dead margin, and a full-screen TUI is drawn right to the
                      edge. Only inset when there is more than one pane, so the
                      split doesn't sit flush against the panel border. */}
                  <div className={`absolute inset-0 grid gap-1.5 ${paneIds.length > 1 ? "p-1.5" : ""}`}
                    style={{
                      gridTemplateColumns: paneIds.length > 1 ? "1fr 1fr" : "1fr",
                      gridTemplateRows: paneIds.length > 2 ? "1fr 1fr" : "1fr",
                    }}>
                    {paneIds.map((id, i) => (
                      <div key={id}
                        ref={(el) => { paneRefs.current[i] = el; }}
                        onMouseDown={() => setFocusIdx(i)}
                        onMouseEnter={(e) => { hoverFocus(i, e.buttons); setActionsIdx(i); }}
                        // And inside tmux, where the panes are painted rather
                        // than rendered — so this needs the pointer's position,
                        // not just the fact that it arrived.
                        onMouseMove={(e) => { hoverTmuxPane(i, e); nearFoot(e); setActionsIdx((cur) => (cur === i ? cur : i)); }}
                        // No padding. A full-screen TUI — tmux, nvim, htop —
                        // draws its own borders and status lines flush to the
                        // edge, so any inset here shows up as a dead margin
                        // around the app and costs a column and a row of the
                        // grid the shell was told it had.
                        // Square under tmux. A rounded corner clips the corner
                        // cell of a TUI that draws its own border right to the
                        // edge, so tmux's frame and vim's status line come out
                        // visibly chewed. Only round it when the pane is ours
                        // to decorate.
                        className={`min-w-0 min-h-0 overflow-hidden ${tmuxActive ? "" : "rounded-lg"}`}
                        style={{
                          // Match the terminal's own background. xterm can only
                          // draw whole character cells, so a container that
                          // isn't an exact multiple of the cell size leaves a
                          // strip of remainder down the right and along the
                          // bottom — a few pixels wide, and glaringly obvious
                          // when it shows the panel behind it instead.
                          background: "var(--bg)",
                          /* Always open keeps its strip in the slot itself: the
                             terminal is fitted to what is left, so nothing is
                             ever drawn over a row. Summary and the edge line
                             keep nothing. */
                          paddingBottom: actionsMode === "always" ? STRIP_H.always : 0,
                          border: paneIds.length > 1 && i === focusIdx
                            ? "1px solid color-mix(in srgb, var(--primary) 45%, transparent)"
                            : "1px solid transparent",
                        }} />
                    ))}
                  </div>
                  {/*
                    * The pane's own four doors.
                    *
                    * Drawn in the wrapper rather than inside the slot: the slot
                    * is where xterm's element is reparented to by hand, and
                    * React children beside an imperatively appended node is a
                    * fight nobody needs to have. The wrapper is already
                    * `relative`, so it is the coordinate space the box was
                    * measured in.
                    *
                    * Only the pane under the pointer, and only when the bar
                    * beside them has an answer: a block whose buttons lead
                    * nowhere is chrome. `chipWt` is that answer — the same one
                    * the strip at the top is showing, for the same pane.
                    */}
                  {/* Not while the scratch is up. A tmux popup is drawn INTO
                      this same screen — the windows, the panes and the
                      geometry are all unchanged — so the block went on being
                      drawn over the popup, on a pane nobody can see, following
                      a pointer that is no longer choosing anything. Reported
                      with six screenshots of exactly that. */}
                  {/* The seam is drawn whether or not the worktree read has come
                      back. A pane that shows nothing at all is indistinguishable
                      from a broken feature — which is exactly how this was
                      reported — so while it is reading, the bar says so, the way
                      the strip above the terminal used to before it was deleted.
                      *
                      *
                      * The popup gate is back, and it belongs here: a popup is
                      * drawn INTO this screen, so a seam under a pane the popup
                      * is covering is a line across somebody's scratch — "from
                      * the scratch, that bar of the panes underneath gets
                      * activated", with a screenshot of the bar standing on top of
                      * it. What it is gated on is sharper than it was, since
                      * one stray `tmux attach` left running by an agent used to
                      * read as a popup and take the bar off every pane of every
                      * session: a popup's pty belongs to no pane, an attach
                      * typed inside one carries that pane's tty. */}
                  {actionsMode !== "off" && actionsMode !== "always" && footBox && focusedBar(footBox)}
                  {actionsMode === "always" && paneIds.map((id, i) => {
                    const foot = slotFoots[i];
                    if (!foot) return null;
                    return i === focusIdx
                      ? <Fragment key={id}>{focusedBar(foot)}</Fragment>
                      : <SlotBar key={id} sessId={id} foot={foot} repos={repos} project={here?.worktreeOf || here?.root || root}
                          open={open} canSide={sideCan} flash={0} onFocusMe={() => setFocusIdx(i)} onSide={(sec, tab) => openSide(tab, sec)}
                          onOpenProject={(name) => { const r = repos.find((x) => x.name === name || dirName(x.root) === name); if (r) setRoot(r.root); }} />;
                  })}
                  {/* Not in the demo any more. The overlay is for a terminal
                      that cannot draw anything — Windows, or disabled by config
                      — and in the demo it was covering a terminal that now has
                      a session in it. What the demo owes a visitor is the note
                      in the status line below, not a sheet over the feature. */}
                  {disabled && (
                    <div className="absolute inset-0 flex items-center justify-center text-[12px] t-dim2" style={{ background: "color-mix(in srgb, var(--bg) 80%, transparent)" }}>
                      {cmds?.reason === "windows"
                        ? "The terminal is not available on Windows yet (the PTY backend needs POSIX; ConPTY support is planned)"
                        : cmds?.reason === "config"
                        ? "Terminal disabled (terminalDisabled in config.json)"
                        : "Terminal disabled (AGENTGLASS_TERMINAL_DISABLED=1)"}
                    </div>
                  )}

                  {/* Your terminal is being drawn at somebody else's width.

                      A card that floats over the bottom right corner of the
                      panes, NOT a row above them. As a row it took its height
                      out of the terminal, so a phone connecting reflowed every
                      pane on the desk and disconnecting reflowed them back:
                      the notice about a resize was itself causing one, and a
                      full-screen TUI redrew underneath it both times. Floating,
                      it costs the terminal no rows at all and nothing moves.

                      Anchored inside the pane box rather than to the viewport,
                      which puts it in the screen's bottom right corner without
                      covering the status line, and, because the whole terminal
                      view is hidden with `visibility` when you are looking at
                      another view, means it cannot follow you into chat or the
                      diff the way a portal to the body would.

                      Deliberately OUTSIDE the `!tmuxBar` guard above: this is
                      not the tab strip, and someone who kept tmux's own status
                      line has exactly the same broken layout and none of the
                      strip.

                      keepTermFocus for the same reason the strip has it — the
                      button must not take the keyboard off the pane. Pointer
                      events stop at the card itself, so a drag that starts
                      anywhere else on the pane still selects text as usual. */}
                  {held && heldKey !== heldHidden && (
                    <div onMouseDown={keepTermFocus} role="status"
                      className="absolute bottom-3 max-w-[21rem] flex flex-col gap-2 px-3.5 py-2.5 rounded-xl text-[10.5px] leading-relaxed"
                      style={{
                        zIndex: LAYER.pane,
                        // The bench button sits at the window's bottom-right: the card clears it when the focused pane reaches that corner.
                        right: cardAtCorner ? "var(--fab-reserve)" : 12,
                        color: "var(--text2)",
                        // Opaque rather than blurred: this sits over a terminal
                        // that repaints constantly, and a backdrop-filter here
                        // is a per-frame cost for the whole rectangle.
                        background: "var(--surface-card)",
                        border: "1px solid color-mix(in srgb, var(--phone) 45%, transparent)",
                        boxShadow: "0 18px 40px -18px var(--shadow)",
                        animation: "agx-zoom-in .12s ease-out",
                      }}>
                      <div className="flex items-start gap-2">
                        {/* The width sentence has two states, split on `w.phone`,
                            so the present tense is only used when a phone is
                            actually there.

                            The second one no longer blames the phone, and that
                            is a consequence of the server putting these back by
                            itself: a window a phone pinned carries a mark, and
                            a marked window with nobody on it is restored within
                            a couple of seconds without anybody clicking. So by
                            the time this sentence is on screen the size is one
                            this app cannot prove it took — most often somebody's
                            own `resize-window` — and "your phone left without
                            putting it back" would be a guess presented as a
                            fact. The numbers are still worth saying, and the
                            button still works on either.
                            The zoom sentence has one state, because it is only
                            ever shown while a phone is here (see
                            `heldWindow`), and it says the panes are still
                            RUNNING: that is the actual question — a window that
                            went from four panes to one reads like three
                            programs died. */}
                        <span className="min-w-0">
                          {held.narrow && (held.win.phone ? (
                            <>Your phone is driving this window. It is <Cols n={held.narrow.winCols} /> columns while your terminal is <Cols n={held.narrow.deskCols} />, so tmux is drawing everything at phone width.</>
                          ) : (
                            <>This window is <Cols n={held.narrow.winCols} /> columns to your terminal&apos;s <Cols n={held.narrow.deskCols} />, with nothing attached to it at that size. A phone&apos;s reflow is put back on its own, so this one came from somewhere else.</>
                          ))}
                          {held.narrow && held.zoomed && " "}
                          {held.zoomed && (
                            <>Your phone opened one pane here, so tmux has zoomed the window onto it — your other panes are still running, they are just not being drawn.</>
                          )}
                        </span>
                        {/* Closing hides the card, never the situation: the
                            width stays wrong, and the same card comes back on
                            its own as soon as the state is a different one (see
                            `heldKey`). It exists because this now sits over your
                            output instead of above it, and a card you cannot put
                            away would be a permanent hole in the corner of a
                            full-screen TUI. */}
                        <CloseButton onClick={() => setHeldHidden(heldKey)}
                          className="shrink-0 opacity-50 hover:opacity-100"
                          title="Hide this until the window changes — the width stays as it is" />
                      </div>
                      {/* Nothing is remembered from this click. The notice is a
                          pure function of the next sweep, so if tmux did not
                          actually move it correctly stays up — an optimistic
                          "taken over" flag would hide a take-over that failed,
                          and unlike the tab click above, this is not an answer
                          the user already knows. */}
                      {/* The label follows what is actually wrong. "Take the
                          width back" on a window that is the right width and
                          missing three panes would name the wrong problem, and a
                          button that names the wrong problem is one nobody
                          presses. */}
                      <Button size="compact" onClick={() => tmuxCmd({ cmd: "takeover", window: held.win.id })}
                        className="self-end shrink-0"
                        style={{ border: "1px solid color-mix(in srgb, var(--phone) 45%, transparent)" }}
                        title={held.zoomed
                          ? "Unzoom this window and resize it to your terminal, then leave it following your terminal — the phone stays connected and can still ask for the pane back later"
                          : "Resize this window to your terminal and leave it following your terminal — the phone stays connected and can still ask for a reflow later"}>
                        {held.zoomed ? "Give me my window back" : held.win.phone ? "Take the width back" : "Restore the width"}
                      </Button>
                    </div>
                  )}
                </div>
                {sideOn && !sideOverlay && (
                  <SideDivider rowLeft={() => rowEl?.getBoundingClientRect().left ?? 0}
                    onWidth={(x) => { setCompact(false); setSideWidth(sideTab, dragWidth(x, rowW, termMinPx)); }}
                    onReset={() => setSideWidth(sideTab, null)} />
                )}
                {(sideOn || sideSeen.current) && (
                  <div className={sideOverlay ? "absolute top-0 bottom-0 right-0 flex" : "flex shrink-0 min-h-0"}
                    style={!sideOn ? { display: "none" } : sideOverlay ? { boxShadow: "-10px 0 24px -12px var(--shadow)" } : undefined}>
                    <SidePaneFor tab={sideTab} view={sideView} width={sideW} active={open && sideOn} hidden={!sideOn} at={chipWt} overlay={sideOverlay}
                      onPopOut={(sec) => { void paneDoor(sec); }} focusTerm={focusTerm} onType={typeIntoPane} />
                  </div>
                )}
                </div>

                {/*
                  * THE STATUS LINE IS GONE, except when it has something to say.
                  *
                  * It held three things and only one of them was worth a row of
                  * the window: a sentence about the app ("tmux owns the panes"),
                  * a seven-key cheat sheet for a prefix anybody using this knows
                  * by heart, and the pane's size, which matters for the second it
                  * changes and never again. Under all of it, the one thing that
                  * actually saves you: rows of this pane hidden below the panel
                  * because a bigger client is attached, with the button that
                  * fixes it.
                  *
                  * So the row exists only then. A bar that is always there and
                  * usually says nothing teaches you not to read it, which is how
                  * the warning inside it was going to be missed.
                  */}
                {tmuxActive && hiddenRows > 0 && (
                  <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-t text-[9.5px]" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <span style={{ color: "var(--warning-ink)" }}>
                      {hiddenRows} row{hiddenRows === 1 ? "" : "s"} of this pane are below the panel —
                      a bigger client is attached, so the last line (an editor's status bar) is off-screen
                    </span>
                    <Button size="compact" tone="warn" onClick={() => tmuxCmd({
                        cmd: "fit",
                        window: tmuxWindows.find((w) => w.active)?.id ?? "",
                        cols: sess?.term.cols, rows: sess?.term.rows,
                      })}
                      title="Size this tmux window to this panel. The other client keeps working; it just stops deciding the size.">
                      Fit to this window
                    </Button>
                  </div>
                )}
    </div>
  );
}



