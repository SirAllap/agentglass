// What the Notifications page holds, as plain data: sections in order, each row's
// label, one-sentence help and the setting id it writes (if it has one). The page
// renders from this and the tests read it. Channel and kind rows come from
// shared/notifyPrefs.ts, which carries their own labels and one-line help.
import type { SectionKind } from "../shell/shellRules.ts";

export interface NotificationsRowDef { label: string; help: string; id?: string }
export interface NotificationsSectionDef { id: string; title: string; kind: SectionKind; rows: NotificationsRowDef[] }

export const NOTIFICATIONS_PURPOSE = "Where each notification shows; an agent that waits on you always reaches you.";

/** Rows that are fixed. The per-app, per-channel and per-kind rows are added by the page. */
export const NOTIFICATIONS_SECTIONS: NotificationsSectionDef[] = [
  { id: "popups", title: "Pop-ups", kind: "normal", rows: [
    { label: "Desktop DND", help: "Your system switch, the same as the title bar chip." },
    { label: "What pops up", help: "Was Volume (Off, Quiet, Normal, Loud), and keeps the same stored choice." },
    { label: "News pop-ups", help: "Same flag as Agents above, so it moves with it.", id: "notifications.quiet" },
    { label: "Send a test notification", help: "In 5 seconds, one test note per kind, shown where a real one shows." },
  ] },
  { id: "apps", title: "Apps", kind: "normal", rows: [] },
  { id: "more", title: "More", kind: "normal", rows: [
    { label: "Collect other apps' notifications", help: "Off, Slack, mail and other apps never reach agentglass, not even the bell." },
    { label: "How much of the message", help: "Full shows the text, Who shows only the sender." },
    { label: "Silence all", help: "No cards, sound or badge, but an agent that waits still pops up." },
    { label: "Agents waiting on you break through DND", help: "With DND on and agentglass hidden, a waiting agent still gets one desktop popup." },
    { label: "Paired phones", help: "Lets paired phones raise alerts for what you watch.", id: "phone.alerts" },
  ] },
  { id: "asked", title: "Asked for", kind: "normal", rows: [
    { label: "Alerts you armed", help: "The notifications you asked for, newest first, and what became of them." },
  ] },
  { id: "sound", title: "Sound", kind: "normal", rows: [
    { label: "Notification sound", help: "Which sound notifications make." },
    { label: "Chime this session", help: "Only this window, until you quit." },
    { label: "Alarm voice", help: "Spoken when a reminder rings." },
  ] },
];
