// Your machine's notifications, on top of the app that is covering your screen.
//
// The whole reason the mirror exists is that agentglass runs fullscreen: a Slack
// ping fires a banner you never see, because this app is what is in front of it.
// The server has read those off the D-Bus session bus for a while and the bell
// has listed them — but the only thing that *interrupted* was a line of 10px
// text in the middle of the top bar, which loses its slot to the "needs you"
// chip the moment anything is held, and which cannot carry a message anyway.
// "Slack — New message from <somebody>" plus the message itself is two lines
// of prose, not a caption.
//
// So mirrored notifications get the surface they always needed: a card, in a
// stack, over everything. Deliberately separate from the bar's lane, which keeps
// agentglass's own passing events — those are captions ("Turn finished", "3 to
// pull") and belong in a caption-sized place.
//
// What it is not: a notification daemon. Your desktop still shows its own
// banners exactly as before; this is a copy for the case where you cannot see
// them. And nothing arrives here unless the feature is switched on, because the
// socket that feeds it is not opened until then (see sysNotify.ts).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { subscribeSystemNotes, openNote, type SystemNote } from "../lib/sysNotify.ts";
import { Chevron, MuteGlyph, useClipped } from "./TopBarNotes.tsx";
import { Portal } from "./Portal.tsx";
import { CloseIcon } from "./CloseButton.tsx";
import { Card } from "./workspace/Chrome.tsx";
import { canMute, mutedSources, setMuted, sourceLabel, sourceOf, subscribeMuted } from "../lib/notePolicy.ts";
import { Menu, MenuItem } from "./PrPanel.tsx";
import { noteSurface, noteSurfaceTip } from "../lib/linkRouter.ts";
import { benchLinks } from "../lib/termPrefs.ts";
import { appLinkFor } from "../lib/appLink.ts";
import { answerGate, gateForNote, listGates, subscribeGates } from "../lib/gateStore.ts";
import { VIEW_OF, cardAction, stackCard, type LiveCard } from "../lib/noteCard.ts";
import { ICON } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";

type Goto = NonNullable<SystemNote["goto"]>;
type Where = "bench" | "view";

/** How long an ordinary card holds the corner. Long enough to read two lines of
 *  someone else's message without hurrying, short enough that a busy minute does
 *  not bury the screen. */
const HOLD_MS = 7000;

/**
 * How many are on screen at once.
 *
 * Three, and the oldest leaves when a fourth arrives. Repeats from one app fold
 * into one card with ×N first (stackCard), so three is three apps, not three
 * lines of one group chat — and everything that scrolls off is still in the bell.
 */
const MAX = 3;

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

/**
 * A stand-in for the sender's icon.
 *
 * The bus carries an icon name, not an image, and resolving one to a themed
 * file on disk is a per-desktop guess we would get wrong for exactly the
 * sandboxed apps this feature is for. An initial in the app's own colour says
 * "Slack" at a glance and never says it wrongly.
 */
function AppMark({ app, urgent }: { app: string; urgent: boolean }) {
  const letter = (app.trim()[0] ?? "•").toUpperCase();
  const tint = urgent ? "var(--error)" : "var(--primary)";
  return (
    <span
      className="grid place-items-center rounded-md shrink-0 text-[10px] font-bold"
      style={{
        width: 20, height: 20, color: tint,
        background: `color-mix(in srgb, ${tint} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
      }}
      aria-hidden
    >{letter}</span>
  );
}

/** The kit's Card, faded in: a toast is a card with its own surface, not a copy of one. */
const MCard = motion.create(Card);

function Toast({ n, count, onGone, onGoto }: {
  n: SystemNote;
  count: number;
  onGone: () => void;
  onGoto: (g: Goto, where?: Where) => void;
}) {
  const [held, setHeld] = useState(false);
  // Keyboard focus inside the card (the caret, its menu) holds it as the mouse does: a menu opened with
  // Enter must not close under the arrow keys when the timer runs out. The menu is a portal, but React's
  // focus events bubble through it to the card.
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyEl = useRef<HTMLSpanElement>(null);
  const gates = useSyncExternalStore(subscribeGates, listGates, listGates);
  const gate = n.urgency === 2 ? gateForNote(n, gates) : null;
  // Whether three lines is showing everything. Measured rather than guessed
  // from the length, and measured once the card is actually in the document —
  // see useClipped, which exists because a Portal's children have no layout at
  // the moment their own effects run.
  const cut = useClipped([bodyEl], !open, [n.body]);

  // An agent that waits stays until it is answered ("Stays until you answer"),
  // and so does one you have opened: expanding it is you saying you are
  // reading it, and a card that vanishes mid-sentence is no card at all.
  useEffect(() => {
    if (held || focused || open || n.urgency === 2) return;
    const id = setTimeout(onGone, HOLD_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, focused, open, n.id]);
  // A hold answered anywhere (the bell, the strip, another device) takes its card with it.
  const hadGate = useRef(false);
  useEffect(() => {
    if (gate) hadGate.current = true;
    else if (hadGate.current) onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate]);

  const act = cardAction(n, { bench: benchLinks(), appLink: appLinkFor(n.app), gate: !!gate });
  // A pull request or a card opens where the terminal's links do ("Open PR
  // and card links on the bench"); the menu beside the button is the other
  // place, one click away. Read at the press, so a setting changed while the
  // card is up is the one that counts.
  const goTo = (where?: Where) => { onGone(); onGoto(n.goto!, where); };
  const go = act.kind === "goto" ? () => goTo(VIEW_OF[n.goto!.kind] ? noteSurface(n.goto!.kind, benchLinks()) : undefined)
    : act.kind === "link" || act.kind === "app" ? () => { onGone(); void openNote(n.id); }
    : null;
  const viewName = n.goto ? VIEW_OF[n.goto.kind] : undefined;
  const label = (act.kind === "goto" || act.kind === "link") && act.target
    ? <>{act.label} · <span className="font-mono text-[11px]">{act.target}</span></> : act.kind === "gate" ? "" : act.label;
  const urgent = n.urgency === 2;
  const src = sourceOf(n);

  return (
    <MCard
      layout="position"
      compact
      // A fade, no slide and no spring: a card should not pull the eye off the work behind it.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.12 }}
      // Hovering holds it open: reaching for the ✕ or the link should not be a
      // race against the timer.
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={go ?? undefined}
      role={go ? "button" : undefined}
      className="flex flex-col gap-1.5"
      style={{
        width: 360,
        cursor: go ? "pointer" : "default",
        // See-through like the desktop's own popups (Omarchy background-alpha 0.7).
        background: "color-mix(in srgb, var(--bg2) 70%, transparent)",
        border: `1px solid ${urgent ? "color-mix(in srgb, var(--error) 70%, transparent)" : "var(--border)"}`,
        ...(urgent ? { boxShadow: "inset 3px 0 0 var(--error), 0 22px 48px -20px var(--shadow)" } : { boxShadow: "0 22px 48px -20px var(--shadow)" }),
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      <div className="flex items-center gap-2">
        <AppMark app={n.app} urgent={urgent} />
        <span className="text-[10.5px] font-semibold truncate" style={{ color: "var(--text2)", maxWidth: 170 }}>{sourceLabel(src) === src ? n.app : sourceLabel(src)}</span>
        {count > 1 && (
          <span className="text-[10px] font-semibold shrink-0 tabular-nums px-1 rounded" style={{ color: "var(--text2)", background: "var(--surface-2)" }}>×{count}</span>
        )}
        {n.test && (
          <span className="text-[10px] font-semibold shrink-0 px-1 rounded" style={{ color: "var(--text2)", background: "var(--surface-2)" }}>Test</span>
        )}
        <span className="text-[9.5px] shrink-0" style={{ color: "var(--text4)" }}>{ago(n.at)}</span>
        <span className="ml-auto flex items-center gap-0.5 shrink-0">
          {/* The rest of the message, on the card, without going to the bell for it. */}
          {(cut || open) && (
            <button className="agx-note-btn agx-note-icon" aria-expanded={open}
              aria-label={open ? "Show less" : "Show the whole message"} data-tip={open ? "Show less" : "Show the whole message"}
              onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
              <Chevron up={open} />
            </button>
          )}
          {/* "Not this app again", from the card that just interrupted. Undone from Settings ▸ Notifications ▸ Apps. */}
          {canMute(src) && !urgent && (
            <button className="agx-note-btn agx-note-icon" aria-label={`Mute ${sourceLabel(src)}`}
              data-tip={`Mute ${sourceLabel(src)}: its notes are not kept. Undo in Settings ▸ Notifications.`}
              onClick={(e) => { e.stopPropagation(); setMuted(src, true); }}>
              <MuteGlyph />
            </button>
          )}
          {/* Dismisses the card, not the record: it is still in the bell afterwards. */}
          <button type="button" className="agx-note-btn agx-note-icon" aria-label="Dismiss, it stays in the bell"
            data-tip="Dismiss, it stays in the bell" onClick={(e) => { e.stopPropagation(); onGone(); }}>
            <CloseIcon size={ICON.xs} />
          </button>
        </span>
      </div>

      <span className="text-[12px] font-semibold leading-snug" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>
        {n.summary || n.app}
      </span>
      {/* Three lines closed, so a chatty afternoon cannot paper over the thing
          you were reading — and all of it when you ask, scrolling inside the
          card rather than growing past the bottom of the screen. */}
      {n.body && (
        <span ref={bodyEl}
          className={open ? "agx-note-body agx-note-toast-open" : "agx-note-body agx-note-toast-body"}>{n.body}</span>
      )}
      {count > 1 && (
        <span className="text-[11px]" style={{ color: "var(--text3)" }}>+{count - 1} more from {sourceLabel(src) === src ? n.app : sourceLabel(src)} in the bell</span>
      )}

      <span className="flex items-center gap-2 flex-wrap">
        {/* A test hold holds nothing: Dismiss takes the card and does nothing else. */}
        {n.test && urgent && (
          <button className="agx-note-btn" onClick={(e) => { e.stopPropagation(); onGone(); }}>Dismiss</button>
        )}
        {act.kind === "gate" && gate && (
          <>
            <button className="agx-note-btn" style={{ background: "var(--primary)", color: "var(--on-primary, var(--bg))", borderColor: "transparent" }}
              onClick={(e) => { e.stopPropagation(); onGone(); void answerGate(gate, "allow"); }}>Allow</button>
            <button className="agx-note-btn" onClick={(e) => { e.stopPropagation(); onGone(); void answerGate(gate, "deny"); }}>Deny</button>
            <span className="text-[11px] ml-auto" style={{ color: "var(--text3)" }}>Stays until you answer</span>
          </>
        )}
        {/* The press the whole card already takes, said out loud, with where it lands. */}
        {go && !viewName && (
          <button className="agx-note-btn" onClick={(e) => { e.stopPropagation(); go(); }}>{label}</button>
        )}
        {/* One control, two places: the button goes where the setting says, the
            caret offers both. The wrapper stops the press here — the menu is a
            portal, and its clicks would otherwise bubble to the card's own. */}
        {go && n.goto && viewName && (
          <span className="agx-note-btn inline-flex items-stretch" style={{ padding: 0 }}
            onClick={(e) => e.stopPropagation()}>
            <button type="button" className="px-2 py-1" onClick={go}
              data-tip={noteSurfaceTip(n.goto.kind, benchLinks(), viewName)}
              onMouseOver={(e) => { e.currentTarget.dataset.tip = noteSurfaceTip(n.goto!.kind, benchLinks(), viewName); }}
              onFocus={(e) => { e.currentTarget.dataset.tip = noteSurfaceTip(n.goto!.kind, benchLinks(), viewName); }}>
              {label}
            </button>
            <Menu bare align="right" title="Choose where it opens" label={<Chevron up={false} size={ICON.xs} />}>
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); goTo("bench"); }}>Open on the bench</MenuItem>
                  <MenuItem onClick={() => { close(); goTo("view"); }}>Open in {viewName}</MenuItem>
                </>
              )}
            </Menu>
          </span>
        )}
        {act.kind === "app" && (
          <span className="text-[11px]" style={{ color: "var(--text3)" }}>The app, not the message</span>
        )}
        {act.kind === "none" && (
          <span className="text-[11px]" style={{ color: "var(--text3)" }}>{act.label}</span>
        )}
      </span>
    </MCard>
  );
}

/**
 * The stack itself: bottom-right of the window, over everything else.
 *
 * Not the top-right any more: the desktop's own popups hang from that corner,
 * and two decks in one corner is what a double popup looks like. A Portal
 * because the workspace clips its panes and a terminal in fullscreen would
 * otherwise slice the cards off. The layer is above the full-window sheets
 * (Settings, the catalog) and below the bell's own panel — see LAYER.noteToasts.
 * Newest nearest the corner.
 */
export function NoteToasts({ onGoto }: {
  onGoto: (g: Goto, where?: Where) => void;
}) {
  const [live, setLive] = useState<LiveCard[]>([]);
  // A card's React key is not the note's id. Ids are unique per server session,
  // but a reconnect restarts the counter, and two cards sharing a key collapse
  // into one under AnimatePresence. The note keeps its own id untouched, because
  // that is the handle the server answers `openNote` for.
  const seq = useRef(0);

  useEffect(() => subscribeSystemNotes((n) => {
    setLive((prev) => stackCard(prev, `${n.id}#${++seq.current}`, n, MAX));
  }), []);

  const drop = (key: string) => setLive((prev) => prev.filter((x) => x.key !== key));
  // Muting an app takes its cards off the screen with it, not only the next one.
  useEffect(() => subscribeMuted(() => {
    const m = mutedSources();
    setLive((prev) => prev.filter((x) => x.n.urgency === 2 || !m.has(sourceOf(x.n))));
  }), []);

  if (!live.length) return null;
  return (
    <Portal z={LAYER.noteToasts}>
      <div
        className="fixed flex flex-col-reverse items-end gap-2"
        style={{ bottom: 12, right: 12, pointerEvents: "none" }}
      >
        <AnimatePresence initial={false}>
          {live.map(({ key, n, count }) => (
            <div key={key} style={{ pointerEvents: "auto" }}>
              {/* Only the card goes; `dismissNote` (which drops it from the
                  bell's list too) is deliberately never called from here. */}
              <Toast n={n} count={count} onGone={() => drop(key)} onGoto={onGoto} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </Portal>
  );
}
