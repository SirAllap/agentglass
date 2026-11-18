// Which switch wins, and where a notification shows now — said as plain data.
//
// The title bar chip, the bell panel and Settings ▸ Notifications ▸ Pop-ups all
// say the same four switches in the same order. This is that one answer, so the
// three places cannot drift apart. Pure: every input comes in as an argument.
//
// The order, top wins:
//   1. An agent waits on you — always reaches you.
//   2. Silence all — nothing else pops up; the bell keeps everything.
//   3. Desktop DND — no desktop popups; agentglass shows them inside.
//   4. What pops up — which cards agentglass shows.
//
// "What pops up" is the old Volume, with the same stored values:
//   Nothing = off (Silence all) · Agents = quiet · Apps = normal · All = loud.

/** The stored Volume value (settingsRegistry `notifications.volume`). */
export type StoredVolume = "off" | "quiet" | "normal" | "loud";
export type PopLevel = "nothing" | "agents" | "apps" | "all";

export const POP_LEVELS: readonly { id: PopLevel; stored: StoredVolume; label: string }[] = [
  { id: "nothing", stored: "off", label: "Nothing" },
  { id: "agents", stored: "quiet", label: "Agents" },
  { id: "apps", stored: "normal", label: "Apps" },
  { id: "all", stored: "loud", label: "All" },
];

export const levelOf = (v: StoredVolume): PopLevel => POP_LEVELS.find((l) => l.stored === v)!.id;
export const storedOf = (l: PopLevel): StoredVolume => POP_LEVELS.find((x) => x.id === l)!.stored;
/** The level from the switches it is stored in, read the same way as `notifications.volume`. */
export const levelFrom = (none: boolean, quiet: boolean, ownPopup: boolean): PopLevel =>
  none ? "nothing" : quiet ? "agents" : ownPopup ? "all" : "apps";
export const levelLabel =(l: PopLevel): string => POP_LEVELS.find((x) => x.id === l)!.label;

export interface NotifyInputs {
  /** Desktop DND (the system switch, or agentglass's own where the desktop cannot say). */
  dnd: boolean;
  /** Silence all. */
  silenced: boolean;
  /** What pops up. */
  level: PopLevel;
  /** Agents waiting on you now. */
  waiting: number;
  /** "Agents waiting on you break through DND". */
  breakThrough: boolean;
}

export interface WinsRow { id: "agent" | "silence" | "dnd" | "level"; label: string; sub: string; pill: string; active: boolean }
export interface WhereRow { id: "apps" | "news" | "agent"; what: string; main: string; sub: string }
export interface BellRow { label: string; said: string }

export interface NotifyStates {
  /** The title bar chip: "DND on" / "DND off". */
  chip: string;
  /** A "Silenced" chip beside it. */
  silencedChip: boolean;
  bell: { dnd: BellRow; pops: BellRow };
  wins: WinsRow[];
  where: WhereRow[];
}

const POPS_WORD: Record<PopLevel, string> = { nothing: "nothing", agents: "agents only", apps: "other apps", all: "everything" };
const POPS_SAID: Record<PopLevel, string> = {
  nothing: "Only an agent that waits on you pops up.",
  agents: "Only an agent that waits on you pops up.",
  apps: "Other apps pop up. agentglass news stays in the bell.",
  all: "Other apps and agentglass news show as cards.",
};

/** One answer for the chip, the bell and the Settings page. Assumes the window is on screen. */
export function notifyStates(i: NotifyInputs): NotifyStates {
  // Silence all holds "What pops up" at Nothing.
  const level: PopLevel = i.silenced ? "nothing" : i.level;
  const appsPop = level === "apps" || level === "all";
  const newsPop = level === "all";

  const bell = {
    dnd: {
      label: i.dnd ? "DND on" : "DND off",
      said: i.dnd ? "No desktop popups. agentglass keeps them here."
        : i.silenced ? "Other apps still pop up on the desktop."
        : "Desktop popups show. agentglass keeps a copy here.",
    },
    pops: {
      label: `Pops up: ${POPS_WORD[level]}`,
      said: i.silenced ? "Silence all wins. Only an agent that waits pops up." : POPS_SAID[level],
    },
  };

  const wins: WinsRow[] = [
    {
      id: "agent", label: "An agent waits on you",
      sub: i.dnd ? (i.breakThrough ? "Breaks through DND (switch in More)." : "Break through is off: no desktop popup under DND.")
        : "Always reaches you, any setting.",
      pill: i.waiting > 0 ? `${i.waiting} waiting` : "none now", active: i.waiting > 0,
    },
    { id: "silence", label: "Silence all", sub: "Nothing else pops up. All still lands in the bell.", pill: i.silenced ? "on · wins" : "off", active: i.silenced },
    {
      id: "dnd", label: "Desktop DND",
      sub: !i.dnd && i.silenced ? "Off: other apps still pop up on the desktop." : "On: no desktop popups. agentglass shows them inside.",
      pill: i.dnd ? "on" : "off", active: i.dnd,
    },
    i.silenced
      ? { id: "level", label: "What pops up", sub: "Held at Nothing while Silence all is on.", pill: "held", active: false }
      : { id: "level", label: "What pops up", sub: "Picks which cards agentglass shows.", pill: levelLabel(level), active: true },
  ];

  const where: WhereRow[] = [
    {
      id: "apps", what: "Other apps (Slack, mail…)",
      ...(!i.dnd ? { main: "Desktop popup", sub: i.silenced ? "the desktop draws it; agentglass: bell only" : "agentglass: bell only" }
        : appsPop ? { main: "agentglass card", sub: "and the bell" }
        : { main: "Bell only", sub: "no desktop popup, no card" }),
    },
    {
      id: "news", what: "agentglass news (PR, checks)",
      ...(newsPop ? { main: "agentglass card", sub: i.dnd ? "and the bell" : "desktop popup only when the window is hidden" }
        : { main: "Bell only", sub: i.dnd ? "no card" : "" }),
    },
    {
      id: "agent", what: "An agent waits on you", main: "Always pops up",
      sub: !i.dnd ? "" : i.breakThrough ? "desktop popup too (break through on)" : "a card here; no desktop popup while hidden",
    },
  ];

  return { chip: i.dnd ? "DND on" : "DND off", silencedChip: i.silenced, bell, wins, where };
}
