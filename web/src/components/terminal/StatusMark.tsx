/*
 * The mark for what the agent in a tmux window is doing.
 *
 * Fleet's silhouettes and colours (`Fleet.tsx`, `StateMark`), so a state looks
 * the same in the tab strip, the window switcher and the fleet: a disc is work
 * in progress, a ring is a question waiting for you, a wedge is an error. The
 * fleet has no "finished and unseen", so that one is a tick — in the colour the
 * tab's name used to turn for exactly that. Distinct in outline as well as
 * colour, because amber, red and green are three of the colours most often
 * seen as one.
 *
 * `idle` draws a faint hollow circle where there is room to explain it (the
 * switcher), and nothing at all in the strip, where every mark is read at a
 * glance and a quiet tab should look quiet.
 */
import { ICON } from "../../lib/iconSize.ts";
import { sharedPhase } from "../../lib/sharedPhase.ts";
import { STATUS_WORDS, type WindowStatus } from "../../../../shared/windowStatus.ts";

export const STATUS_COLOR: Record<WindowStatus, string> = {
  waiting: "var(--warning)",
  error: "var(--error)",
  working: "var(--success)",
  done: "var(--success)",
  idle: "var(--text4)",
};

export function StatusMark({ status, size = ICON.xs, title }: { status: WindowStatus; size?: number; title?: string }) {
  const c = STATUS_COLOR[status];
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className="shrink-0 block"
      role="img" aria-label={title ?? STATUS_WORDS[status]}
      // Only `working` moves, and only in opacity — the phone mark's breathe,
      // so a busy tab reads "still going" without the row twitching. The
      // shape and colour carry it for anyone who asked for less motion.
      // `animationDelay` puts every instance on the same shared clock, so a
      // screen with several of them steps in phase — see sharedPhase.ts.
      style={status === "working" ? { animation: "agx-phone-pulse 1.8s ease-in-out infinite", animationDelay: sharedPhase(1800) } : undefined}>
      {title && <title>{title}</title>}
      {status === "working" && <circle cx="6" cy="6" r="3.5" fill={c} />}
      {status === "waiting" && <circle cx="6" cy="6" r="3.4" fill="none" stroke={c} strokeWidth="2" />}
      {status === "error" && <path d="M6 1.8 10.6 10H1.4Z" fill={c} />}
      {status === "done" && <path d="M2.4 6.3 4.9 8.7 9.6 3.4" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />}
      {status === "idle" && <circle cx="6" cy="6" r="2.8" fill="none" stroke={c} strokeWidth="1.2" />}
    </svg>
  );
}
