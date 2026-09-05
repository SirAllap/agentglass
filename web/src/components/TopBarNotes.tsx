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
// A third half, since: your machine's own notifications no longer pass through
// the lane at all. They are cards now (NoteToasts.tsx), because a Slack message
// is prose and this lane is a caption. They still land in the bell, which is why
// the empty state below is the place that offers to switch them on.
//
// Both live in the strip rather than in a view, deliberately. The complaint this
// came out of was being pulled away from the terminal to find out what wanted
// you; a surface welded to the top of the window is one you can read without
// going anywhere.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../lib/api.ts";
import { subscribe as subscribeChats, listChats } from "../lib/chatStore.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { subscribeNewGates } from "../lib/gateStore.ts";
import { enqueue, dequeue } from "../lib/toastQueue.ts";
import {
  subscribeNotifyHistory, notifyHistory, notifyUnread,
  markNotifyRead, dismissNote, clearNotes, openNote, recordNote,
  notifyQuiet, setNotifyQuiet, subscribeNotifyQuiet,
  appNotify, subscribeAppNotify, shouldInterrupt,
  sysNotifyOn, setSysNotifyOn, subscribeSysNotifyMode, notifyCapability,
  type SystemNote, type NotifyCapability,
} from "../lib/sysNotify.ts";
import { openPr, openPrs } from "../lib/openPrs.ts";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { appLinkFor } from "../lib/appLink.ts";

export type NoteKind = "done" | "blocked" | "pull";
export type Note = {
  id: string; kind: NoteKind; title: string; sub: string; color: string;
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

  /**
   * Callers describe the note; the lane stamps when it arrived.
   *
   * Switched off (Settings → Notifications → "agentglass's own notifications"),
   * nothing passing gets the lane — with one structural exception: a note marked
   * `urgent` is something that is STOPPED until you act, and those still speak.
   * "Do not interrupt me" is a reasonable thing to ask for; "let an agent sit
   * held until it times out and say nothing" is not, and it is the one state
   * that cannot be caught up on later.
   *
   * Off never touches the record either. Everything here also lands in the
   * bell's list through `recordNote`, which is deliberately outside this gate.
   */
  const push = (n: Omit<Note, "at">) => {
    if (!shouldInterrupt(!!n.urgent)) return;
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
          // The summary differs from the "Turn finished" one on purpose.
          // `supersede` keys a chat note on id + summary, so while both said
          // just the chat title, a turn ending QUIETLY DELETED the urgent
          // "Blocked" row above it — the one note in this loop he had to act on.
          recordNote({ app: "chat", summary: `${c.title || "Chat"} — blocked`, body: c.blockedTool ? `Blocked — needs "${c.blockedTool}"` : "Blocked — waiting on you", urgency: 2, goto: { kind: "chat", id: c.id } });
        } else if (c.attention === "done") {
          push({ id: `${c.id}-d-${c.messages.length}`, kind: "done", color: "var(--success)", title: c.title || "Chat", sub: "Turn finished" });
          // Silent, and it always should have been: a turn that ended is not a
          // task. The chat's own green dot says the same thing without a sound,
          // and with nine sessions this is the highest-volume note in the app.
          recordNote({ app: "chat", summary: c.title || "Chat", body: "Turn finished", urgency: 0, goto: { kind: "chat", id: c.id } });
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

  // Desktop notifications used to be pushed into this lane too. They are not any
  // more: they go to NoteToasts, which gives them a card. Two reasons, both of
  // them things this lane could not fix by being adjusted.
  //
  // The lane is one slot in the middle of the bar, and the "needs you" chip owns
  // that slot whenever anything is held — so the mirrored ping arrived exactly
  // when it was least likely to be shown. And a caption cannot carry someone
  // else's message: "New message from Alejandro García / Avisa cuando lo tengas"
  // is prose, and truncating prose to 10px of bar is how you end up opening
  // Slack to find out what Slack already told you.
  //
  // Our own events keep the lane, because they genuinely are captions.

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
            // The destination was already a supported kind and simply never
            // passed: mirrored git notes get one derived from their *text*
            // (gitDestination), while ours — which hold the repo and the branch
            // as facts — arrived with nothing and could not be clicked.
            // Silent: the same number already sits permanently in the "to
            // pull" chip a few centimetres away in this very bar, and it grows
            // on its own because the server autofetches. Being behind is never
            // something to do THIS SECOND.
            recordNote({ app: "git", summary: r.name, body: `${r.behind} commit${r.behind === 1 ? "" : "s"} to pull on ${r.branch}`, urgency: 0,
              goto: { kind: "git", repo: r.name, branch: r.branch, root: r.root } });
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
    <span className="text-[10px] uppercase tracking-wider" style={{ color: dim ? "var(--text4)" : "var(--text3)" }}>{children}</span>
  );
}

/** The disclosure arrow, turning rather than swapping glyph: one control that
 *  moves reads as the same thing in two states, which "▾ / ▴" did not. */
export function Chevron({ up, size = 12 }: { up: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ transform: up ? "rotate(180deg)" : undefined, transition: "transform .16s ease" }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Is this element showing less than it holds? Measured, because the guess it
 *  replaces ("longer than 90 characters, or has a newline") was wrong in both
 *  directions: a 120-character message can fit two lines, and a short one with
 *  a long URL in it cannot. */
const isCut = (el: HTMLElement | null): boolean =>
  !!el && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);

/**
 * Watch some elements and say whether any of them is clipped.
 *
 * Not a plain layout effect, which is what this was and why the control never
 * appeared: every surface here lives inside a `Portal`, and a Portal appends its
 * container in an effect of its own. A child's effects run before its parent's,
 * so measuring at that point measures an element that is not in the document —
 * height zero, width zero, "nothing is hidden" over a message that was entirely
 * hidden. Found by probe: the panel reported 168px of clipped text and the
 * expand button was not rendered.
 *
 * A ResizeObserver answers both halves: it fires once when observation starts —
 * by which time the node is attached — and again whenever the panel is resized
 * or the app's UI scale changes.
 */
export function useClipped(els: React.RefObject<HTMLElement | null>[], enabled: boolean, deps: unknown[]): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (!enabled) return;
    const measure = () => setCut(els.some((r) => isCut(r.current)));
    measure();
    const raf = requestAnimationFrame(measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const r of els) if (r.current && ro) ro.observe(r.current);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return cut;
}

/** Branches that are the base rather than a piece of work. */
const TRUNK = new Set(["master", "main", "trunk", "develop"]);

function HistoryRow({ n, onGone, onGoto }: { n: SystemNote; onGone: () => void; onGoto: (g: NonNullable<SystemNote["goto"]>) => void }) {
  const [open, setOpen] = useState(false);
  const bodyEl = useRef<HTMLSpanElement>(null);
  const sumEl = useRef<HTMLSpanElement>(null);
  // Measured while closed only — open, nothing is clipped by definition, so
  // asking then would answer "no" and take the control away mid-read.
  const cut = useClipped([bodyEl, sumEl], !open, [n.body, n.summary]);

  // Clickable only when there is somewhere to go. A row that highlights under
  // the pointer and then does nothing is the thing being fixed here, so the
  // affordance appears exactly where it is honest.
  const git = n.goto?.kind === "git" ? n.goto : null;
  /*
   * A card row says where it goes, instead of only behaving as if it did.
   *
   * Clicking the row has always opened the card in Tasks, and nobody found it:
   * a row that is a button but does not look like one is a feature you own and
   * cannot use. Reported as "there should be a button to go to that ClickUp
   * card" — and there was, it was the whole row.
   *
   * Named the way the git rows next to it are named, for the same reason those
   * are: a bare arrow beside a ClickUp notification reads as "open ClickUp",
   * which is the one thing this does not do. It stays here, in agentglass.
   */
  const card = n.goto?.kind === "card" ? n.goto : null;
  /** The destinations that are neither git nor a card: a pane, a chat, a
   *  settings page, a pull request. Each gets the same named button the other
   *  two have, because "click the row" is no longer a way to reach anything. */
  /** The app this came from, when it is one we can open. */
  const appLink = appLinkFor(n.app);
  const other = ((): { label: string; title: string } | null => {
    const g = n.goto;
    if (!g || g.kind === "git" || g.kind === "card") return null;
    if (g.kind === "pr") return { label: `${g.repo}#${g.number}`, title: `Open ${g.repo}#${g.number}` };
    if (g.kind === "pane") return { label: "The terminal", title: "Go to the pane this is about" };
    if (g.kind === "chat") return { label: "The chat", title: "Open the conversation this is about" };
    return { label: "Settings", title: `Open Settings · ${g.pane}` };
  })();
  /*
   * "Its PR" used to drop the branch name into the panel's search box as a
   * filter and leave you there. On a branch whose pull request has been merged
   * and whose branch has been deleted — which is most of them, an hour later —
   * that is a panel saying "No pull requests match this filter" over an empty
   * list, which reads as the pull request being gone rather than as the search
   * being the wrong question. Reported from a screenshot of exactly that.
   *
   * So it asks which pull request the branch HAS, and opens that one by number.
   * `prsForBranch` answers for merged and closed ones too, because it looks up
   * the head ref rather than searching titles.
   *
   * The answer is kept on the button rather than announced elsewhere: a branch
   * with no pull request at all is a real answer, and the place somebody is
   * looking when they ask is the button they just pressed.
   */
  const [prMsg, setPrMsg] = useState("");
  const goToPr = useCallback(async () => {
    if (!git?.branch) return;
    // Without a checkout to ask from — a note parsed out of somebody else's
    // text carries no root — the old behaviour is still the best available.
    if (!git.root) { openPrs(git.branch, "all"); return; }
    setPrMsg("Looking…");
    const r = await api.prsForBranch(git.root, git.branch).catch(() => null);
    if (r?.ok && r.from && r.repo) { setPrMsg(""); openPr(r.repo, r.from.number); return; }
    // Said, not swallowed. `needsAuth` is a different fact from "there is none"
    // and sending somebody to look for a pull request that cannot be seen is
    // how the empty filter felt in the first place.
    setPrMsg(r?.needsAuth ? "Sign in to GitHub" : "No PR for this branch");
    setTimeout(() => setPrMsg(""), 4000);
  }, [git?.branch, git?.root]);
  const expandable = cut || open;
  /*
   * The row opens the message. It never travels.
   *
   * It used to do both, depending on whether the note happened to carry a
   * destination — so the same gesture on two rows that look identical either
   * read the rest of a sentence or threw you into another view and closed the
   * panel. Reported as the expand control "not working": it works, and on a row
   * with a destination the click that reached it had already navigated away.
   *
   * Going somewhere is now always a named button, which is the rule the git and
   * card rows were already following and the reason those were the two nobody
   * complained about.
   */
  const act = expandable ? () => setOpen((v) => !v) : null;
  return (
    <div className={`agx-note-row${act ? " agx-note-row-open" : ""}`}
      onClick={act ?? undefined}
      role={act ? "button" : undefined}
      title={expandable ? (open ? "Show less" : "Show the whole message") : undefined}>
      <div className="flex items-start gap-2">
        <span className="flex flex-col min-w-0 flex-1 gap-1.5">
          <span className="flex items-center gap-2">
            <Cap>{n.app}</Cap>
            <Cap dim>{ago(n.at)}</Cap>
            {n.urgency === 2 && <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--error)" }}>urgent</span>}
          </span>
          {/* The title unwraps too. Expanding has to mean "show me all of it",
              and a summary cut at one line with an ellipsis is part of "all of
              it" — a Slack notification puts the channel and the sender there. */}
          <span ref={sumEl}
            className={open ? "text-[11.5px] font-semibold" : "text-[11.5px] font-semibold truncate"}
            style={{ color: "var(--text)", ...(open ? { overflowWrap: "anywhere" as const } : null) }}>{n.summary}</span>
          {/* Wraps, never widens. A nowrap line contributes its whole length to
              the container's max-content width, which is what let one long Slack
              message stretch the panel across the screen. Clamped to two lines
              closed, unclamped open — so expanding grows downward. */}
          {n.body && (
            <span ref={bodyEl} className={open ? "agx-note-body" : "agx-note-body agx-note-body-clamp"}>{n.body}</span>
          )}
          {/* Named, not a bare arrow. An unlabelled ↗ next to a Slack
              notification reads as "go to Slack", which is the one thing it
              cannot do — what it actually opens is the link inside the message.
              Saying the host out loud makes the button honest. */}
          {n.url && (
            <button className="agx-note-link self-start" onClick={(e) => { e.stopPropagation(); void openNote(n.id); }} title={n.url}>
              ↗ Open {hostOf(n.url)}
            </button>
          )}
          {/* No link in the message, but the app it came from can be opened.
              Clicking a mirrored Slack message did nothing at all, while the
              desktop pop-up it was copied from opens Slack — because a
              notification's own action belongs to the app that posted it and a
              bus monitor cannot invoke one. The scheme is what is left, and it
              opens the app rather than the message, so the button says the app.
              Slack lands you where you were, which is usually the conversation
              that just pinged you. */}
          {!n.url && appLink && (
            <button className="agx-note-link self-start"
              onClick={(e) => { e.stopPropagation(); void openNote(n.id); }}
              title={`Open ${appLink} — this app, not the message: a mirrored notification carries no link to it`}>
              ↗ Open {appLink}
            </button>
          )}
          {/* The two things a "commits to pull" row is actually asking you to
              do. Named rather than arrowed, and side by side, because they are
              different destinations: one is the checkout where the work is, the
              other is the review it belongs to. */}
          {card && (
            <button className="agx-note-link self-start"
              title={`Open ${card.label} on the board here — no browser`}
              onClick={(e) => { e.stopPropagation(); onGoto(card); }}>
              ↗ Card · {card.label}
            </button>
          )}
          {/* The other three destinations, which had no button at all: the row
              carried them and only the row's own click could reach them, which
              is exactly the gesture that has just been given back to reading. */}
          {other && (
            <button className="agx-note-link self-start" title={other.title}
              onClick={(e) => { e.stopPropagation(); onGoto(n.goto!); }}>
              ↗ {other.label}
            </button>
          )}
          {git && (
            <span className="flex items-center gap-1 self-start flex-wrap">
              <button className="agx-note-link" title={`Source control, scoped to ${git.repo}`}
                onClick={(e) => { e.stopPropagation(); void onGoto(git); }}>
                ↗ Git · {git.repo}
              </button>
              {/* Not on the trunk. `master` does not have a pull request, so the
                  button could only ever answer "No PR for this branch" — which
                  is what it did, on the one row that shows up most often. */}
              {git.branch && !TRUNK.has(git.branch) && (
                <button className="agx-note-link" title={prMsg || `Open the pull request for ${git.branch}`}
                  onClick={(e) => { e.stopPropagation(); void goToPr(); }}>
                  ↗ {prMsg || "Its PR"}
                </button>
              )}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {/* A control, not a character. This was a 10px "▾" wedged against the
              ✕, which is an affordance nobody finds — the message looked simply
              truncated, with the rest of it unreachable. Same size and shape as
              the dismiss button beside it, so the pair reads as "open it" and
              "get rid of it". */}
          {expandable && (
            <button className="agx-note-btn agx-note-icon" aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
              title={open ? "Show less" : "Show the whole message"}>
              <Chevron up={open} />
            </button>
          )}
          <CloseButton onClick={(e) => { e.stopPropagation(); onGone(); }} title="Dismiss" className="agx-note-btn agx-note-icon" />
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
export function NotifyBell({ noDrag, onGoto }: {
  noDrag?: React.CSSProperties;
  /** Take me to what this note is about. The bar does not know how; the shell
   *  does, so the destination travels up rather than the router coming down. */
  onGoto: (g: NonNullable<SystemNote["goto"]>) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const hist = useSyncExternalStore(subscribeNotifyHistory, notifyHistory, notifyHistory);
  const unread = useSyncExternalStore(subscribeNotifyHistory, notifyUnread, () => 0);
  const quiet = useSyncExternalStore(subscribeNotifyQuiet, notifyQuiet, () => false);
  const mirroring = useSyncExternalStore(subscribeSysNotifyMode, sysNotifyOn, () => false);
  const own = useSyncExternalStore(subscribeAppNotify, appNotify, () => true);
  // Asked only when the panel is opened, and only while the answer could change
  // what is on screen: an unsupported host must never be offered a switch that
  // cannot do anything.
  const [cap, setCap] = useState<NotifyCapability | null>(null);
  // Re-asked whenever we do not have a positive answer, not just once: a probe
  // that landed while the server was still starting is not a verdict, and the
  // panel is where the offer to switch this on lives.
  useEffect(() => {
    if (!open || cap?.supported) return;
    void notifyCapability().then(setCap);
  }, [open, cap]);

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
        /* 22x22 and a 14px bell, up from 20x18 and 12px.
         *
         * Measured across all fourteen views: this was the ONE icon-only
         * control in the whole app below the house floor of a 14px glyph in a
         * 20x20 target — every other small glyph either sits in a labelled
         * control or already has the room. Two pixels short in one place is
         * not a pattern, but this is the bell, which is the control you go
         * for when something is waiting on you.
         *
         * The bar is 30px, so 22 leaves four either side. */
        className="relative shrink-0 grid place-items-center rounded hover:bg-white/10"
        style={{ width: 22, height: 22, color: tint, ...noDrag }}
      >
        <BellGlyph width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {/* The count sits on the bell rather than beside it: the bar has no width
            to spare, and a badge is read as "on the bell" wherever it is drawn. */}
        {unread > 0 && (
          <span
            className="absolute text-[9px] font-bold tabular-nums grid place-items-center rounded-full"
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
            <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
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
              <CloseButton onClick={() => setOpen(false)} title="Close (Esc)" className="agx-note-btn" />
            </div>
            {hist.length ? (
              <div className="agx-inbox-list">
                {hist.map((n) => (
                  <HistoryRow key={n.id} n={n} onGone={() => dismissNote(n.id)}
                    onGoto={(g) => { setOpen(false); onGoto(g); }} />
                ))}
              </div>
            ) : (
              // Says which of the two reasons it is empty for. "Nothing here"
              // over a feature that is switched off is the same screen as
              // "nothing has happened", and they call for opposite actions.
              <div className="px-3 py-4 text-[11px] flex flex-col gap-2.5" style={{ color: "var(--text3)" }}>
                <span>
                  Nothing yet. Chats that finish, agents that block and branches that fall
                  behind land here{mirroring ? " — your desktop's own notifications too." : "."}
                </span>
                {/* The switch, where you notice it is off.
                    Telling someone their notifications are off and then sending
                    them to a modal three panes deep is how this feature spent
                    months looking broken to someone who had simply never turned
                    it on. Supported hosts get the button; the rest get the
                    reason, which is not their fault and not fixable here. */}
                {!mirroring && (cap?.supported
                  ? (
                    <button className="agx-note-link self-start"
                      onClick={() => setSysNotifyOn(true)}
                      title="Mirror this machine's notifications into agentglass — Slack, mail, whatever else pops up while the app is covering your screen">
                      Turn on desktop notifications
                    </button>
                  )
                  : cap && (
                    <span style={{ color: "var(--text4)" }}>
                      Desktop notifications unavailable — {cap.reason}
                    </span>
                  ))}
              </div>
            )}
            {/* Standing state, said out loud wherever the list is read. Two
                switches can silence this panel's sources and both of them are
                elsewhere; a list that is empty because you muted it should never
                look like a list that is empty because nothing happened. */}
            {hist.length > 0 && (!own || !mirroring) && (
              <div className="px-2.5 py-1.5 text-[9.5px] flex items-center gap-2"
                style={{ borderTop: "1px solid var(--border)", color: "var(--text4)" }}>
                <span>
                  {!own && !mirroring ? "Both lanes are quiet — nothing interrupts, everything still collects here."
                    : !own ? "agentglass's own alerts are not interrupting — they still collect here."
                    : "Your desktop's notifications are not being mirrored."}
                </span>
                {!mirroring && cap?.supported && (
                  <button className="agx-note-btn ml-auto shrink-0" onClick={() => setSysNotifyOn(true)}>Turn on</button>
                )}
              </div>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}
