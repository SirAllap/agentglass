/*
 * When the middle of the bar and the meters want the same pixels.
 *
 * The strip keeps its middle empty so that it has somewhere to put the one
 * thing that matters — a toast, or the chip saying an agent is blocked. That
 * slot is absolutely centred on the WINDOW, and the group on the right (plan
 * meters, clock, bell) is laid out from the right edge, so the two are not in
 * the same flow and nothing stops them meeting: on a narrow window the message
 * runs straight under the meters and neither can be read. Reported with a
 * screenshot of exactly that: "look how it overlaps when the notification appears".
 *
 * The meters are the half that can wait. A percentage that moves over hours is
 * not what the bar interrupted you for, and it is two clicks away in the
 * dashboard; the message is gone in seconds. So while they would collide the
 * meters stand down, and they come back the moment there is room.
 *
 * This is the decision alone, kept out of the component so it can be tested
 * without a layout engine — the geometry comes from `getBoundingClientRect`,
 * which is the browser's answer and not ours to guess at.
 */

/** Breathing room between the message and whatever is beside it. Below this
 *  they are not overlapping yet, but they read as one run of text. */
export const TOPBAR_GAP = 10;

/**
 * How much more room than the bare minimum it takes to bring the meters BACK.
 *
 * Without it this flaps: the meters go, that frees their width, the free width
 * says there is room, they return, and they collide again — several times a
 * second, on a bar somebody is trying to read. The decision is fed the geometry
 * as if the meters were showing (see `rightEdge`), which stops the loop; the
 * slack is what keeps a message whose width breathes — a truncating title, a
 * count going from 9 to 10 — from doing the same thing more slowly.
 */
export const TOPBAR_SLACK = 14;

export interface TopBarFit {
  /** Right edge of the centred slot, in viewport coordinates. */
  slotRight: number;
  /**
   * Left edge of the right-hand group AS IF the meters were showing.
   *
   * Not the measured edge: hiding the meters moves that edge right by their
   * width, which would make the next measurement say there is room. The caller
   * remembers what they measured while visible and adds it back — so the input
   * to this decision does not change when the decision does.
   */
  rightEdge: number;
  /** Whether anything is in the middle at all. Nothing centred, nothing to
   *  make room for — the meters are the bar's normal state, not a fallback. */
  occupied: boolean;
  /** What was decided last time. */
  hidden: boolean;
}

export function metersMustHide(m: TopBarFit): boolean {
  if (!m.occupied) return false;
  const need = m.slotRight + TOPBAR_GAP + (m.hidden ? TOPBAR_SLACK : 0);
  return need > m.rightEdge;
}
