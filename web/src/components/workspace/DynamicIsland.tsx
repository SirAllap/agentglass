import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, type UsagePayload, type UsageWindow } from "../../lib/api.ts";
import { subscribeUsage, usedColor, usageError, resetLabel } from "../UsageWidget.tsx";
import { subscribe as subscribeChats, listChats } from "../../lib/chatStore.ts";
import { subscribeSessions, liveSessionCount } from "../TerminalPanel.tsx";
import { clock24, subscribeClock24 } from "../../lib/clockPref.ts";
import { subscribeGitChanged } from "../../lib/gitBus.ts";
import { subscribeNewGates } from "../../lib/gateStore.ts";
import { enqueue, dequeue } from "../../lib/toastQueue.ts";
import {
  subscribeSystemNotes, subscribeNotifyHistory, notifyHistory, notifyUnread,
  markNotifyRead, dismissNote, clearNotes, openNote, recordNote,
  notifyQuiet, setNotifyQuiet, subscribeNotifyQuiet, type SystemNote,
} from "../../lib/sysNotify.ts";

/**
 * The workspace's dynamic island.
 *
 * It supersedes the old terminal-only UsageIsland. Two things changed with it:
 * it now hangs over *every* view (the workspace is one overlay, so a strip that
 * only made sense over the terminal made no sense being torn down when you
 * switched to the diff), and it does more than meter the plan. It is the
 * workspace's one ambient status surface: a clock, the plan meters, a pulse of
 * how much is live, and a place for the events worth looking up from your work
 * for -- a chat that finished, a chat stuck on a refusal, a branch that has
 * fallen behind its upstream.
 *
 * A notch, not a floating pill. It reads as carved from the top edge of the
 * screen (only the bottom corners are round), which is why it is welded to the
 * viewport's top rather than to the frame beneath it.
 *
 * It does not overlap that frame. The workspace reserves NOTCH_BAND at the top
 * of the viewport and starts below it, so the strip sits in clear black air
 * with the frame's rounded corner beginning underneath. Everything that used to
 * follow from overlapping -- covering a view's header, swallowing a click meant
 * for the shell -- stops being a problem rather than being worked around.
 *
 * Every reading is captioned. A bare "1" next to a green dot and a bare "551"
 * next to an arrow are two numbers you have to remember the meaning of; SHELLS
 * over the 1 and TO PULL over the 551 are two you can read.
 */

/** Height reserved at the top of the viewport for the notch, gap included.
 *  Workspace pads itself by this, which is what makes the overlap zero. */
export const NOTCH_BAND = 48;

const NOTCH_H = 40;

// ---------------------------------------------------------------------------
// The clock. A one-second tick, in JS rather than a CSS animation, because the
// workspace sets data-ws="1" on <html> and that pauses every CSS ambient loop
// on the page (the dashboard's, animating unseen beneath us) -- a CSS-driven
// blink would be frozen along with them. A setInterval is not a CSS animation,
// so it keeps time. It also stops itself when the tab is hidden: nobody reads a
// clock they can't see, and the point of all this is to keep the CPU quiet.
// ---------------------------------------------------------------------------
function useClock(): { hhmm: string; ampm: string; colon: boolean; label: string } {
  const [now, setNow] = useState(() => new Date());
  const h24 = useSyncExternalStore(subscribeClock24, clock24, () => false);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(() => setNow(new Date()), 1000); };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVis = () => { if (document.visibilityState === "hidden") stop(); else { setNow(new Date()); start(); } };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const raw = now.getHours();
  // On 24h the meridiem has nothing to say, and an empty caption would leave
  // the clock the only pill without a top line. The seconds take the slot —
  // the one reading the strip doesn't show anywhere else.
  const h = h24 ? raw : raw % 12 || 12;
  return {
    hhmm: `${p2(h)}:${p2(now.getMinutes())}`,
    ampm: h24 ? p2(now.getSeconds()) : raw >= 12 ? "PM" : "AM",
    colon: now.getSeconds() % 2 === 0,
    label: now.toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
}

// ---------------------------------------------------------------------------
// Seven-segment digits.
//
// Not a monospace font with tabular numerals -- actual segments, mitred at the
// ends with a gap at every corner, drawn over a ghost layer of the segments
// that are off. That ghost is the whole tell of a real LCD: on a cheap alarm
// clock you can always see the unlit bars of the 8 behind whatever digit is
// showing. Geometry is computed once at module scope; a digit is seven
// polygons and costs nothing to re-render.
// ---------------------------------------------------------------------------
const DW = 92, DH = 168, SEG_T = 18, SEG_S = 3.5, SEG_GAP = 15, COLON_W = 32;

/** A horizontal bar: flat top and bottom, mitred to a point at each end. */
const hSeg = (y: number) => [
  [SEG_T / 2 + SEG_S, y + SEG_T / 2], [SEG_T + SEG_S, y], [DW - SEG_T - SEG_S, y],
  [DW - SEG_T / 2 - SEG_S, y + SEG_T / 2], [DW - SEG_T - SEG_S, y + SEG_T], [SEG_T + SEG_S, y + SEG_T],
].map((p) => p.join(",")).join(" ");

/** A vertical bar, same treatment turned ninety degrees. */
const vSeg = (x: number, ya: number, yb: number) => [
  [x + SEG_T / 2, ya + SEG_T / 2 + SEG_S], [x + SEG_T, ya + SEG_T + SEG_S], [x + SEG_T, yb - SEG_T - SEG_S],
  [x + SEG_T / 2, yb - SEG_T / 2 - SEG_S], [x, yb - SEG_T - SEG_S], [x, ya + SEG_T + SEG_S],
].map((p) => p.join(",")).join(" ");

const SEG: Record<string, string> = {
  a: hSeg(0), g: hSeg((DH - SEG_T) / 2), d: hSeg(DH - SEG_T),
  f: vSeg(0, 0, DH / 2), b: vSeg(DW - SEG_T, 0, DH / 2),
  e: vSeg(0, DH / 2, DH), c: vSeg(DW - SEG_T, DH / 2, DH),
};
const SEG_KEYS = ["a", "b", "c", "d", "e", "f", "g"] as const;
const LIT: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

function Lcd({ text, height, blink }: { text: string; height: number; blink: boolean }) {
  const parts: JSX.Element[] = [];
  let x = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ":") {
      parts.push(
        <g key={i} style={{ opacity: blink ? 1 : 0.16 }}>
          <circle className="agx-seg on" cx={x + COLON_W / 2} cy={DH * 0.33} r={8.5} />
          <circle className="agx-seg on" cx={x + COLON_W / 2} cy={DH * 0.67} r={8.5} />
        </g>,
      );
      x += COLON_W + SEG_GAP;
      continue;
    }
    const lit = LIT[ch] ?? "";
    parts.push(
      <g key={i} transform={`translate(${x},0)`}>
        {SEG_KEYS.map((k) => (
          <polygon key={k} points={SEG[k]} className={lit.includes(k) ? "agx-seg on" : "agx-seg"} />
        ))}
      </g>,
    );
    x += DW + SEG_GAP;
  }
  const w = x - SEG_GAP;
  return (
    <svg className="agx-lcd" viewBox={`0 0 ${w} ${DH}`} height={height} width={(w / DH) * height} aria-hidden="true">
      {parts}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The resting complications. Each one is a pill: a caption naming the reading,
// the reading under it. Nothing on the strip is a number on its own.
// ---------------------------------------------------------------------------

function Pill({ cap, title, children }: { cap: string; title?: string; children: React.ReactNode }) {
  return (
    <span className="agx-pill" title={title}>
      <span className="agx-cap">{cap}</span>
      <span className="flex items-center gap-1.5 leading-none">{children}</span>
    </span>
  );
}

/** A plan window: how much is gone, as a bar and a number, captioned with when
 *  it comes back. "62%" alone never answered the question you actually have. */
function MeterPill({ tag, w }: { tag: string; w: UsageWindow }) {
  const color = usedColor(w.utilization);
  const reset = resetLabel(w.resets_at);
  return (
    <Pill
      cap={reset ? `${tag} · ${reset}` : tag}
      title={`${tag}: ${w.utilization}% used${reset ? ` — resets ${reset}` : ""}`}
    >
      <span className="agx-bar" style={{ width: 38 }}>
        <i style={{ width: `${Math.min(100, Math.max(0, w.utilization))}%`, background: color }} />
      </span>
      <span className="agx-val" style={{ color }}>{w.utilization}%</span>
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Notifications. A small queue: something worth surfacing arrives, the notch
// morphs open to show it for a few seconds, then morphs back. Persistent facts
// (chats waiting, a branch behind) live in the resting pills instead -- a toast
// is for the transition, the pill is for the standing state.
// ---------------------------------------------------------------------------
type NoteKind = "done" | "blocked" | "pull" | "system";
type Note = {
  id: string; kind: NoteKind; title: string; sub: string; color: string; app?: string;
  /** When it was queued. The lane drops what went stale waiting; see toastQueue.ts. */
  at: number;
  /** Something is blocked until you answer. Jumps the queue, never dropped. */
  urgent?: boolean;
};

const NOTE_MS = 4800;

function NoteIcon({ kind }: { kind: NoteKind }) {
  const p = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "done") return <svg {...p}><path d="M4 12.5l5 5L20 6" /></svg>;
  if (kind === "blocked") return <svg {...p}><path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="9" /></svg>;
  if (kind === "system") return <svg {...p}><path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" /><path d="M10.5 20a2 2 0 0 0 3 0" /></svg>; // a bell
  return <svg {...p}><path d="M12 4v11M6 11l6 6 6-6" /><path d="M4.5 20h15" /></svg>; // pull: a download arrow
}

/** Commits going the other way — the mirror of the pull arrow. */
function PushIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20V9M6 13l6-6 6 6" /><path d="M4.5 4h15" />
    </svg>
  );
}

/** A chat waiting on you. Its own glyph rather than a coloured dot, so the
 *  three left-hand pills are told apart by shape and not only by hue. */
function ChatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/**
 * Watch the stores the notch cares about and turn *transitions* into notes.
 *
 * Only transitions, never standing state: it seeds the last-seen maps on the
 * first pass without emitting, so opening the workspace with three already-
 * finished chats does not fire three stale toasts. Those show as the resting
 * pill; a toast means "this just happened, while you were looking away".
 */
function useNotes(): { note: Note | null; behind: number; ahead: number } {
  const [note, setNote] = useState<Note | null>(null);
  const [behind, setBehind] = useState(0);
  /** Commits that exist only on this machine. */
  const [ahead, setAhead] = useState(0);
  const queue = useRef<Note[]>([]);
  const showing = useRef(false);

  /** Callers describe the note; the lane stamps when it arrived. */
  const push = (n: Omit<Note, "at">) => {
    enqueue(queue.current, { ...n, at: Date.now() });
    if (!showing.current) advance();
  };
  const advance = () => {
    const next = dequeue(queue.current, Date.now());
    if (!next) { showing.current = false; setNote(null); return; }
    showing.current = true;
    setNote(next);
    setTimeout(() => advance(), NOTE_MS);
  };

  // Chat transitions: none -> done / blocked.
  useEffect(() => {
    const seen = new Map<string, string>();
    let first = true;
    const read = () => {
      for (const c of listChats()) {
        const prev = seen.get(c.id) ?? "none";
        seen.set(c.id, c.attention);
        if (first || c.attention === prev || c.attention === "none") continue;
        if (c.attention === "blocked") {
          // Blocked, not merely finished: the chat cannot continue without you.
          push({ id: `${c.id}-b-${c.messages.length}`, kind: "blocked", color: "var(--error)", title: c.title || "chat", sub: c.blockedTool ? `needs "${c.blockedTool}"` : "waiting on you", urgent: true });
          recordNote({ app: "chat", summary: c.title || "chat", body: c.blockedTool ? `blocked — needs "${c.blockedTool}"` : "blocked — waiting on you", urgency: 2 });
        } else if (c.attention === "done") {
          push({ id: `${c.id}-d-${c.messages.length}`, kind: "done", color: "var(--success)", title: c.title || "chat", sub: "turn finished" });
          recordNote({ app: "chat", summary: c.title || "chat", body: "turn finished" });
        }
      }
      first = false;
    };
    read();
    return subscribeChats(read);
  }, []);

  // A tool call held at the gate. The most interrupting thing the notch shows,
  // because an agent is stopped until it is answered, and unlike everything
  // else here it cannot be caught up on later: the hold expires on its own.
  //
  // The store raises the history entry; this is only the toast. The Approve
  // buttons live on the dashboard's "What needs you", so the toast names the
  // tool and points there rather than pretending to be actionable itself.
  useEffect(() => subscribeNewGates((g) => {
    push({
      id: `gate-${g.id}`,
      kind: "blocked",
      color: "var(--warning)",
      title: `Approve ${g.tool_name}?`,
      sub: `${g.source_app}:${g.session_id.slice(0, 8)} is waiting on you`,
      // Ahead of the chatter, and never dropped for being late: the hold is
      // still holding. This is what keeps #138 working during a burst.
      urgent: true,
    });
  }), []);

  // Desktop notifications, read off the D-Bus session bus by the server and
  // mirrored here. They share the lane with agentglass's own events on
  // purpose: from where you are sitting, "a teammate replied" and "the chat
  // finished" are the same kind of interruption, and giving each its own
  // surface would mean watching two places instead of one.
  //
  // Only while the setting is on -- with it off the socket is never opened, so
  // the server never even starts watching. An unsupported platform simply
  // never delivers anything and nothing here needs to know.
  useEffect(() => subscribeSystemNotes((n) => {
    push({
      id: n.id,
      kind: "system",
      color: n.urgency === 2 ? "var(--error)" : "var(--primary)",
      title: n.summary || n.app,
      sub: n.body || n.app,
      app: n.app,
      // A sender marked it critical. Rare from third-party apps, and the one
      // signal we have that it is not chatter.
      urgent: n.urgency === 2,
    });
  }), []);

  // Branches falling behind their upstream -- "main has changes to pull". Its
  // own poll, deliberately slow: this moves on the scale of someone pushing to
  // a remote, not of anything the user is doing, so a minute and a half of
  // staleness costs nothing and keeps the request rare.
  useEffect(() => {
    const seen = new Map<string, number>();
    let first = true;
    let dead = false;
    const poll = async () => {
      try {
        const { repos } = await api.gitRepos();
        if (dead) return;
        let total = 0;
        let mine = 0;
        for (const r of repos) {
          total += r.behind;
          mine += r.ahead;
          const prev = seen.get(r.root) ?? 0;
          seen.set(r.root, r.behind);
          if (!first && r.behind > prev) {
            push({ id: `${r.root}-${r.behind}`, kind: "pull", color: "var(--info)", title: r.name, sub: `${r.behind} to pull on ${r.branch}` });
            recordNote({ app: "git", summary: r.name, body: `${r.behind} commit${r.behind === 1 ? "" : "s"} to pull on ${r.branch}` });
          }
        }
        setBehind(total);
        setAhead(mine);
        first = false;
      } catch { /* offline or no repos -- the pill just stays put */ }
    };
    void poll();
    const id = setInterval(poll, 90_000);
    // 90s is right for "someone else pushed", and far too slow for "you just
    // pulled" — the strip went on advertising commits you had already taken
    // until the workspace was closed and opened again. The server says when a
    // repo moved, so read it then too.
    const off = subscribeGitChanged(() => { void poll(); });
    return () => { dead = true; clearInterval(id); off(); };
  }, []);

  return { note, behind, ahead };
}

// ---------------------------------------------------------------------------
// The inbox: what the notch was showing before you looked up.
// ---------------------------------------------------------------------------

/** Just the host, so the button can say where it goes without wrapping. */
const hostOf = (url: string): string => {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return "link"; }
};

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

function HistoryRow({ n, onGone }: { n: SystemNote; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const long = n.body.length > 90 || n.body.includes("\n");
  return (
    <div className="agx-note-row">
      <div className="flex items-start gap-2">
        <span className="flex flex-col min-w-0 flex-1 gap-[3px]">
          <span className="flex items-center gap-2">
            <span className="agx-cap">{n.app}</span>
            <span className="agx-cap" style={{ opacity: 0.55 }}>{ago(n.at)}</span>
            {n.urgency === 2 && <span className="agx-cap" style={{ color: "var(--error)" }}>urgent</span>}
          </span>
          <span className="text-[11.5px] font-semibold truncate" style={{ color: "#f4f4f6" }}>{n.summary}</span>
          {/* Wraps, never widens. A nowrap line contributes its whole length to
              the container's max-content width, which is what let one long
              Slack message stretch the strip across the screen. Clamped to two
              lines closed, unclamped open -- so expanding grows downward. */}
          {n.body && (
            <span
              className={open ? "agx-note-body" : "agx-note-body agx-note-body-clamp"}
            >{n.body}</span>
          )}
          {/* Named, not a bare arrow. An unlabelled ↗ next to a Slack
              notification reads as "go to Slack", which is the one thing it
              cannot do -- what it actually opens is the link inside the
              message. Saying the host out loud makes the button honest. */}
          {n.url && (
            <button
              className="agx-note-link self-start"
              onClick={() => void openNote(n.id)}
              title={n.url}
            >
              ↗ open {hostOf(n.url)}
            </button>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {long && (
            <button className="agx-note-btn" onClick={() => setOpen((v) => !v)}
              title={open ? "collapse" : "show the whole message"}>{open ? "▴" : "▾"}</button>
          )}
          <button className="agx-note-btn" onClick={onGone} title="dismiss">✕</button>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DynamicIsland() {
  const clock = useClock();
  const { note, behind, ahead } = useNotes();

  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);
  const waiting = useSyncExternalStore(subscribeChats, () => listChats().reduce((n, c) => n + (c.attention !== "none" ? 1 : 0), 0), () => 0);

  const [u, setU] = useState<UsagePayload | null>(null);
  useEffect(() => subscribeUsage(setU), []);
  const rateLimited = !u?.available && usageError()?.includes("429");

  const anyLive = shells > 0 || waiting > 0 || behind > 0 || ahead > 0;

  // The inbox behind the strip. Clicking the notch opens it, which is also
  // what finally gives the notch a reason to take a click at all.
  const [inbox, setInbox] = useState(false);
  const hist = useSyncExternalStore(subscribeNotifyHistory, notifyHistory, notifyHistory);
  const unread = useSyncExternalStore(subscribeNotifyHistory, notifyUnread, () => 0);
  const quiet = useSyncExternalStore(subscribeNotifyQuiet, notifyQuiet, () => false);
  useEffect(() => { if (inbox) markNotifyRead(); }, [inbox, hist]);
  useEffect(() => {
    if (!inbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setInbox(false); } };
    // Capture, so Escape closes the inbox before the workspace sees it and
    // closes itself -- one Escape should undo one thing.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inbox]);

  return (
    // Welded to the very top edge of the screen, not the modal's. It is a
    // property of the window, not of the frame beneath it -- it hangs off the
    // top of the display the way a notch does, and the workspace keeps clear of
    // it rather than the other way round.
    //
    // Nothing veils the band it sits in. A black strip across the top read as
    // one more bar of chrome, which is the opposite of what a notch is: the
    // backdrop alone is the ground, and the strip is the only object in it.
    <div className="fixed top-0 left-1/2 -translate-x-1/2 pointer-events-none" style={{ zIndex: 10002 }}>
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.7 }}
        // pointer-events: auto, and only here -- the wrapper above stays
        // none. The strip therefore eats its own clicks instead of letting
        // them fall through to the backdrop, which is what used to dismiss the
        // whole workspace when you clicked the clock. Nothing is under it any
        // more (the frame starts below), so nothing loses a click to it either.
        // flex-col, and the inbox lives INSIDE this element rather than under
        // it. Two stacked boxes -- each with its own border, its own width and
        // a seam where they met -- read as a panel appearing beneath a strip,
        // however well the reveal was animated. One box that gets taller reads
        // as the strip itself opening, which is the whole idea of a notch.
        // `layout` then morphs the size with transforms rather than reflow.
        className="agx-notch flex flex-col overflow-hidden pointer-events-auto"
        style={{
          borderRadius: "0 0 20px 20px",
          minWidth: inbox ? 420 : undefined,
          cursor: hist.length ? "pointer" : "default",
        }}
        onClick={(e) => { e.stopPropagation(); if (hist.length) setInbox((v) => !v); }}
        // Only while closed: once the panel is open the tooltip floats over
        // the list, labelling something you are already looking at.
        title={hist.length && !inbox ? "notifications" : undefined}
      >
        {/* A wipe, not a fade. The content sweeps in from one side and, when its
            few seconds are up, sweeps out the same way -- a barrido that reads
            as the notch "turning over" what it shows rather than swapping it. */}
        <AnimatePresence mode="wait" initial={false}>
          {note ? (
            <motion.div
              key={note.id}
              initial={{ clipPath: "inset(0 100% 0 0)" }}
              animate={{ clipPath: "inset(0 0% 0 0)" }}
              exit={{ clipPath: "inset(0 0 0 100%)" }}
              layout="position"
              transition={{ duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
              className="flex items-center justify-center gap-2.5 px-3.5 shrink-0 w-full"
              style={{ height: NOTCH_H }}
            >
              <span
                className="grid place-items-center rounded-full shrink-0"
                style={{ width: 21, height: 21, color: note.color, background: `color-mix(in srgb, ${note.color} 18%, transparent)` }}
              >
                <NoteIcon kind={note.kind} />
              </span>
              <span className="flex flex-col leading-none gap-[3px] min-w-0">
                <span className="text-[12px] font-semibold truncate" style={{ color: "#f4f4f6", maxWidth: 280 }}>{note.title}</span>
                <span className="text-[10px] truncate" style={{ color: note.color, maxWidth: 280 }}>{note.sub}</span>
              </span>
              {/* Which app it came from. Only for the mirrored ones: on our own
                  events it would say "agentglass" to someone already looking
                  at agentglass. */}
              {note.kind === "system" && note.app && (
                <span className="agx-cap shrink-0 pl-1">{note.app}</span>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="rest"
              initial={{ clipPath: "inset(0 0 0 100%)" }}
              animate={{ clipPath: "inset(0 0% 0 0)" }}
              exit={{ clipPath: "inset(0 100% 0 0)" }}
              transition={{ duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
              // Centred and full width: once the inbox widens the strip, a
              // left-aligned readout would drift away from under the clock.
              className="flex items-center justify-center gap-[7px] px-[11px] shrink-0 w-full"
              style={{ height: NOTCH_H }}
            >
              {/* left: what is actually happening right now. Each pill leaves
                  entirely when its count is zero -- an idle workspace should
                  not spend width telling you three things are not happening. */}
              {shells > 0 && (
                <Pill cap="SHELLS" title={`${shells} terminal session${shells === 1 ? "" : "s"} running in this workspace`}>
                  <span className="agx-pip w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
                  <span className="agx-val" style={{ color: "var(--success)" }}>{shells}</span>
                </Pill>
              )}
              {waiting > 0 && (
                <Pill cap="WAITING" title={`${waiting} chat${waiting === 1 ? "" : "s"} finished or waiting on you`}>
                  <span style={{ color: "var(--warning)", display: "flex" }}><ChatIcon /></span>
                  <span className="agx-val" style={{ color: "var(--warning)" }}>{waiting}</span>
                </Pill>
              )}
              {/* Work that exists only here. It had no indicator at all: a
                  branch you have committed to and not pushed looked exactly
                  like one with nothing outstanding, and that is the state
                  where losing a laptop costs you the work. */}
              {ahead > 0 && (
                <Pill cap="TO PUSH" title={`${ahead} commit${ahead === 1 ? "" : "s"} committed here and not pushed anywhere`}>
                  <span style={{ color: "var(--success)", display: "flex" }}><PushIcon /></span>
                  <span className="agx-val" style={{ color: "var(--success)" }}>{ahead}</span>
                </Pill>
              )}
              {behind > 0 && (
                <Pill cap="TO PULL" title={`${behind} commit${behind === 1 ? "" : "s"} on the upstream you have not pulled`}>
                  <span style={{ color: "var(--info)", display: "flex" }}><NoteIcon kind="pull" /></span>
                  <span className="agx-val" style={{ color: "var(--info)" }}>{behind}</span>
                </Pill>
              )}

              {/* Unread desktop notifications. A count rather than a dot: "3
                  waiting" and "one, ages ago" are different situations. */}
              {unread > 0 && (
                <Pill cap="INBOX" title={`${unread} notification${unread === 1 ? "" : "s"} since you last looked`}>
                  <span style={{ color: "var(--primary)", display: "flex" }}><NoteIcon kind="system" /></span>
                  <span className="agx-val" style={{ color: "var(--primary)" }}>{unread}</span>
                </Pill>
              )}

              {(anyLive || unread > 0) && <span className="agx-sep" />}

              {/* centre: the clock, captioned with the meridiem the way the
                  reference alarm clock captions it. */}
              <Pill cap={clock.ampm} title={clock.label}>
                <Lcd text={clock.hhmm} height={20} blink={clock.colon} />
              </Pill>

              {/* right: the plan windows, or a rate-limit note when the upstream
                  is throttling us -- the meters vanishing looks like a bug. */}
              {u?.available ? (
                <>
                  <span className="agx-sep" />
                  {u.five_hour && <MeterPill tag="5H" w={u.five_hour} />}
                  {u.seven_day && <MeterPill tag="WEEK" w={u.seven_day} />}
                </>
              ) : rateLimited ? (
                <>
                  <span className="agx-sep" />
                  <Pill cap="PLAN" title="the usage endpoint is rate-limiting us; retrying">
                    <span className="text-[10px]" style={{ color: "color-mix(in srgb, #fff 55%, transparent)" }}>rate-limited</span>
                  </Pill>
                </>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inside the strip, and mounted plainly -- no AnimatePresence.
            An exit animation was what made closing lurch: the list stayed
            mounted at full height while its own animation played, holding the
            strip tall, and only then did the height snap back. Unmounting at
            once lets the container's `layout` spring carry the whole close, and
            overflow:hidden means you never see the content go. */}
        {inbox && (
          <motion.div
            layout="position"
            className="agx-inbox-body"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3 pt-1 pb-1.5">
              <span className="agx-cap">NOTIFICATIONS</span>
              <span className="agx-cap" style={{ opacity: 0.5 }}>{hist.length}</span>
              {/* Silencing without saying so is how you end up asking why you
                  were never told. It is also the switch, so the place that
                  reveals the state is the place that undoes it. */}
              <button
                className="agx-note-btn"
                onClick={() => setNotifyQuiet(!quiet)}
                title={quiet
                  ? "Mirrored notifications are quiet — they still collect here. Click to let them interrupt again."
                  : "Quiet mirrored notifications: keep collecting them, stop letting them interrupt"}
                style={quiet ? { color: "var(--warning)" } : undefined}
              >
                {quiet ? "quiet on" : "quiet"}
              </button>
              <button className="agx-note-btn ml-auto" onClick={() => { clearNotes(); setInbox(false); }}>clear all</button>
              <button className="agx-note-btn" onClick={() => setInbox(false)} title="close (Esc)">✕</button>
            </div>
            <div className="agx-inbox-list">
              {hist.map((n) => (
                <HistoryRow key={n.id} n={n} onGone={() => dismissNote(n.id)} />
              ))}
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
