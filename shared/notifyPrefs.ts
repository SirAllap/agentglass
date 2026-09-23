// How loud agentglass is allowed to be, and about what.
//
// Everything the app can push at a person collapses into one of seven kinds.
// `blocked` is the one that earns an interruption by default: an agent truly
// stopped until a human answers (a gate hold, a permission prompt). The rest
// used to share that same urgency — a tool error, a branch falling behind, an
// agent merely idle — and arrived at the same volume as the thing that was
// actually waiting on him, which is how the one alert that mattered got lost
// in the sixty that did not. Off by default, visible where it already lives
// (the fleet card, the bell's history list), and a person can turn any of
// them back on here.
//
// `reminders` is the one exception, on by default alongside `blocked`: a
// reminder is a promise the person made to themselves at a particular minute,
// not agentglass deciding on its own that something is worth their attention.

export type NotifyKind =
  | "blocked" // an agent stopped until a human answers — a gate hold, a permission prompt
  | "idle" // an agent finished or went quiet, nothing wrong
  | "stalled" // a tool call open a long time with nothing to show for it
  | "failures" // a tool error, or a high failure rate
  | "autopilot" // the understudy or the Lantern watch says something needs a person
  | "reminders" // an alarm the person set themselves came due
  | "usage"; // a usage limit reset

/** chip = the title-bar strip and its popover; bell = the bell/toast/unread
 *  badge. Both are always DRAWN somewhere quiet; these four are what may
 *  additionally push — pop a window, ring, or take the strip. */
export type NotifyChannel = "desktop" | "sound" | "chip" | "bell";

export interface NotifyPrefs {
  /** Silence everything, whatever the kinds and channels below say. */
  none: boolean;
  kinds: Record<NotifyKind, boolean>;
  channels: Record<NotifyChannel, boolean>;
}

export const NOTIFY_KINDS: NotifyKind[] = [
  "blocked", "idle", "stalled", "failures", "autopilot", "reminders", "usage",
];
export const NOTIFY_CHANNELS: NotifyChannel[] = ["desktop", "sound", "chip", "bell"];

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  none: false,
  kinds: {
    blocked: true,
    idle: false,
    stalled: false,
    failures: false,
    autopilot: false,
    reminders: true,
    usage: false,
  },
  channels: { desktop: true, sound: true, chip: true, bell: true },
};

export const NOTIFY_KIND_LABEL: Record<NotifyKind, { label: string; desc: string }> = {
  blocked: { label: "Blocked on you", desc: "A gate hold or a permission prompt — an agent stopped until you answer." },
  idle: { label: "Waiting for input", desc: "An agent asked a question or finished and is idle, nothing stopped." },
  stalled: { label: "Stalled", desc: "A tool call open a long time with nothing to show for it." },
  failures: { label: "Failures", desc: "A tool error, or a high failure rate." },
  autopilot: { label: "Autopilot needs you", desc: "The understudy or the Lantern watch says something needs a person." },
  reminders: { label: "Reminders", desc: "An alarm you set yourself came due." },
  usage: { label: "Usage", desc: "A usage limit reset." },
};

export const NOTIFY_CHANNEL_LABEL: Record<NotifyChannel, { label: string; desc: string }> = {
  desktop: { label: "Desktop notification", desc: "A native popup, even when the window is not focused." },
  sound: { label: "Sound", desc: "A chime through this window." },
  chip: { label: "Title-bar chip", desc: "The amber strip and its popover." },
  bell: { label: "Bell", desc: "The bell's history list and unread badge." },
};

/** From whatever was on disk or came over the wire: an unknown key is
 *  dropped, and a value of the wrong type falls back to the default rather
 *  than being trusted — a hand-edited `"kinds": {"blocked": "yes"}` must not
 *  silently turn the one thing that is supposed to interrupt into a truthy
 *  string that every consumer happens to treat as on today and something
 *  else the day a check is tightened. */
export function coerceNotifyPrefs(raw: unknown): NotifyPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<NotifyPrefs>;
  const kinds = { ...DEFAULT_NOTIFY_PREFS.kinds };
  if (r.kinds && typeof r.kinds === "object") {
    for (const k of NOTIFY_KINDS) {
      const v = (r.kinds as Record<string, unknown>)[k];
      if (typeof v === "boolean") kinds[k] = v;
    }
  }
  const channels = { ...DEFAULT_NOTIFY_PREFS.channels };
  if (r.channels && typeof r.channels === "object") {
    for (const c of NOTIFY_CHANNELS) {
      const v = (r.channels as Record<string, unknown>)[c];
      if (typeof v === "boolean") channels[c] = v;
    }
  }
  return {
    none: typeof r.none === "boolean" ? r.none : DEFAULT_NOTIFY_PREFS.none,
    kinds,
    channels,
  };
}

/** The one question every emitter asks before it does anything: is THIS kind
 *  allowed on THIS channel, right now. */
export function notifies(p: NotifyPrefs, kind: NotifyKind, channel: NotifyChannel): boolean {
  return !p.none && p.kinds[kind] && p.channels[channel];
}

/**
 * What kind a `Notification` hook event's message is, from the text alone.
 *
 * Measured over 7 days of the real database (see server/src/alerts.ts,
 * `maybeAlert`'s `Notification` branch): 279 "waiting for your input", 6
 * "needs your permission", 3 "needs your approval", 2 "usage limit reset".
 * The permission/approval phrasing is the one real block; everything else —
 * including the common "waiting for your input" — is the agent asking a
 * question or reporting it is idle, not stopped on a gate.
 */
export function kindOfNotification(message: string): NotifyKind {
  if (/needs your (permission|approval)/i.test(message)) return "blocked";
  if (/usage limit/i.test(message)) return "usage";
  return "idle";
}
