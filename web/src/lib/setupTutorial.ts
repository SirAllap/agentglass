/*
 * The five-step tour after the first run, and the one place its seen list is read.
 *
 * Each step points at a real control in the app: the coach card sits beside
 * it and a hole in the dim follows it. The seen list is `setup.tutorial`, a
 * comma list under APP, so a second window agrees and a reload keeps it. A step
 * is marked when it is LEFT: Next, Back, or `Done` on the last. `Skip tour`,
 * `×` and Escape write nothing new, so Resume opens the first step not seen.
 */
import { api } from "./api.ts";
import type { ViewId } from "../components/workspace/views.ts";

export interface TutorialCard {
  id: string;
  title: string;
  body: readonly string[];
  /** The view the step's control lives in; the tour switches there first. */
  view: ViewId;
  /** The real element the hole follows. */
  target: string;
}

/** The five, in the mockup's order and with its words. */
export const TUTORIAL_CARDS: readonly TutorialCard[] = [
  {
    id: "term", title: "Terminal tabs", view: "term", target: '[data-view="term"]',
    body: ["Each tab is a real shell in one repo. Your agent runs here. Right-click a tab to rename, split or close it."],
  },
  {
    id: "pr", title: "Pull requests", view: "pr", target: '[data-view="pr"]',
    body: ["Every pull request you review or wrote, with its diff, checks and comments. Answer a review in the terminal next to it."],
  },
  {
    id: "jira", title: "Jira cards", view: "tasks", target: '[role="tree"][aria-label="Jira spaces"]',
    body: ["Your Jira spaces live in Tasks. Open a card and start work on it: the app makes the branch and the tab."],
  },
  {
    id: "browser", title: "Browser", view: "browser", target: '[data-view="browser"]',
    body: ["A browser inside the app, signed in as you. Your agents can use it too, each in a tab of its own."],
  },
  {
    id: "flightPlan", title: "Flight plan", view: "flightPlan", target: '[data-view="flightPlan"]',
    body: ["Before a big change, the agent writes a plan. A fresh reviewer reads it. You only say Go."],
  },
];

/** What the tour needs to know about the app to plan a step. */
export interface TourEnv {
  /** The Browser view is on this build and on the rail. */
  browser: boolean;
  /** A Jira site is connected. */
  jira: boolean;
  /** The view on screen now. */
  view: ViewId | null;
}

/**
 * The steps this app shows. Browser drops out when its view is off; any other
 * step drops out when the person moved its view off the rail (`shown`), since
 * the control it points at is not drawn and the card would float with no hole.
 */
export function tourSteps(env: Pick<TourEnv, "browser"> & { shown?: (view: ViewId) => boolean }): readonly TutorialCard[] {
  const base = TUTORIAL_CARDS.filter((c) => c.id !== "browser" || env.browser);
  const shown = env.shown ? base.filter((c) => env.shown!(c.view)) : base;
  // Every view moved off the rail: keep the tour whole rather than empty.
  return shown.length ? shown : base;
}

export interface StepPlan {
  /** Switch to this view before pointing; null when it is already on screen. */
  switchTo: ViewId | null;
  /** The element the hole follows; null means a centred card with no hole. */
  target: string | null;
  /** The words for this step in this app. */
  body: readonly string[];
  /** A Settings page the step offers instead, when its own control is absent. */
  settings: "connections" | null;
}

/** Where a step points, given the app as it is. Pure, so the tests can read it. */
export function stepPlan(card: TutorialCard, env: TourEnv): StepPlan {
  if (card.id === "jira" && !env.jira) {
    return {
      switchTo: null, target: null, settings: "connections",
      body: ["No Jira is connected yet. Connect it in Settings ▸ Connections, and your spaces show up in Tasks."],
    };
  }
  return { switchTo: env.view === card.view ? null : card.view, target: card.target, body: card.body, settings: null };
}

/** The index Resume opens: the first step not seen, or the first when all are. */
export function resumeIndex(stored: string, steps: readonly TutorialCard[] = TUTORIAL_CARDS): number {
  const seen = seenCards(stored);
  const i = steps.findIndex((c) => !seen.includes(c.id));
  return i < 0 ? 0 : i;
}

/** The About row's line and the Help entry's count. */
export function tourProgress(stored: string, steps: readonly TutorialCard[] = TUTORIAL_CARDS): { line: string; resumeAt: number; done: boolean } {
  const seen = seenCards(stored).filter((id) => steps.some((c) => c.id === id));
  const at = resumeIndex(stored, steps);
  if (seen.length === 0) return { line: "Not started", resumeAt: 0, done: false };
  if (seen.length >= steps.length) return { line: `All ${steps.length} seen`, resumeAt: 0, done: true };
  return { line: `${seen.length} of ${steps.length} seen · stopped at ${steps[at]!.title}`, resumeAt: at, done: false };
}

/** The ids already read, from the stored comma list. Unknown ids are ignored. */
export function seenCards(stored: string): string[] {
  const known = new Set(TUTORIAL_CARDS.map((c) => c.id));
  return stored.split(",").map((s) => s.trim()).filter((s) => known.has(s));
}

export function cardsLeft(stored: string, steps: readonly TutorialCard[] = TUTORIAL_CARDS): number {
  const seen = seenCards(stored);
  return steps.filter((c) => !seen.includes(c.id)).length;
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
export function tutorialOffer(stored: string, steps: readonly TutorialCard[] = TUTORIAL_CARDS): { title: string; body: string; left: number } | null {
  const left = cardsLeft(stored, steps);
  if (left === 0) return null;
  return {
    title: `Setup finished · ${left} ${left === 1 ? "step" : "steps"} left`,
    body: "A short tour of the app: terminal tabs, pull requests, Jira cards, the browser and flight plan. Skip it any time and resume it from Help.",
    left,
  };
}

/** The step after `id`, so Next on the last is Done and closes. */
export function cardAfter(id: string, steps: readonly TutorialCard[] = TUTORIAL_CARDS): string | null {
  const i = steps.findIndex((c) => c.id === id);
  return i < 0 || i === steps.length - 1 ? null : steps[i + 1]!.id;
}

/** Write the seen list once; a server that refuses leaves the card for later. */
export function saveSeen(list: string): void {
  void api.settingsDoorSet("setup.tutorial", list).catch(() => {});
}

/* The overlay is opened from several places (the finish toast, the palette,
 * Settings ▸ About), so it is one app-wide switch rather than a prop threaded
 * through the tree. `startAt` is where it opens: Resume, or 0 for Start over. */
let open = false;
let startAt = 0;
const subs = new Set<() => void>();

export function subscribeTutorial(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export function tutorialOpen(): boolean { return open; }
export function tutorialStart(): number { return startAt; }
export function openTutorial(at = -1): void {
  if (open) return;
  open = true;
  startAt = at;
  subs.forEach((f) => f());
}
export function closeTutorial(): void {
  if (!open) return;
  open = false;
  subs.forEach((f) => f());
}
