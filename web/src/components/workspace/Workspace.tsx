import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Portal } from "../Portal.tsx";
import { ViewRail, type RailPip } from "./ViewRail.tsx";
import { VIEWS, saveLastView, type ViewId } from "./views.ts";
import { subscribe as subscribeChats, attentionCount, newChat, setActiveChatId, update as updateChat } from "../../lib/chatStore.ts";
import { GitView } from "../GitPanel.tsx";
import { DiffView } from "../ChangesModal.tsx";
import { PrView } from "../PrPanel.tsx";
import { DockerView } from "../DockerPanel.tsx";
import { TermView, subscribeSessions, liveSessionCount } from "../TerminalPanel.tsx";
import { ChatView } from "../ChatPanel.tsx";
import { DynamicIsland, NOTCH_BAND } from "./DynamicIsland.tsx";

const BODY = {
  git: GitView,
  diff: DiffView,
  pr: PrView,
  docker: DockerView,
  term: TermView,
  chat: ChatView,
} as const;

/** One overlay, six views.
 *
 *  Every view mounts as soon as the workspace opens and stays mounted until it
 *  closes — switching only flips visibility. That is the whole point: the old
 *  five-separate-modals shape tore a panel down on every switch, so a commit
 *  message half-written in git evaporated the moment you looked at the diff.
 *  Polling is gated on `active` rather than on mount, so the four views you
 *  aren't looking at keep their state without costing anything on the network.
 */
export function Workspace({
  open, view, onView, onClose, chatFocusId,
}: {
  open: boolean;
  view: ViewId;
  onView: (v: ViewId) => void;
  onClose: () => void;
  chatFocusId?: string | null;
}) {
  // Same reason as App's onClose: this reaches a view's effect dependencies,
  // and a fresh arrow each render is a remount nobody asked for.
  const openChat = useCallback(() => onView("chat"), [onView]);

  /**
   * Start a chat already pointed at a directory, with a prompt waiting.
   *
   * The prompt lands in the composer rather than being sent: a local PR review
   * is a real Claude run against a real checkout, and it should not begin
   * because you clicked a button one pane over. You read it, then you send it.
   */
  const openChatWith = useCallback((cwd: string, prompt: string) => {
    const chat = newChat(cwd);
    updateChat(chat.id, (c) => { c.draft = prompt; c.title = "pr review"; });
    setActiveChatId(chat.id);
    onView("chat");
  }, [onView]);
  const frameRef = useRef<HTMLDivElement>(null);

  const chatWaiting = useSyncExternalStore(subscribeChats, attentionCount, attentionCount);
  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);

  const pips: Partial<Record<ViewId, RailPip>> = {
    chat: chatWaiting > 0 ? { count: chatWaiting } : {},
    term: shells > 0 ? { dot: true } : {},
  };

  useEffect(() => { if (open) saveLastView(view); }, [open, view]);

  // Focus the frame on open so Escape and the rail's arrow keys work without
  // needing a click first.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => frameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              // No backdrop-filter. A blur re-runs over whatever sits beneath it
              // every time that repaints, and beneath this is an animating
              // dashboard in a software-composited webview, so the blur was
              // charged to the CPU on every frame. The scrim alone reads the
              // same at this opacity.
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.72)" }}
              onClick={onClose}
            />
            {/* The top padding is the notch's band, and the height is clamped
                so the frame can never grow back into it. Centring alone was not
                enough: 95vh leaves 2.5vh of clearance, which is 28px on a 1123px
                window — less than the strip is tall, so it covered the view's
                header and ate clicks meant for it. Reserving the band makes the
                overlap zero at every window size instead of at most of them. */}
            <div
              className="fixed inset-0 flex items-center justify-center px-3 pb-3 pointer-events-none"
              style={{ zIndex: 10001, paddingTop: NOTCH_BAND }}
            >
              <motion.div
                ref={frameRef}
                tabIndex={-1}
                role="dialog"
                aria-label="Workspace"
                // Opacity only, and briefly. A spring on scale/y re-rasterises a
                // 95vw x 95vh surface on every frame of the transition, which is
                // what made opening the workspace feel like a stall instead of a
                // switch.
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.12, ease: "easeOut" }}
                // Fills its padding box rather than picking its own 95vw/95vh:
                // the container already states the margins (12px at the sides
                // and bottom, the notch's band at the top), and a viewport
                // percentage on top of that made the side gaps four times the
                // bottom one — 50px against 12px on this display.
                className="w-full rounded-2xl flex pointer-events-auto outline-none overflow-hidden"
                style={{
                  height: `calc(100vh - ${NOTCH_BAND + 12}px)`,
                  background: "var(--bg2)",
                  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                  boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)",
                }}
              >
                <ViewRail view={view} onSelect={onView} onClose={onClose} pips={pips} />

                <div className="relative flex-1 min-w-0">
                  {VIEWS.map((v) => {
                    const View = BODY[v.id];
                    const active = v.id === view;
                    return (
                      <div
                        key={v.id}
                        // `visibility`, not `display:none`: xterm's fit addon
                        // measures its container, and a display:none parent
                        // measures 0x0, which is how a hidden terminal comes
                        // back reflowed to a single column.
                        //
                        // NOT `content-visibility: hidden`: these views are
                        // absolutely stacked and chat is last in the DOM, so a
                        // content-visibility box still hit-tests and the hidden
                        // top view swallows clicks meant for the active one
                        // beneath it. `visibility: hidden` does not.
                        className="absolute inset-0 flex flex-col min-h-0"
                        style={{ visibility: active ? "visible" : "hidden" }}
                        aria-hidden={!active}
                      >
                        {/* term and chat can dismiss the workspace from the
                            inside — Shift+Esc in the shell, Escape in the
                            composer — so they alone need onClose. */}
                        <View
                          active={active}
                          {...(v.id === "chat" ? { focusId: chatFocusId, onClose } : {})}
                          {...(v.id === "git" ? { onOpenChat: openChat } : {})}
                          {...(v.id === "pr" ? { onOpenChatWith: openChatWith } : {})}
                          {...(v.id === "term" ? { onClose } : {})}
                        />
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </div>
            {/* One ambient status surface for the whole overlay -- clock, plan
                meters, live-work pulse and the events worth looking up for. It
                hangs off the frame's top edge and covers every view, which is
                why it lives here rather than inside any one of them. */}
            <DynamicIsland />
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
