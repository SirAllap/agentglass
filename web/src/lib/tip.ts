// The one tooltip, decided apart from the screen.
//
// Every hint on the pull-request view is the same dark card: a bold name, a
// mono detail beside it, a tag at the right, one plain sentence, and a last line
// that says what a click does. A native `title` is a different box on every
// platform and cannot hold any of that, so the elements carry `data-tip` and
// one host (components/TipHost.tsx) draws it. What the card says, when it shows
// and where it sits are rules, and rules live here where a test can reach them.
//
// The ceiling: only the pull-request view hands its hints to this. The rest of
// the app still uses `title`, and moving it is its own change.

/** The rich form: every part is optional except the name. */
export interface TipSpec {
  name: string;
  /** The name is an identifier (a card id) and is set in the mono face. */
  mono?: boolean;
  /** Small mono text beside the name: `#1044`, `in Tasks`. */
  detail?: string;
  /** The tag at the right end of the first line. */
  tag?: string;
  /** A status dot before the sentence, in this colour (the ticket's own status). */
  dot?: string;
  /** One plain sentence. */
  text?: string;
  /** Chips under the sentence (labels). */
  pills?: string[];
  /** The last line: what a click does, or where to change the thing. */
  hint?: { key?: string; text: string; right?: string };
  /** A number's provenance (Starboard): how far it can be trusted, and the four answers under the name. */
  trust?: Trust;
  from?: string;
  how?: string;
  caveat?: string;
  /** What the engine must record before this is a fact; shown dashed, "proposed". */
  needs?: string;
  /** Labelled facts under the name, in order: `[["Assignee", "Lin Tester"]]`. */
  rows?: { k: string; v: string }[];
}

export type Trust = "measured" | "estimated" | "proposed";

/** The pointer has to rest this long on a target before its tip opens. */
export const TIP_DELAY_MS = 350;
/** Right after another tip closed (within TIP_GRACE_MS) the next opens almost at once. */
export const TIP_QUICK_MS = 120;
export const TIP_GRACE_MS = 400;
/** The keyboard arrived on purpose: it does not need to rest. */
export const TIP_FOCUS_MS = 150;

export const tipDelay = (focus: boolean, sinceClosedMs: number): number =>
  focus ? TIP_FOCUS_MS : sinceClosedMs < TIP_GRACE_MS ? TIP_QUICK_MS : TIP_DELAY_MS;

/**
 * A plain sentence becomes a name and a sentence: at an em dash, at the first
 * full stop followed by a capital or a digit, or at a short "label: " lead.
 * "theo-w: changes requested" -> name "theo-w", text "changes requested".
 */
export function splitTip(plain: string): { name: string; text: string } {
  const dash = plain.indexOf(" — ");
  if (dash > 0) return { name: plain.slice(0, dash), text: plain.slice(dash + 3) };
  const stop = plain.search(/\. (?=[A-Z0-9])/);
  if (stop > 0) return { name: plain.slice(0, stop), text: plain.slice(stop + 2) };
  const colon = plain.indexOf(": ");
  if (colon > 0 && colon < 24) return { name: plain.slice(0, colon), text: plain.slice(colon + 2) };
  return { name: plain, text: "" };
}

/** What goes in the `data-tip` attribute: the plain string as it is, a rich spec as JSON. */
export const tipAttr = (t: string | TipSpec): string => (typeof t === "string" ? t : JSON.stringify(t));

/** The attribute back into a spec. A string that is not JSON is a plain sentence. */
export function readTip(attr: string): TipSpec {
  if (attr.startsWith("{")) {
    try {
      const o = JSON.parse(attr) as TipSpec;
      if (o && typeof o.name === "string") return o;
    } catch { /* a sentence that happens to start with a brace */ }
  }
  const { name, text } = splitTip(attr);
  return text ? { name, text } : { name };
}

const GAP = 8;
const EDGE = 8;

/**
 * Where the card goes, always inside the window (EDGE all round) and, whenever the window has room for it, never over
 * the control it describes: centred above the target; below it when there is no room above; beside it (right, else
 * left) when there is room for neither; and only when the card fits nowhere clear of the target is it pushed inside
 * the window over it. A card wider than the window starts at the left edge, a taller one at the top.
 * Ceiling: a card taller than the window is not shrunk here, it is clamped (the host's max-width wraps long text).
 */
export function placeTip(target: { left: number; top: number; width: number; height: number }, tip: { w: number; h: number }, vw: number, vh: number): { left: number; top: number; below: boolean } {
  const clamp = (v: number, size: number, room: number) => (size >= room - 2 * EDGE ? EDGE : Math.min(Math.max(EDGE, v), room - size - EDGE));
  const left = clamp(target.left + target.width / 2 - tip.w / 2, tip.w, vw);
  const above = target.top - tip.h - GAP;
  if (above >= EDGE) return { left, top: above, below: false };
  const below = target.top + target.height + GAP;
  if (below + tip.h <= vh - EDGE) return { left, top: below, below: true };
  const right = target.left + target.width + GAP;
  const beside = right + tip.w <= vw - EDGE ? right : target.left - GAP - tip.w >= EDGE ? target.left - GAP - tip.w : null;
  if (beside !== null) return { left: beside, top: clamp(target.top + target.height / 2 - tip.h / 2, tip.h, vh), below: false };
  const roomAbove = target.top, roomBelow = vh - target.top - target.height;
  return roomBelow > roomAbove ? { left, top: clamp(below, tip.h, vh), below: true } : { left, top: clamp(above, tip.h, vh), below: false };
}
