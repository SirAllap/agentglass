/*
 * The five cards after the first run, and the one place their seen list is read.
 *
 * The titles and bodies are the mockup's. The seen list is `setup.tutorial`, a
 * comma list under APP, so a second window agrees and a reload keeps it. A card
 * is marked when it is LEFT: Next, a jump on the left list, or `Done` on the
 * fifth. `×`, Escape and `Not now` write nothing, so the offer comes back.
 */
import { api } from "./api.ts";

export interface TutorialCard {
  id: string;
  title: string;
  body: readonly string[];
}

/** The five, in the mockup's order and with its words. */
export const TUTORIAL_CARDS: readonly TutorialCard[] = [
  {
    id: "terminal",
    title: "The terminal",
    body: [
      "Every project gets a terminal, and the terminal is where the agent runs. Tabs, splits and the prefix key are the app's own; a pane keeps running when you close the window, because tmux is under it.",
      "Start one with Ctrl+↵ in any project, or from the Terminal view. An agent pill under the strip says which agent is in the tab and whether it is working.",
    ],
  },
  {
    id: "pull-requests",
    title: "Pull requests",
    body: [
      "The PR panel is the whole review in one place: the diff, the checks, the conversation, and what a reviewer asked for, next to the terminal you are going to answer it in.",
      "It reads GitHub through the GitHub CLI you signed in with. Without that sign-in the panel says so in a card with a button, rather than two lines of text.",
    ],
  },
  {
    id: "tasks",
    title: "Tasks",
    body: [
      "A card from ClickUp, Jira or a local taskwarrior list opens beside the work, and a hand-off turns it into a branch and a prompt for the agent.",
      "The task is the sentence you would have typed anyway: the app keeps it, so a second agent starting later reads the same one.",
    ],
  },
  {
    id: "agents",
    title: "Agents and orchestration",
    body: [
      "One agent can be a main agent for a project and hand work to workers, each in a worktree of its own — the flight plan, the rules, and what a worker may do are in Settings › Orchestration.",
      "You do not need any of this on day one. It is here when a second agent earns its place.",
    ],
  },
  {
    id: "polaris",
    title: "Polaris",
    body: [
      "Polaris watches what you already have running — a pull request waiting on a review, a card that has not moved — and asks before it does anything about it.",
      "It is the last card because it is the one you turn on once the rest is a habit. Settings › Polaris has every limit under it.",
    ],
  },
];

/** The ids already read, from the stored comma list. Unknown ids are ignored. */
export function seenCards(stored: string): string[] {
  const known = new Set(TUTORIAL_CARDS.map((c) => c.id));
  return stored.split(",").map((s) => s.trim()).filter((s) => known.has(s));
}

export function cardsLeft(stored: string): number {
  const seen = seenCards(stored);
  return TUTORIAL_CARDS.filter((c) => !seen.includes(c.id)).length;
}

/** The list after leaving `id`; the order is the cards' own so two writes agree. */
export function markSeen(stored: string, id: string): string {
  const have = new Set([...seenCards(stored), id]);
  return TUTORIAL_CARDS.filter((c) => have.has(c.id)).map((c) => c.id).join(",");
}

/** `I have seen these before`: every card, in the same canonical order. */
export function markAllSeen(): string {
  return TUTORIAL_CARDS.map((c) => c.id).join(",");
}

/** What the finish toast says; null means there is nothing left to offer. */
export function tutorialOffer(stored: string): { title: string; body: string; left: number } | null {
  const left = cardsLeft(stored);
  if (left === 0) return null;
  return {
    title: `Setup finished · ${left} ${left === 1 ? "card" : "cards"} left`,
    body: "The terminal, pull requests, tasks, agents and Polaris. Two minutes, and it closes where you left it.",
    left,
  };
}

/** The card after `id`, wrapping so Next on the fifth is Done and closes. */
export function cardAfter(id: string): string | null {
  const i = TUTORIAL_CARDS.findIndex((c) => c.id === id);
  return i < 0 || i === TUTORIAL_CARDS.length - 1 ? null : TUTORIAL_CARDS[i + 1]!.id;
}

/** Write the seen list once; a server that refuses leaves the card for later. */
export function saveSeen(list: string): void {
  void api.settingsDoorSet("setup.tutorial", list).catch(() => {});
}

/* The overlay is opened from two places (the finish toast and Get started), so
 * it is one app-wide switch rather than a prop threaded through the tree. */
let open = false;
const subs = new Set<() => void>();

export function subscribeTutorial(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export function tutorialOpen(): boolean { return open; }
export function openTutorial(): void {
  if (open) return;
  open = true;
  subs.forEach((f) => f());
}
export function closeTutorial(): void {
  if (!open) return;
  open = false;
  subs.forEach((f) => f());
}
