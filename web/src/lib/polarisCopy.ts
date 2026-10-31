// The words of the Polaris card: one plain sentence per door, an example, what stays the person's,
// and the label of each mode. Plain data, so the card and its tests read the same text.
import type { DoorId } from "../../../shared/polaris.ts";

export type GroupId = "Watching" | "Landing" | "Signals" | "Automatic" | "Limits";

/** The groups in the order the card draws them. Every one of the 17 doors is in exactly one. */
export const GROUPS: readonly { id: GroupId; sub: string; doors: readonly DoorId[] }[] = [
  { id: "Watching", sub: "What it reads", doors: ["follow", "dock", "cards"] },
  { id: "Landing", sub: "When a pull request is ready", doors: ["cleared", "labels", "approvals", "redsNamed"] },
  { id: "Signals", sub: "When it needs judgment", doors: ["signals", "diagnose"] },
  { id: "Automatic", sub: "What it does for you", doors: ["relaunch", "rerunButton", "beacon", "match", "course", "cleanup", "startSession"] },
  { id: "Limits", sub: "How long it keeps going on its own", doors: ["lookAgain"] },
];

export interface DoorCopy {
  name: string;
  what: string;
  example: string;
  keep: string;
  /** The label of each mode, in the door's own order. */
  modes: Record<string, string>;
}

export const DOOR_COPY: Record<DoorId, DoorCopy> = {
  follow: {
    name: "Follow pull requests",
    what: "Polaris reads the pull requests of the repository and puts each one in a class, with one plain sentence on why.",
    example: "#322 “Add retry to the webhook sender” is read and sorted: Cleared to land, because required reviewers approved and checks are green.",
    keep: "It only reads. Every pull request that is not yours stays as it is.",
    modes: { off: "Off", on: "On" },
  },
  dock: {
    name: "Dock drafts, labelled and excluded pull requests",
    what: "A draft, a pull request with the label you choose, or one you excluded by number is Docked: never touched and nobody is woken for it.",
    example: "#301 is a draft with the label docked: listed quietly, skipped by every other door.",
    keep: "Only you dock or undock by hand. Undock is one click.",
    modes: { off: "Off", on: "On" },
  },
  cards: {
    name: "Follow tracker cards, a few at a time",
    what: "Polaris reads the cards of a list or query, tells which are running, which are stale and which are not started, and keeps at most a few running at once.",
    example: "Group size 2: cards A and B are running, so card C waits. When A finishes, C still waits for B, on purpose.",
    keep: "It never claims a card for anyone. A card tagged ignored is invisible to it.",
    modes: { off: "Off", on: "On" },
  },
  cleared: {
    name: "Say when a pull request is cleared to land",
    what: "When every required approval and check is met, the pull request gets the class Cleared to land and a link or command to merge.",
    example: "#322 turns green at 14:02. Its item says Cleared to land with an Open on GitHub button. With the quiet badge, nobody is woken.",
    keep: "You merge by hand. Always. The app never merges.",
    modes: { off: "Off", quiet: "Quiet badge", bell: "Badge and bell" },
  },
  labels: {
    name: "Check the labels a pull request needs",
    what: "Label rules are data you edit: which label a base branch and the files changed need before checks mean anything.",
    example: "#340 touches test helpers on main and has no “fast-evals” label: class Needs you, reason “label missing”, before any check is read.",
    keep: "Polaris tells you which label. Adding it is your click.",
    modes: { off: "Off", on: "On" },
  },
  approvals: {
    name: "Count only people’s approvals",
    what: "An approval from a bot does not count as a review. If only a bot reviewed, the reason says so.",
    example: "#331 has one approval, from a bot: Needs you, reason “only a bot reviewed”.",
    keep: "The required reviewers come from branch protection, not from Polaris.",
    modes: { people: "People only", any: "Bots count" },
  },
  redsNamed: {
    name: "Name the red checks that gate nothing",
    what: "When every required check is green, a red check that is not required is named in the reason but never blocks.",
    example: "#344: all 4 required checks green, one optional check red. Cleared to land, and the reason names the optional one.",
    keep: "Merging such a pull request stays your explicit click.",
    modes: { block: "Treat as blocking", name: "Name them" },
  },
  signals: {
    name: "Wake the orchestrator when judgment is needed",
    what: "Four events go to the orchestrator as a signal: cap reached, check failed, conflict, changes requested. Everything else is handled by rule and stays quiet.",
    example: "Conflict on #318 with main in 2 files: one line goes in, one line comes back.",
    keep: "The rest never wakes it.",
    modes: { off: "Off", on: "On" },
  },
  diagnose: {
    name: "Diagnose a red check",
    what: "Reads the failing job log and gives a verdict: caused by this pull request, already failing on the base branch, runner trouble, or unknown.",
    example: "#325 fails 2 tests; neither is in the diff; both failed on 3 other branches this week. Verdict: already failing on base, with the links.",
    keep: "Diagnosis only reads. Tests that fail at a rate (evals) are never blamed on the base.",
    modes: { off: "Off", click: "When I click", auto: "Automatically" },
  },
  relaunch: {
    name: "Relaunch dropped CI jobs",
    what: "A job that its runner dropped before any step ran is run again, up to a cap on attempts, and never while checks are still running.",
    example: "#325 job 11 was dropped. Polaris runs it again: attempt 2 of 3. It passes at 14:21. In a dry run it only says it would.",
    keep: "Only dropped jobs. A job that fails on its own steps is never run again.",
    modes: { off: "Off", dry: "Dry run", live: "Live" },
  },
  rerunButton: {
    name: "Offer a re-run button for reds that fail on base too",
    what: "When the diagnosis says a red is already failing on the base branch, the item gets a Re-run button with the evidence beside it.",
    example: "#325 verdict “already failing on base”: button “Re-run job 12” with the 3 earlier runs listed.",
    keep: "Always your click, with the evidence on screen.",
    modes: { off: "No button", button: "Button with evidence" },
  },
  beacon: {
    name: "Write a beacon for the session that owns the pull request",
    what: "Writes the short message that session should read. It is sent to your own session only when you click Send, once per reason.",
    example: "Beacon for #318: “Merge conflict with main in 2 files. Bring main in and push.” It resolved to orbit-billing, which is idle.",
    keep: "Never twice for the same reason. Never to a session that is working or that you did not bind.",
    modes: { off: "Off", draft: "Draft for my click" },
  },
  match: {
    name: "Match each item to its session",
    what: "Finds which session works on an item by the branch it is on. When it is set to ask, you pick the session each time.",
    example: "#318 matched orbit-billing by branch name. You can pick another session.",
    keep: "A session you never picked is never messaged unless the branch matches exactly one.",
    modes: { ask: "Ask me each time", use: "Use the match" },
  },
  course: {
    name: "Propose a course for a Drifting pull request",
    what: "When a pull request has been Drifting for a while, Polaris proposes the next step as buttons.",
    example: "#330 has been Drifting 24 h: Beacon to orbit-api, Dock for a week, or Leave it.",
    keep: "A proposal is only buttons. It does nothing until you click one.",
    modes: { off: "Off", hours: "Propose after" },
  },
  cleanup: {
    name: "Propose cleanup after a merge",
    what: "Once a pull request is merged, Polaris proposes closing its session, removing its worktree and marking the card done.",
    example: "#309 merged at 09:14. Proposal: close orbit-invoices, remove its worktree, move the card to done.",
    keep: "Each of the three is its own click. A working session is never closed.",
    modes: { off: "No proposal", propose: "Propose" },
  },
  startSession: {
    name: "Start a session for a card",
    what: "Proposes one session per card that is ready to start, with its worktree and first prompt, and checks it really started.",
    example: "Card ORBIT-1042 is not started: “Start session for ORBIT-1042” opens a tab on a new worktree from main.",
    keep: "You click each start. A failed start is retried with a pause, then it stops and tells you.",
    modes: { off: "Off", click: "One click" },
  },
  lookAgain: {
    name: "Look again by itself",
    what: "Polaris repeats its pass on a timer and when GitHub or a session changes, takes the next allowed step, then stops at a step limit and tells you.",
    example: "#325: relaunch, look again 10 min later, green, Cleared to land. Three steps, one quiet badge.",
    keep: "A pass with nothing new says “no change since 14:02”. It never goes sooner than the gap you set.",
    modes: { off: "Off", on: "On" },
  },
};

/** The words next to a numeric setting. */
export const PARAM_COPY = {
  size: { label: "Cards running at once", min: 1, max: 5 },
  cap: { label: "Attempts per run, the first included", min: 1, max: 3 },
  tries: { label: "Tries before it gives up", min: 1, max: 3 },
  steps: { label: "Steps in one pass", min: 1, max: 5 },
} as const;
export const MINUTES = [5, 10, 15, 30, 60, 120] as const;
export const HOURS = [4, 12, 24, 48] as const;
