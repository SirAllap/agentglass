// What the notch used to say, in the bar that replaced it.
//
// The shell rethink built TopBar and gave it the notch's clock, its plan meters
// and its live counts. The rest stayed behind in DynamicIsland — and nothing
// mounted DynamicIsland any more, so it went quiet without anything reporting a
// fault. The stores never noticed either: sysNotify.ts opens its socket on the
// preference alone, so every mirrored desktop notification since then landed in
// a history with no window onto it, and Settings went on offering to configure a
// feature that no longer had a surface.
//
// So this is that surface, in two halves, because they answer two questions:
//
//   the LANE — one toast in the middle of the bar — answers "what just
//   happened", for the moment you look up from your work.
//
//   the BELL — a count, and the list behind it — answers "what did I miss",
//   whenever you choose to ask. Everything the lane shows is in the list too, so
//   a toast you never saw costs you nothing.
//
// Both live in the strip rather than in a view, deliberately. The complaint this
// came out of was being pulled away from the terminal to find out what wanted
// you; a surface welded to the top of the window is one you can read without
// going anywhere.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../lib/api.ts";
import { subscribe as subscribeChats, listChats } from "../lib/chatStore.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { subscribeNewGates } from "../lib/gateStore.ts";
import { enqueue, dequeue } from "../lib/toastQueue.ts";
import {
  subscribeSystemNotes, subscribeNotifyHistory, notifyHistory, notifyUnread,
  markNotifyRead, dismissNote, clearNotes, openNote, recordNote,
  notifyQuiet, setNotifyQuiet, subscribeNotifyQuiet, type SystemNote,
} from "../lib/sysNotify.ts";
import { Portal } from "./Portal.tsx";

export type NoteKind = "done" | "blocked" | "pull" | "system";
export type Note = {
  id: string; kind: NoteKind; title: string; sub: string; color: string; app?: string;
  /** When it was queued. The lane drops what went stale waiting; see toastQueue.ts. */
  at: number;
  /** Something is blocked until you answer. Jumps the queue, never dropped. */
  urgent?: boolean;
};

/** How long one toast holds the middle of the bar. */
const NOTE_MS = 4800;

// ---------------------------------------------------------------------------
// Glyphs. Told apart by shape and not only by hue, so the lane still reads for
// someone who cannot tell the green from the amber.
// ---------------------------------------------------------------------------

function NoteIcon({ kind }: { kind: NoteKind }) {
  const p = {
    width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (kind === "done") return <svg {...p}><path d="M4 12.5l5 5L20 6" /></svg>;
  if (kind === "blocked") return <svg {...p}><path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="9" /></svg>;
  if (kind === "system") return <BellGlyph {...p} />;
  return <svg {...p}><path d="M12 4v11M6 11l6 6 6-6" /><path d="M4.5 20h15" /></svg>; // pull: a download arrow
}

function BellGlyph(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...p}>
      <path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M10.5 20a2 2 0 0 0 3 0" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The lane.
// ---------------------------------------------------------------------------

/**
 * Watch the stores worth interrupting for and turn *transitions* into notes.
 *
 * Only transitions, never standing state: it seeds its last-seen maps on the
 * first pass without emitting, so starting the app with three already-finished
 * chats does not fire three stale toasts. Standing state belongs in the bar's
 * own readings; a toast means "this just happened, while you were looking away".
 *
 * It also returns the two git readings the notch used to carry, which have no
 * other home in the new shell: commits waiting to be pulled, and commits that
 * exist only on this machine.
 */
export function useAmbientNotes(): { note: Note | null; behind: number; ahead: number } {
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
          push({ id: `${c.id}-b-${c.messages.length}`, kind: "blocked", color: "var(--error)", title: c.title || "Chat", sub: c.blockedTool ? `Needs "${c.blockedTool}"` : "Waiting on you", urgent: true });
          recordNote({ app: "chat", summary: c.title || "Chat", body: c.blockedTool ? `Blocked — needs "${c.blockedTool}"` : "Blocked — waiting on you", urgency: 2 });
        } else if (c.attention === "done") {
          push({ id: `${c.id}-d-${c.messages.length}`, kind: "done", color: "var(--success)", title: c.title || "Chat", sub: "Turn finished" });
          recordNote({ app: "chat", summary: c.title || "Chat", body: "Turn finished" });
        }
      }
      first = false;
    };
    read();
    return subscribeChats(read);
  }, []);

  // A tool call held at the gate. The most interrupting thing here, because an
  // agent is stopped until it is answered, and unlike everything else it cannot
  // be caught up on later: the hold expires on its own.
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
      // still holding.
      urgent: true,
    });
  }), []);

  // Desktop notifications, read off the D-Bus session bus by the server and
  // mirrored here. They share the lane with agentglass's own events on purpose:
  // from where you are sitting, "a teammate replied" and "the chat finished" are
  // the same kind of interruption, and giving each its own surface would mean
  // watching two places instead of one.
  //
  // Only while the setting is on -- with it off the socket is never opened, so
  // the server never even starts watching. An unsupported platform simply never
  // delivers anything and nothing here needs to know.
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
  // own poll, deliberately slow: this moves on the scale of someone pushing to a
  // remote, not of anything you are doing, so a minute and a half of staleness
  // costs nothing and keeps the request rare.
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
      } catch { /* offline or no repos -- the readings just stay put */ }
    };
    void poll();
    const id = setInterval(poll, 90_000);
    // 90s is right for "someone else pushed", and far too slow for "you just
    // pulled" — the strip went on advertising commits you had already taken. The
    // server says when a repo moved, so read it then too.
    const off = subscribeGitChanged(() => { void poll(); });
    return () => { dead = true; clearInterval(id); off(); };
  }, []);

  return { note, behind, ahead };
}

/**
 * One toast, in the middle of the bar.
 *
 * A wipe, not a fade: the content sweeps in from one side and, when its few
 * seconds are up, sweeps out the same way — which reads as the strip turning
 * over what it shows rather than swapping it. Absolutely centred, because the
 * middle is the one place in the bar that is empty by default and therefore the
 * only place a passing message cannot push a reading off the end.
 */
export function NoteToast({ note }: { note: Note | null }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {note && (
        <motion.div
          key={note.id}
          initial={{ clipPath: "inset(0 100% 0 0)", opacity: 1 }}
          animate={{ clipPath: "inset(0 0% 0 0)" }}
          exit={{ clipPath: "inset(0 0 0 100%)" }}
          transition={{ duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
          className="flex items-center gap-2 min-w-0"
          style={{ maxWidth: "min(46vw, 460px)", pointerEvents: "none" }}
        >
          <span
            className="grid place-items-center rounded-full shrink-0"
            style={{ width: 17, height: 17, color: note.color, background: `color-mix(in srgb, ${note.color} 18%, transparent)` }}
          >
            <NoteIcon kind={note.kind} />
          </span>
          <span className="text-[10.5px] font-semibold truncate shrink-0" style={{ color: "var(--text)", maxWidth: 200 }}>{note.title}</span>
          <span className="text-[10px] truncate" style={{ color: note.color }}>{note.sub}</span>
          {/* Which app it came from. Only for the mirrored ones: on our own
              events it would say "agentglass" to someone already looking at
              agentglass. */}
          {note.kind === "system" && note.app && (
            <span className="text-[9px] uppercase tracking-wider shrink-0" style={{ color: "var(--text4)" }}>{note.app}</span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// The bell, and the list behind it.
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

function Cap({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <span className="text-[9px] uppercase tracking-wider" style={{ color: dim ? "var(--text4)" : "var(--text3)" }}>{children}</span>
  );
}

function HistoryRow({ n, onGone }: { n: SystemNote; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const long = n.body.length > 90 || n.body.includes("\n");
  return (
    <div className="agx-note-row">
      <div className="flex items-start gap-2">
        <span className="flex flex-col min-w-0 flex-1 gap-[3px]">
          <span className="flex items-center gap-2">
            <Cap>{n.app}</Cap>
            <Cap dim>{ago(n.at)}</Cap>
            {n.urgency === 2 && <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--error)" }}>urgent</span>}
          </span>
          <span className="text-[11.5px] font-semibold truncate" style={{ color: "var(--text)" }}>{n.summary}</span>
          {/* Wraps, never widens. A nowrap line contributes its whole length to
              the container's max-content width, which is what let one long Slack
              message stretch the panel across the screen. Clamped to two lines
              closed, unclamped open — so expanding grows downward. */}
          {n.body && (
            <span className={open ? "agx-note-body" : "agx-note-body agx-note-body-clamp"}>{n.body}</span>
          )}
          {/* Named, not a bare arrow. An unlabelled ↗ next to a Slack
              notification reads as "go to Slack", which is the one thing it
              cannot do — what it actually opens is the link inside the message.
              Saying the host out loud makes the button honest. */}
          {n.url && (
            <button className="agx-note-link self-start" onClick={() => void openNote(n.id)} title={n.url}>
              ↗ Open {hostOf(n.url)}
            </button>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {long && (
            <button className="agx-note-btn" onClick={() => setOpen((v) => !v)}
              title={open ? "Collapse" : "Show the whole message"}>{open ? "▴" : "▾"}</button>
          )}
          <button className="agx-note-btn" onClick={onGone} title="Dismiss">✕</button>
        </span>
      </div>
    </div>
  );
}

/**
 * The bell in the right-hand cluster, and the panel it opens.
 *
 * A count rather than a dot: "3 waiting" and "one, ages ago" are different
 * situations, and the notch already knew that. The panel is a Portal because the
 * bar clips its own overflow — it has to, or a long project name would push the
 * clock off the end — and a dropdown drawn inside it would be sliced off at 30px.
 */
export function NotifyBell({ noDrag }: { noDrag?: React.CSSProperties }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const hist = useSyncExternalStore(subscribeNotifyHistory, notifyHistory, notifyHistory);
  const unread = useSyncExternalStore(subscribeNotifyHistory, notifyUnread, () => 0);
  const quiet = useSyncExternalStore(subscribeNotifyQuiet, notifyQuiet, () => false);

  // Looking at them is what marks them read. `hist` is in the deps so a note
  // arriving while the panel is open does not silently re-arm the badge.
  useEffect(() => { if (open) markNotifyRead(); }, [open, hist]);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Capture, so Escape closes the panel before anything below it acts on the
    // same key — one Escape should undo one thing.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (btn.current?.contains(t as Node)) return;
      if (t?.closest?.("[data-notify-panel]")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const tint = quiet ? "var(--text4)" : unread > 0 ? "var(--primary)" : "var(--text3)";

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        title={
          hist.length
            ? `${hist.length} notification${hist.length === 1 ? "" : "s"}${unread ? ` — ${unread} since you last looked` : ""}${quiet ? " (quiet)" : ""}`
            : "Notifications — nothing yet"
        }
        className="relative shrink-0 grid place-items-center rounded hover:bg-white/10"
        style={{ width: 20, height: 18, color: tint, ...noDrag }}
      >
        <BellGlyph width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {/* The count sits on the bell rather than beside it: the bar has no width
            to spare, and a badge is read as "on the bell" wherever it is drawn. */}
        {unread > 0 && (
          <span
            className="absolute text-[8px] font-bold tabular-nums grid place-items-center rounded-full"
            style={{
              top: -1, right: -2, minWidth: 11, height: 11, padding: "0 2px",
              background: "var(--primary)", color: "var(--bg)",
            }}
          >{unread > 9 ? "9+" : unread}</span>
        )}
      </button>

      {open && at && (
        <Portal z={10050}>
          <div
            data-notify-panel=""
            className="fixed flex flex-col rounded-xl overflow-hidden"
            style={{
              top: at.top, right: at.right, width: 360,
              background: "var(--bg2)",
              border: "1px solid var(--border)",
              boxShadow: "0 22px 48px -20px var(--shadow)",
            }}
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <Cap>notifications</Cap>
              <Cap dim>{hist.length}</Cap>
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
                {quiet ? "Quiet on" : "Quiet"}
              </button>
              <button className="agx-note-btn ml-auto" onClick={() => { clearNotes(); setOpen(false); }}>Clear all</button>
              <button className="agx-note-btn" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
            </div>
            {hist.length ? (
              <div className="agx-inbox-list">
                {hist.map((n) => <HistoryRow key={n.id} n={n} onGone={() => dismissNote(n.id)} />)}
              </div>
            ) : (
              // Says which of the two reasons it is empty for. "Nothing here"
              // over a feature that is switched off is the same screen as
              // "nothing has happened", and they call for opposite actions.
              <div className="px-3 py-4 text-[11px]" style={{ color: "var(--text3)" }}>
                Nothing yet. Chats that finish, agents that block and branches that fall
                behind land here — and your desktop's own notifications too, once
                Settings → Notifications is switched on.
              </div>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}
