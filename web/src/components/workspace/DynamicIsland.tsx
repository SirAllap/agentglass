import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, type UsagePayload } from "../../lib/api.ts";
import { subscribeUsage, usedColor, usageError, resetLabel } from "../UsageWidget.tsx";
import { subscribe as subscribeChats, listChats } from "../../lib/chatStore.ts";
import { subscribeSessions, liveSessionCount } from "../TerminalPanel.tsx";

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
 * frame it sits on (only the bottom corners are round), which is why it is
 * positioned at the frame's top rather than the screen's.
 *
 * pointer-events: none, all the way down, on purpose and inherited from its
 * predecessor: one of the five views under it is a real terminal, and a strip
 * that swallowed a click meant for the shell would be worse than no strip. It
 * is ambient information, never a control.
 */

// ---------------------------------------------------------------------------
// The clock. A one-second tick, in JS rather than a CSS animation, because the
// workspace sets data-ws="1" on <html> and that pauses every CSS ambient loop
// on the page (the dashboard's, animating unseen beneath us) -- a CSS-driven
// blink would be frozen along with them. A setInterval is not a CSS animation,
// so it keeps time. It also stops itself when the tab is hidden: nobody reads a
// clock they can't see, and the point of all this is to keep the CPU quiet.
// ---------------------------------------------------------------------------
function useClock(): { hh: string; mm: string; ss: string; ampm: string; colon: boolean } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(() => setNow(new Date()), 1000); };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVis = () => { if (document.visibilityState === "hidden") stop(); else { setNow(new Date()); start(); } };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  let h = now.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { hh: p2(h), mm: p2(now.getMinutes()), ss: p2(now.getSeconds()), ampm, colon: now.getSeconds() % 2 === 0 };
}

/**
 * An LCD readout, the ghost-segment kind: the lit digits sit over a faint
 * all-8s layer, so the "off" segments show through exactly like a cheap digital
 * watch. That ghost is the whole reason this reads as an LCD and not just a
 * monospace number -- see the reference. The phosphor glow is a text-shadow on
 * the lit layer alone.
 */
function Lcd({ hh, mm, ss, ampm, colon }: { hh: string; mm: string; ss: string; ampm: string; colon: boolean }) {
  return (
    <div className="agx-lcd flex items-end gap-[3px] leading-none select-none">
      <span className="relative inline-block text-[19px] tracking-[0.06em]">
        <span className="agx-lcd-ghost">88</span>
        <span className="agx-lcd-lit absolute inset-0">{hh}</span>
      </span>
      <span className="relative inline-block text-[19px] w-[7px] text-center" style={{ opacity: colon ? 1 : 0.18 }}>
        <span className="agx-lcd-ghost">:</span>
        <span className="agx-lcd-lit absolute inset-0">:</span>
      </span>
      <span className="relative inline-block text-[19px] tracking-[0.06em]">
        <span className="agx-lcd-ghost">88</span>
        <span className="agx-lcd-lit absolute inset-0">{mm}</span>
      </span>
      <span className="flex flex-col items-start gap-[1px] ml-[3px] mb-[1px]">
        <span className="agx-lcd-lit text-[7px] tracking-[0.12em] leading-none">{ampm}</span>
        <span className="relative inline-block text-[9px] tracking-[0.05em] leading-none">
          <span className="agx-lcd-ghost">88</span>
          <span className="agx-lcd-lit absolute inset-0">{ss}</span>
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The resting complications: a live-work pulse on the left, plan meters on the
// right. Both derive from stores the workspace already reads, so nothing here
// polls anything the app wasn't polling anyway.
// ---------------------------------------------------------------------------

/** A tiny ring, 5h / weekly. conic-gradient for the arc, a radial mask punches
 *  the hole -- no SVG, so it costs one element. */
function Ring({ tag, used }: { tag: string; used: number }) {
  const color = usedColor(used);
  return (
    <span className="flex items-center gap-1" title={`${tag}: ${used}% used`}>
      <span
        className="relative grid place-items-center"
        style={{
          width: 18, height: 18, borderRadius: "50%",
          background: `conic-gradient(${color} ${used * 3.6}deg, color-mix(in srgb, #fff 12%, transparent) 0deg)`,
        }}
      >
        <span className="absolute rounded-full" style={{ inset: 3, background: "#0b0b0d" }} />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[7px] uppercase tracking-[0.1em]" style={{ color: "color-mix(in srgb, #fff 45%, transparent)" }}>{tag}</span>
        <span className="text-[9px] font-semibold tabular-nums" style={{ color }}>{used}%</span>
      </span>
    </span>
  );
}

/** A count of live shells and waiting chats, as coloured pips. This is the
 *  left "avatar" slot of the reference -- but a status one: it says how much of
 *  the workspace is actually doing something right now. */
function Pulse({ shells, waiting }: { shells: number; waiting: number }) {
  if (!shells && !waiting) {
    return <span className="w-2 h-2 rounded-full" style={{ background: "color-mix(in srgb, var(--primary) 45%, transparent)" }} title="workspace idle" />;
  }
  return (
    <span className="flex items-center gap-1.5">
      {shells > 0 && (
        <span className="flex items-center gap-1" title={`${shells} live shell${shells === 1 ? "" : "s"}`}>
          <span className="agx-pip w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
          <span className="text-[10px] font-semibold tabular-nums" style={{ color: "var(--success)" }}>{shells}</span>
        </span>
      )}
      {waiting > 0 && (
        <span className="flex items-center gap-1" title={`${waiting} chat${waiting === 1 ? "" : "s"} waiting for you`}>
          <span className="agx-pip w-1.5 h-1.5 rounded-full" style={{ background: "var(--warning)" }} />
          <span className="text-[10px] font-semibold tabular-nums" style={{ color: "var(--warning)" }}>{waiting}</span>
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Notifications. A small queue: something worth surfacing arrives, the notch
// morphs open to show it for a few seconds, then morphs back. Persistent facts
// (chats waiting, a branch behind) live in the resting pips instead -- a toast
// is for the transition, the pip is for the standing state.
// ---------------------------------------------------------------------------
type NoteKind = "done" | "blocked" | "pull";
type Note = { id: string; kind: NoteKind; title: string; sub: string; color: string };

const NOTE_MS = 4800;

function NoteIcon({ kind }: { kind: NoteKind }) {
  const p = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "done") return <svg {...p}><path d="M4 12.5l5 5L20 6" /></svg>;
  if (kind === "blocked") return <svg {...p}><path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="9" /></svg>;
  return <svg {...p}><path d="M12 4v11M6 11l6 6 6-6" /><path d="M5 20h14" /></svg>; // pull: a download arrow
}

/**
 * Watch the stores the notch cares about and turn *transitions* into notes.
 *
 * Only transitions, never standing state: it seeds the last-seen maps on the
 * first pass without emitting, so opening the workspace with three already-
 * finished chats does not fire three stale toasts. Those show as the resting
 * pip; a toast means "this just happened, while you were looking away".
 */
function useNotes(): { note: Note | null; behind: number } {
  const [note, setNote] = useState<Note | null>(null);
  const [behind, setBehind] = useState(0);
  const queue = useRef<Note[]>([]);
  const showing = useRef(false);

  const push = (n: Note) => {
    queue.current.push(n);
    if (!showing.current) advance();
  };
  const advance = () => {
    const next = queue.current.shift();
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
          push({ id: `${c.id}-b-${c.messages.length}`, kind: "blocked", color: "var(--error)", title: c.title || "chat", sub: c.blockedTool ? `needs "${c.blockedTool}"` : "waiting on you" });
        } else if (c.attention === "done") {
          push({ id: `${c.id}-d-${c.messages.length}`, kind: "done", color: "var(--success)", title: c.title || "chat", sub: "turn finished" });
        }
      }
      first = false;
    };
    read();
    return subscribeChats(read);
  }, []);

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
        for (const r of repos) {
          total += r.behind;
          const prev = seen.get(r.root) ?? 0;
          seen.set(r.root, r.behind);
          if (!first && r.behind > prev) {
            push({ id: `${r.root}-${r.behind}`, kind: "pull", color: "var(--info)", title: r.name, sub: `${r.behind} to pull on ${r.branch}` });
          }
        }
        setBehind(total);
        first = false;
      } catch { /* offline or no repos -- the pip just stays put */ }
    };
    void poll();
    const id = setInterval(poll, 90_000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  return { note, behind };
}

// ---------------------------------------------------------------------------

export function DynamicIsland() {
  const clock = useClock();
  const { note, behind } = useNotes();

  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);
  const waiting = useSyncExternalStore(subscribeChats, () => listChats().reduce((n, c) => n + (c.attention !== "none" ? 1 : 0), 0), () => 0);

  const [u, setU] = useState<UsagePayload | null>(null);
  useEffect(() => subscribeUsage(setU), []);
  const rateLimited = !u?.available && usageError()?.includes("429");

  return (
    // Fixed at the frame's top edge, not the screen's: the workspace sits at
    // 95vh centred, so ~2.5vh of scrim shows above it, and the notch reads as
    // hanging off the frame rather than the window.
    <div className="fixed left-1/2 -translate-x-1/2 pointer-events-none" style={{ top: "2.5vh", zIndex: 10002 }}>
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 480, damping: 34, mass: 0.7 }}
        className="agx-notch flex items-center overflow-hidden"
        style={{ borderRadius: note ? "20px" : "0 0 20px 20px" }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {note ? (
            <motion.div
              key={note.id}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.16 }}
              className="flex items-center gap-2.5 px-4 py-2"
              style={{ minWidth: 260 }}
            >
              <span
                className="grid place-items-center rounded-full shrink-0"
                style={{ width: 26, height: 26, color: note.color, background: `color-mix(in srgb, ${note.color} 18%, transparent)` }}
              >
                <NoteIcon kind={note.kind} />
              </span>
              <span className="flex flex-col leading-tight min-w-0">
                <span className="text-[12px] font-semibold truncate" style={{ color: "#f4f4f6", maxWidth: 220 }}>{note.title}</span>
                <span className="text-[10px] truncate" style={{ color: note.color, maxWidth: 220 }}>{note.sub}</span>
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="rest"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="flex items-center gap-3 px-3.5 h-[34px]"
            >
              {/* left: live-work pulse, plus a standing "behind" chip when a
                  branch has fallen behind its upstream. */}
              <Pulse shells={shells} waiting={waiting} />
              {behind > 0 && (
                <span className="flex items-center gap-1" title={`${behind} commit${behind === 1 ? "" : "s"} to pull`}>
                  <span style={{ color: "var(--info)" }}><NoteIcon kind="pull" /></span>
                  <span className="text-[10px] font-semibold tabular-nums" style={{ color: "var(--info)" }}>{behind}</span>
                </span>
              )}

              <span className="w-px h-4" style={{ background: "color-mix(in srgb, #fff 12%, transparent)" }} />

              {/* centre: the clock */}
              <Lcd {...clock} />

              {/* right: plan meters, or a rate-limit note when the upstream is
                  throttling us -- the meters vanishing looks like a bug. */}
              {u?.available ? (
                <>
                  <span className="w-px h-4" style={{ background: "color-mix(in srgb, #fff 12%, transparent)" }} />
                  {u.five_hour && <Ring tag="5h" used={u.five_hour.utilization} />}
                  {u.seven_day && <Ring tag="wk" used={u.seven_day.utilization} />}
                </>
              ) : rateLimited ? (
                <>
                  <span className="w-px h-4" style={{ background: "color-mix(in srgb, #fff 12%, transparent)" }} />
                  <span className="text-[9px]" style={{ color: "color-mix(in srgb, #fff 50%, transparent)" }}>usage rate-limited</span>
                </>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
