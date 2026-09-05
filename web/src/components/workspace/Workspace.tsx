// The shell. Not an overlay any more — the application.
//
// This was a modal: a Portal, a scrim, an AnimatePresence, and a frame inset
// from the viewport that you opened with ⌘\ and closed with Escape. That shape
// made sense when it was five separate panels being consolidated. It stopped
// making sense the day it became the thing people are inside 99% of the time:
// the app's front door was a screen nobody visited, and the thing everybody
// used was a dialog on top of it.
//
// So the frame IS the window now. No scrim, no open/close, nothing to return
// to — and the dashboard did not disappear, it moved into the rail beside every
// other view, entire and unchanged.
//
// Mounting changed with it. Every view used to mount as soon as the workspace
// opened and stay mounted for the life of the process, which is what kept a
// half-written commit message alive while you looked at the diff. That is still
// true of a view you have BEEN to; what changed is that a view you have never
// opened does not exist yet. On a fresh window that is one view rather than
// eight, and the dashboard — fourteen panels and a poll every four seconds — is
// not among them until you ask for it.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hiddenOnly } from "./hiddenOnly.ts";
import { ViewRail, type RailPip } from "./ViewRail.tsx";
import { pushScope } from "../../lib/findScope.ts";
import { VIEWS, saveLastView, type ViewId } from "./views.ts";
import { ViewBoundary } from "./ViewBoundary.tsx";
import { subscribe as subscribeChats, attentionCount, listChats, newChat, requestChatFocus, seedChat, setActiveChatId, update as updateChat } from "../../lib/chatStore.ts";
import { FilesView } from "../FilesPanel.tsx";
import { TasksView } from "../TasksPanel.tsx";
import { subscribeReminders, firedCount } from "../../lib/reminderStore.ts";
import { GitView } from "../GitPanel.tsx";
import { DiffPage } from "../diff/DiffPage.tsx";
import { PrView } from "../PrPanel.tsx";
import { DockerView } from "../DockerPanel.tsx";
import { TermView, subscribeSessions, liveSessionCount } from "../TerminalPanel.tsx";
import { ChatView } from "../ChatPanel.tsx";
import { BrowserView } from "../BrowserPanel.tsx";
import { UnderstudyView } from "../understudy/UnderstudyPanel.tsx";
import { LanternView } from "../LanternView.tsx";
import { subscribeLantern, lanternNeed } from "../../lib/lanternStore.ts";
import { requestTermReview } from "../../lib/termReview.ts";

/**
 * Views that keep running with the door shut.
 *
 * Everything else is free when it is not on screen — that is the contract this
 * shell exists for. These two are the deliberate exceptions and they are not an
 * oversight: a terminal holds a pty and a chat holds a stream, and unmounting
 * either would kill a session nobody asked to end. The cost is real, and it is
 * the price of them being sessions rather than screens.
 */
/*
 * Mounted whether or not anybody has been there.
 *
 * The terminal and the chat because they hold a live session. The BROWSER for a
 * different reason: it is the only view an AGENT drives, and until its panel is
 * mounted nothing can answer one — so the first `agentglass-browser` call of a
 * session was answered with "the view is not open", which the CLI fixes by
 * opening it, which takes the screen off whoever was typing. Mounting it costs
 * nothing until it is looked at: its tabs come back asleep, and a sleeping tab
 * is a name and an address with no guest behind it.
 */
const KEEP_RUNNING = new Set<ViewId>(["term", "chat", "browser"]);

/*
 * There is no fleet column here, and there was one for about an hour.
 *
 * The argument for it was "know what each agent is doing without leaving the
 * work". Built and used, it did not hold: the dashboard's own session panel
 * already says all of it and says it better, most rows on a real machine are
 * `tmp · SessionStart` rather than anything actionable, and it charged 190px of
 * every view for the privilege. The one thing it was genuinely for — noticing
 * that something wants you — belongs to the top bar, which interrupts from
 * every view and costs no width at all.
 */

export function Workspace({
  view, onView, onSkills, onSettings, onMachine, chatFocusId, dashboard, prJump, cardJump, issueJump,
}: {
  view: ViewId;
  onView: (v: ViewId) => void;
  onSkills: () => void;
  onSettings: () => void;
  onMachine: (tab: "ports" | "resources") => void;
  chatFocusId?: string | null;
  /** The dashboard is a view like any other, but its data lives at the root
   *  (the live socket feeds the chat store too), so it arrives already built
   *  and is handed its own `active` here like everything else. */
  dashboard: (active: boolean) => React.ReactNode;
  /** A pull-request errand another panel sent — see lib/openPrs.ts. */
  prJump?: import("../../lib/openPrs.ts").PrJump | null;
  /** The same errand the other way round — see lib/openCard.ts. */
  cardJump?: import("../../lib/openCard.ts").CardJump | null;
  issueJump?: import("../../lib/openIssue.ts").IssueJump | null;
}) {
  const openChat = useCallback(() => onView("chat"), [onView]);
  /* Held, not inlined. The hidden views are behind a memo that compares props
     by identity, and a fresh arrow on every render of this component makes that
     comparison fail for all seven of them — which is the memo doing nothing at
     all. Same shape as `openChat` above for the same reason. */
  const openBrowser = useCallback(() => onView("browser"), [onView]);

  /**
   * Start a chat already pointed at a directory, with a prompt waiting.
   *
   * The prompt lands in the composer rather than being sent: a review is a real
   * Claude run that costs real tokens, and it should not begin because you
   * clicked a button one pane over. A seeded tab that was never sent is reused
   * rather than duplicated — clicking twice means "show me that again".
   */
  const openChatWith = useCallback((cwd: string, prompt: string, title: string) => {
    seedChat(cwd, prompt, title);
    onView("chat");
  }, [onView]);

  /** Send a pull request review to a window on the ENGINE, and go there to
   *  watch it. It used to go to the user's own tmux, and refused outright when
   *  their shell was not inside one — see terminal.ts's `review` handler.
   *  Left as a request rather than called directly: the terminal view owns the
   *  socket, and may not be mounted when the button is pressed. */
  const reviewInTerminal = useCallback((root: string, number: number, recipe = "", card = "") => {
    requestTermReview(root, number, recipe, card);
    onView("term");
  }, [onView]);

  const frameRef = useRef<HTMLDivElement>(null);
  const chatWaiting = useSyncExternalStore(subscribeChats, attentionCount, attentionCount);
  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);
  const firedReminders = useSyncExternalStore(subscribeReminders, firedCount, firedCount);
  const lanternWaiting = useSyncExternalStore(subscribeLantern, lanternNeed, lanternNeed);

  const pips: Partial<Record<ViewId, RailPip>> = {
    chat: chatWaiting > 0 ? { count: chatWaiting } : {},
    // The lantern lights: how many agents are stopped on a person right now.
    // Not how many agents there are — twenty working is a normal afternoon.
    lantern: lanternWaiting > 0 ? { count: lanternWaiting } : {},
    term: shells > 0 ? { dot: true } : {},
    // The count of things shouting at you, not the size of your backlog: a
    // hundred open tasks is a normal Tuesday, and a badge that said so would
    // be ignored within a day.
    tasks: firedReminders > 0 ? { count: firedReminders } : {},
  };

  /**
   * Which views have ever been opened.
   *
   * A view enters this set the first time you go to it and never leaves, which
   * is what preserves the state everything here depends on — a filter typed in
   * the diff, a repo picked in git, a scroll position in a pull request. What it
   * does NOT do is build all of them up front for somebody who only wanted a
   * terminal.
   */
  const [visited, setVisited] = useState<Set<ViewId>>(() => new Set<ViewId>([view]));
  useEffect(() => {
    setVisited((cur) => (cur.has(view) ? cur : new Set(cur).add(view)));
    saveLastView(view);
  }, [view]);

  const mounted = useMemo(
    () => VIEWS.filter((v) => visited.has(v.id) || KEEP_RUNNING.has(v.id)),
    [visited],
  );

  // Focus the frame on mount, so the rail's arrow keys and the view shortcuts
  // work without a click first.
  useEffect(() => {
    const id = requestAnimationFrame(() => frameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div ref={frameRef} tabIndex={-1} className="flex-1 min-h-0 flex outline-none">
      <ViewRail view={view} onSelect={onView} onSkills={onSkills}
        onSettings={onSettings} onMachine={onMachine} pips={pips} />

      <div className="relative flex-1 min-w-0">
        {mounted.map((v) => {
          const active = v.id === view;
          return (
            <ViewBox
              key={v.id}
              active={active}
              // `visibility`, not `display:none`: xterm's fit addon measures its
              // container, and a display:none parent measures 0x0 — which is how
              // a hidden terminal comes back reflowed to a single column.
              //
              // NOT `content-visibility: hidden`: these views are absolutely
              // stacked and a content-visibility box still hit-tests, so a
              // hidden view on top would swallow clicks meant for the active one
              // beneath it. `visibility: hidden` does not.
            >
              {/* One boundary per view, INSIDE the box rather than around the
                  map: a throw in Git leaves the rail, the terminal's sockets
                  and every other view exactly where they were. Without it the
                  whole tree unmounts and the window goes black — measured
                  twice in a month, and the second time nothing on screen said
                  which view had done it. */}
              <ViewBoundary label={v.label}>
                {v.id === "dash"
                  ? dashboard(active)
                  : <Body id={v.id} active={active} openChat={openChat} openChatWith={openChatWith} prJump={prJump}
                      openBrowser={openBrowser}
                      cardJump={cardJump} issueJump={issueJump} reviewInTerminal={reviewInTerminal} chatFocusId={chatFocusId} />}
              </ViewBoundary>
            </ViewBox>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One view's box, and — while it is the one on screen — what "find on this
 * screen" means.
 *
 * The stacking is why this needs saying out loud: every visited view stays
 * mounted and the inactive ones are merely `visibility: hidden`, so a search
 * over the document would walk several screens' worth of text nobody can see.
 * The active box registers itself as the find scope and gives it up on the way
 * out; anything that opens OVER it (a card, Settings, the file viewer) pushes
 * itself on top at a higher rank. See findScope.ts.
 */
function ViewBox({ active, children }: { active: boolean; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !box.current) return;
    return pushScope(box.current, 0);
  }, [active]);
  return (
    <div
      ref={box}
      // `visibility`, not `display:none`: xterm's fit addon measures its
      // container, and a display:none parent measures 0x0 — which is how a
      // hidden terminal comes back reflowed to a single column.
      //
      // NOT `content-visibility: hidden`: these views are absolutely stacked
      // and a content-visibility box still hit-tests, so a hidden view on top
      // would swallow clicks meant for the active one beneath it.
      // `visibility: hidden` does not.
      className="absolute inset-0 flex flex-col min-h-0"
      style={{ visibility: active ? "visible" : "hidden" }}
      aria-hidden={!active}
      /* Findable from outside React: a screenshot of a pane nobody is looking
         at has to make that pane paint for a moment, and the thing it flips is
         this box's visibility. See panePainting.ts. */
      data-agx-viewbox=""
    >
      {children}
    </div>
  );
}

/** The non-dashboard views, and the props each one wants. Split out so the map
 *  above stays about mounting rather than about plumbing. */
function BodyImpl({ id, active, openChat, openChatWith, openBrowser, reviewInTerminal, chatFocusId, prJump, cardJump, issueJump }: {
  id: ViewId; active: boolean;
  openChat: () => void;
  /** Bring the browser view forward — the Docker panel asks for it when you
   *  open a container's port, so a dev server lands in a tab of this app
   *  instead of somewhere else. */
  openBrowser: () => void;
  openChatWith: (cwd: string, prompt: string, title: string) => void;
  reviewInTerminal: (root: string, number: number, recipe?: string, card?: string) => void;
  chatFocusId?: string | null;
  prJump?: import("../../lib/openPrs.ts").PrJump | null;
  cardJump?: import("../../lib/openCard.ts").CardJump | null;
  issueJump?: import("../../lib/openIssue.ts").IssueJump | null;
}) {
  switch (id) {
    case "files": return <FilesView active={active} />;
    case "tasks": return <TasksView active={active} onOpenChatWith={openChatWith} cardJump={cardJump} issueJump={issueJump} />;
    case "git": return <GitView active={active} onOpenChat={openChat} />;
    case "diff": return <DiffPage active={active} />;
    case "pr": return <PrView active={active} onOpenChatWith={openChatWith} onReviewInTerminal={reviewInTerminal} jumpTo={prJump} />;
    case "docker": return <DockerView active={active} onOpenBrowser={openBrowser} />;
    case "term": return <TermView active={active} />;
    case "chat": return <ChatView active={active} focusId={chatFocusId} />;
    case "browser": return <BrowserView active={active} />;
    /* Nothing is passed but `active`, and that is the shape of the whole
       feature rather than an oversight: the clone reads a scorecard off
       the socket and has nothing to hand to another view — no chat to seed, no
       pull request to jump to. A view that only watches needs no errands. */
    case "understudy": return <UnderstudyView active={active} />;
    /* Its chat is a tab on the floating bench, not a seeded Chat view — see
       lanternAsk.ts. Nothing to hand it. */
    case "lantern": return <LanternView active={active} />;
    default: return null;
  }
}

const Body = memo(BodyImpl, hiddenOnly);
