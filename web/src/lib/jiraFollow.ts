/*
 * What the watch and vote controls on a Jira card say and do, decided apart from the screen.
 *
 * The label never changes with the state: "Watch" is "Watch" whether you do or not, and the tint, `aria-pressed` and the
 * tooltip carry the state, so the control stays where it is and as wide as it was. Only the count moves, and only by the
 * one this account's own press made (shared/jiraFollow.ts).
 */
import { countSaid, followAction, type CardFollow, type FollowKind } from "../../../shared/jiraFollow.ts";

export interface FollowControl {
  kind: FollowKind;
  label: string;
  /** The count as a number's text, empty when the site did not give one. */
  count: string;
  on: boolean;
  /** `toggle` presses; `readonly` is writing to Jira switched off (the count is still true); `denied` is an account the site refused. */
  mode: "toggle" | "readonly" | "denied";
  /** This one's request is out: its icon turns. */
  busy: boolean;
  /** A request of either is out: neither may be pressed until it is answered. */
  locked: boolean;
  title: string;
}

export interface FollowIn {
  /** Writing to Jira is switched on. */
  writes: boolean;
  /** Which of the two has a request out, if either. */
  out: FollowKind | null;
  /** The site's refusal of this account, in our words; the control is not offered again for this card. */
  denied: string | null;
  key: string;
}

const NOUN: Record<FollowKind, { label: string; one: string; who: string }> = {
  watch: { label: "Watch", one: "watcher", who: "You are watching it" },
  vote: { label: "Vote", one: "vote", who: "You voted for it" },
};

/** The control for one of the two, or null when there is nothing to draw: no read yet, or a site that has voting off. */
export function followControl(kind: FollowKind, f: CardFollow | undefined, o: FollowIn): FollowControl | null {
  if (!f) return null;
  const n = kind === "watch" ? f.watchers : f.votes;
  if (kind === "vote" && n === null) return null;
  const on = kind === "watch" ? f.watching : f.voted;
  const mode = !o.writes ? "readonly" : o.denied ? "denied" : "toggle";
  const said = countSaid(n, NOUN[kind].one);
  const title = mode === "denied" ? (o.denied ?? "")
    : mode === "readonly" ? [said, on ? NOUN[kind].who : ""].filter(Boolean).join(". ") || NOUN[kind].label
    : `${followAction(kind, on)} ${o.key}${said ? ` · ${said}` : ""}`;
  return { kind, label: NOUN[kind].label, count: n === null ? "" : String(n), on, mode, busy: o.out === kind, locked: o.out !== null, title };
}

/** Whether a press may go out: a toggle, with nothing already in flight on either. */
export const canPress = (c: FollowControl): boolean => c.mode === "toggle" && !c.locked;
