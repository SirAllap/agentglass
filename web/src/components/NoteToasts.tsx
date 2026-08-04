// Your machine's notifications, on top of the app that is covering your screen.
//
// The whole reason the mirror exists is that agentglass runs fullscreen: a Slack
// ping fires a banner you never see, because this app is what is in front of it.
// The server has read those off the D-Bus session bus for a while and the bell
// has listed them — but the only thing that *interrupted* was a line of 10px
// text in the middle of the top bar, which loses its slot to the "needs you"
// chip the moment anything is held, and which cannot carry a message anyway.
// "Slack — New message from Alejandro García" is two lines of prose, not a
// caption.
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
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { subscribeSystemNotes, openNote, type SystemNote } from "../lib/sysNotify.ts";
import { Chevron, useClipped } from "./TopBarNotes.tsx";
import { Portal } from "./Portal.tsx";
import { TOP_BAR_H } from "./TopBar.tsx";

/** How long an ordinary card holds the corner. Long enough to read two lines of
 *  someone else's message without hurrying, short enough that a busy minute does
 *  not bury the screen. */
const HOLD_MS = 7000;

/**
 * How many are on screen at once.
 *
 * Three, and the oldest leaves when a fourth arrives. A stack that grows without
 * limit turns a group chat into a wall over your terminal — and everything that
 * scrolls off is still in the bell, which is the surface built for "what did I
 * miss".
 */
const MAX = 3;

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

/** Just the host, so the button can say where it goes rather than showing a
 *  bare arrow that reads as "open Slack" — the one thing it cannot do. */
const hostOf = (url: string): string => {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return "link"; }
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
        width: 18, height: 18, color: tint,
        background: `color-mix(in srgb, ${tint} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
      }}
      aria-hidden
    >{letter}</span>
  );
}

function Card({ n, onGone, onGoto }: {
  n: SystemNote;
  onGone: () => void;
  onGoto: (g: NonNullable<SystemNote["goto"]>) => void;
}) {
  const [held, setHeld] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyEl = useRef<HTMLSpanElement>(null);
  // Whether three lines is showing everything. Measured rather than guessed
  // from the length, and measured once the card is actually in the document —
  // see useClipped, which exists because a Portal's children have no layout at
  // the moment their own effects run.
  const cut = useClipped([bodyEl], !open, [n.body]);

  // Urgent stays until it is dismissed. A sender marking a notification
  // critical is rare enough to be meant, and a five-second window is not how
  // you treat the one message that said it could not wait.
  //
  // So does one you have opened: expanding it is you saying you are reading it,
  // and a card that vanishes mid-sentence because its timer ran out is the
  // whole complaint about truncation with extra steps.
  useEffect(() => {
    if (held || open || n.urgency === 2) return;
    const id = setTimeout(onGone, HOLD_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, open, n.id]);

  const go = n.goto ? () => { onGone(); onGoto(n.goto!); } : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.97, transition: { duration: 0.16 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      // Hovering holds it open: reaching for the ✕ or the link should not be a
      // race against the timer.
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onClick={go ?? undefined}
      role={go ? "button" : undefined}
      className="flex flex-col gap-1.5 rounded-xl px-3 py-2.5"
      style={{
        width: 360,
        cursor: go ? "pointer" : "default",
        background: "color-mix(in srgb, var(--bg2) 96%, transparent)",
        border: `1px solid ${n.urgency === 2
          ? "color-mix(in srgb, var(--error) 45%, transparent)"
          : "var(--border)"}`,
        boxShadow: "0 22px 48px -20px var(--shadow)",
        backdropFilter: "blur(10px)",
      }}
    >
      <div className="flex items-center gap-2">
        <AppMark app={n.app} urgent={n.urgency === 2} />
        <span className="text-[10.5px] font-semibold truncate" style={{ color: "var(--text2)", maxWidth: 170 }}>{n.app}</span>
        <span className="text-[9.5px] shrink-0" style={{ color: "var(--text4)" }}>{ago(n.at)}</span>
        {n.urgency === 2 && (
          <span className="text-[9px] uppercase tracking-wider shrink-0" style={{ color: "var(--error)" }}>urgent</span>
        )}
        {/* The rest of the message, on the card, without going to the bell for
            it. Same control the bell's rows carry, so opening a notification is
            one gesture wherever you meet it. */}
        {(cut || open) && (
          <button className="agx-note-btn agx-note-icon ml-auto shrink-0" aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            title={open ? "Show less" : "Show the whole message"}>
            <Chevron up={open} />
          </button>
        )}
        {/* Dismisses the card, not the record: it is still in the bell
            afterwards, because closing a banner is "I have seen it", never
            "delete what happened". */}
        <button className={`agx-note-btn agx-note-icon shrink-0${cut || open ? "" : " ml-auto"}`}
          onClick={(e) => { e.stopPropagation(); onGone(); }}
          aria-label="Dismiss" title="Dismiss — it stays in the bell">✕</button>
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

      {n.url && (
        <button className="agx-note-link self-start" title={n.url}
          onClick={(e) => { e.stopPropagation(); void openNote(n.id); }}>
          ↗ Open {hostOf(n.url)}
        </button>
      )}
    </motion.div>
  );
}

/**
 * The stack itself: top-right, under the bar, over everything else.
 *
 * Under the bell on purpose — that is where these end up, so that is the
 * direction they should come from. A Portal because the workspace clips its
 * panes and a terminal in fullscreen would otherwise slice the cards off; the
 * z-index sits below the bell's own panel (10050) so opening the list never
 * fights with a banner for the same corner.
 */
export function NoteToasts({ onGoto }: {
  onGoto: (g: NonNullable<SystemNote["goto"]>) => void;
}) {
  const [live, setLive] = useState<{ key: string; n: SystemNote }[]>([]);
  // A card's React key is not the note's id. Ids are unique per server session,
  // but a reconnect restarts the counter, and two cards sharing a key collapse
  // into one under AnimatePresence. The note keeps its own id untouched, because
  // that is the handle the server answers `openNote` for.
  const seq = useRef(0);

  useEffect(() => subscribeSystemNotes((n) => {
    setLive((prev) => [{ key: `${n.id}#${++seq.current}`, n }, ...prev].slice(0, MAX));
  }), []);

  const drop = (key: string) => setLive((prev) => prev.filter((x) => x.key !== key));

  if (!live.length) return null;
  return (
    <Portal z={10040}>
      <div
        className="fixed flex flex-col items-end gap-2"
        style={{ top: TOP_BAR_H + 10, right: 12, pointerEvents: "none" }}
      >
        <AnimatePresence initial={false}>
          {live.map(({ key, n }) => (
            <div key={key} style={{ pointerEvents: "auto" }}>
              {/* Only the card goes; `dismissNote` (which drops it from the
                  bell's list too) is deliberately never called from here. */}
              <Card n={n} onGone={() => drop(key)} onGoto={onGoto} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </Portal>
  );
}
