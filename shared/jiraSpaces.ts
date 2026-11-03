/*
 * Jira spaces: the tree the Tasks > Jira tab draws, a project at a time.
 *
 * A space is one Jira project the person added to the sidebar. Its tree is
 * components, and under each the epics that have cards in it; an epic with
 * cards in several components appears under each of them. Two groups close the
 * tree: "No component" and, inside every component, cards with no parent epic.
 * Everything here is a read; nothing in this file writes to Jira.
 *
 * Limit, chosen: one level of epic. Epics inside epics (a hierarchy level above
 * Epic on a site that has one) are not nested; they show as epics.
 */
import type { JiraPerson, ProviderTask } from "./providers.ts";

/** The longest a space key is allowed to be: Jira's own are ten or so. */
export const SPACE_KEY_MAX = 32;

/** One space the person added, in the order they added it. */
export interface JiraSpace {
  key: string;
  name: string;
  avatarUrl?: string;
  /** Cards in the space, when a tree read has counted them. Absent is not zero. */
  count?: number;
}

/** GET /jira/spaces */
export interface JiraSpacesOut { ok: true; spaces: JiraSpace[] }

/** POST /jira/spaces: exactly one of the three. */
export type JiraSpacesEdit = { add: string } | { remove: string } | { order: string[] };

/** One project of the site, for the picker. */
export interface JiraPickerProject {
  key: string;
  name: string;
  avatarUrl?: string;
  /** Already one of the person's spaces. */
  added: boolean;
}

/** GET /jira/space-picker[?q=KEY] — every project of the site; a typed key is resolved even when the page was not listed. */
export interface JiraSpacePickerOut { ok: true; projects: JiraPickerProject[] }

export interface JiraEpicStatus {
  name: string;
  category: "open" | "done" | "other";
}

/** An epic as the tree needs it. done/total are child cards counted by status category. */
export interface JiraTreeEpic {
  key: string;
  id: string;
  summary: string;
  status: JiraEpicStatus;
  done: number;
  total: number;
  /** The component names this epic has cards in; empty when it has none. */
  components: string[];
  /** Who the epic is given to and who raised it; null is nobody (an unassigned epic, or a deactivated account). */
  assignee?: JiraPerson | null;
  reporter?: JiraPerson | null;
}

export interface JiraTreeComponent {
  /** The component's Jira id; absent for the "No component" group. */
  id?: string;
  name: string;
  /** Issue count from Jira; present even when no epic reached it. */
  issues: number;
  /** True for a component with no cards at all (kept so it can be seen, and cleaned). */
  empty: boolean;
  epics: JiraTreeEpic[];
  /** Cards in this component with no parent epic. */
  noEpic: number;
}

export interface JiraSpaceTree {
  space: string;
  /** Epic-less cards of the space, counted once, under "No epic". */
  noEpic: number;
  /** Components in Jira's order, "No component" last when it holds anything. */
  components: JiraTreeComponent[];
  /** Cards of the space, each counted once. */
  total: number;
  done: number;
  /** Epics in the Done category were left out. */
  hidDone: number;
  /** When Jira was last asked, epoch ms. */
  readAt: number;
}

/** GET /jira/space-tree?space=KEY&fresh=0|1&showDone=0|1 — a failure is that space's own, never the whole answer's. */
export type JiraSpaceTreeOut =
  | ({ ok: true } & JiraSpaceTree)
  | { ok: false; error: string; throttled?: boolean; staleAt?: number };

/** One card of an epic's list: the common shape plus the sub-tasks that hang from it. */
export interface JiraEpicCard {
  task: ProviderTask;
  /** Issue type name ("Story", "Bug"). */
  type: string;
  subtasks: ProviderTask[];
  /** Blocked cards sort near the top. */
  blocked: boolean;
}

/** GET /jira/epic-cards?epic=KEY */
export type JiraEpicCardsOut =
  | { ok: true; epic: string; cards: JiraEpicCard[]; readAt: number }
  | { ok: false; error: string; throttled?: boolean };

/** What "Add to the sidebar" can do with a pasted address: the default first. */
export interface JiraAddChoice {
  kind: "board" | "filter" | "jql" | "space";
  id: string;
  /** The label the dialog shows on the button. */
  label: string;
}
