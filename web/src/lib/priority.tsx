/*
 * ONE PRIORITY MARK, EVERYWHERE.
 *
 * The board drew ClickUp's logo — two chevrons — beside a card id; the tasks
 * view drew a flag in the priority's own colour; the pull request panel drew
 * the chevrons again. Three surfaces, three answers to "how urgent is this",
 * and only one of them actually said anything: "in some places it shows those
 * arrows and in others the flag... it has to be consistent and only use the flag,
 * in the priority's colour".
 *
 * The chevrons are a BRAND MARK. They say which tracker the card lives in,
 * which nobody is asking, and they say it in the exact spot the eye goes
 * looking for how much this matters. The flag answers the question and carries
 * the colour, so it replaces the logo rather than joining it.
 *
 * This module exists because the catalogue was a `const` private to
 * TasksPanel.tsx. A second surface wanting the same colours had to either
 * import from a 9,000-line component or copy four hex values — and copying is
 * how the three answers happened in the first place.
 */
import type { ProviderTask } from "../../../shared/providers.ts";

/**
 * THE HEIGHT EVERY CHIP ON A ROW SHARES.
 *
 * The card's id chip and the status chip sat side by side at different heights:
 * one set `leading-none` and the other let its line-height decide, so 11px text
 * and 9.5px text produced 17px and 20px boxes. Two chips on one line at two
 * heights is the kind of thing you see before you can say what is wrong with it.
 *
 * A number rather than each chip's own padding arithmetic: padding is how they
 * ended up different in the first place.
 */
export const CHIP_H = 18;

/** ClickUp's four, in its own order and this app's own colours. */
export const PRIOS = [
  { id: "urgent", label: "Urgent", c: "var(--error)" },
  { id: "high", label: "High", c: "var(--warning)" },
  { id: "normal", label: "Normal", c: "var(--info)" },
  { id: "low", label: "Low", c: "var(--text4)" },
] as const;

/** Colour and label for a priority, including the one that is not set. */
export const prioLook = (p: ProviderTask["priority"]) =>
  PRIOS.find((x) => x.id === p) ?? { id: "", label: "None", c: "var(--text4)" };

/**
 * ClickUp's flag, at the size of the text beside it.
 *
 * A glyph rather than an icon: it is read WITH its word or its id, never alone,
 * so the icon floor for a control does not apply — and the outline one says "no
 * priority" without needing a legend.
 */
export function Flag({ c, on, size = 12 }: { c: string; on: boolean; size?: number }) {
  return <span aria-hidden className="shrink-0" style={{ color: c, fontSize: size, lineHeight: 1 }}>{on ? "\u2691" : "\u2690"}</span>;
}

/** The flag for a card, looked up and drawn in one step — what every surface
 *  outside the tasks view actually wants. */
export function PriorityFlag({ p, size }: { p: ProviderTask["priority"]; size?: number }) {
  const look = prioLook(p);
  return <Flag c={look.c} on={!!p} size={size} />;
}

/**
 * THE CARD CHIP — one component, every surface.
 *
 * `ORBIT-1042` with its priority flag in the priority's colour: blue for
 * normal, amber for high, red for urgent, an outline flag for none. It appears
 * on the board's card, on the pull request's masthead, in the sidebar, and it
 * had drifted into three different things — a chip with ClickUp's logo, a chip
 * with a flag, and a bare label with neither.
 *
 * That drift is the whole reason this exists as a component rather than as
 * markup copied three times: "CONSISTENCIA JODER", and he was right to shout.
 * There is now one place to change it and no way for a fourth to appear.
 */
export function CardChip({ id, priority, status, onOpen, title, className }: {
  id: string;
  priority: ProviderTask["priority"];
  /** The card's own state, when the caller has it. */
  status?: string;
  onOpen?: () => void;
  title?: string;
  className?: string;
}) {
  /*
   * THE WHOLE CHIP TAKES THE PRIORITY'S COLOUR, not just the flag.
   *
   * The first version painted the chip in the app's accent and put a coloured
   * flag inside it, which reads as one chip with a decoration. The tasks view
   * has always done the other thing — the chip itself is blue on a normal card
   * and amber on a high one — and that is what makes urgency readable across a
   * column without stopping on any single row.
   *
   * No priority keeps the accent: a card nobody has ranked is not "low", and
   * painting it grey would say something the card does not.
   */
  const look = prioLook(priority);
  const tint = priority ? look.c : "var(--accent, var(--primary))";
  const inner = (
    <>
      <PriorityFlag p={priority} size={12} />
      <span>{id}</span>
      {status && (
        <span className="uppercase tracking-wide text-[9px] font-medium truncate"
          style={{ color: "var(--text3)", maxWidth: 110 }}>{status}</span>
      )}
    </>
  );
  const style = {
    height: CHIP_H,
    color: tint,
    border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`,
    background: `color-mix(in srgb, ${tint} 12%, transparent)`,
  };
  /*
   * ITS OWN SIZE, never the container's.
   *
   * Without `text-[11px]` this inherits, and it landed in two places whose text
   * is bigger than a chip's: the masthead, where it towered over the `#101`
   * beside it, and the sidebar, where it came out half again the size of the
   * status pill directly underneath. "consistency, but also in size relative
   * to what is around it" — a chip that changes size with its
   * surroundings is a different chip in each of them.
   *
   * 11px is this app's chip size: the pull request's own number chip, the
   * labels and the scope pills are all set there.
   */
  const cls = `inline-flex items-center gap-1.5 rounded px-1.5 shrink-0 tabular-nums text-[11px] leading-none ${className ?? ""}`;
  /* `data-card-chip` so a probe can count these without matching a class list:
     the first version of that lock pinned the exact classes and broke the day
     one padding changed. */
  return onOpen
    ? <button data-card-chip className={`agx-btn ${cls}`} style={style} title={title}
        onClick={(e) => { e.stopPropagation(); onOpen(); }}>{inner}</button>
    : <span data-card-chip className={cls} style={style} title={title}>{inner}</span>;
}

/**
 * A PERSON FROM THE TRACKER, not from the forge.
 *
 * The board drew the card's assignee with `<Avatar login={name}>`, which asks
 * GitHub for a portrait of "Antonio García" and gets a blank circle: a name on
 * a tracker board is not a username on a forge, and the two identity systems do
 * not line up at all.
 *
 * The tracker hands over the photo, the initials and the colour it assigned —
 * the tasks view has drawn people that way since it existed. This is that same
 * drawing, moved somewhere both views can reach it, so a third surface cannot
 * invent a fourth answer.
 */
export function CardFace({ p, n = 0, size = 16 }: {
  p: { name: string; initials: string; color?: string; avatar?: string; me?: boolean };
  /** Position in a stack, for the overlap. */
  n?: number;
  size?: number;
}) {
  const base = {
    width: size, height: size, borderRadius: 999, marginLeft: n ? -(size * 0.3) : 0,
    /* A ring in the app's own success colour marks you, the way the tasks view
       does — the one face in a stack you do not have to read the name of. */
    boxShadow: `0 0 0 1.5px ${p.me ? "var(--success)" : "transparent"}, 0 0 0 3px var(--bg2)`,
    zIndex: 3 - n,
    position: "relative" as const,
  };
  const title = p.me ? `${p.name} — you` : p.name;
  if (p.avatar) {
    return <img src={p.avatar} alt="" title={title} loading="lazy" referrerPolicy="no-referrer"
      style={{ ...base, objectFit: "cover" }} />;
  }
  /* No photo: initials on the colour the workspace gave them, which is how two
     people who share initials stay apart. */
  return (
    <span title={title} className="inline-flex items-center justify-center font-medium"
      style={{ ...base, fontSize: size * 0.5, background: p.color || "var(--bg4)", color: "#fff" }}>
      {p.initials}
    </span>
  );
}
