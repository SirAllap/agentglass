/*
 * Jira's side of the workflow map: how its saved steps read as steps, and what
 * saving a change to one sends.
 *
 * Jira's steps are global to the site and held by status NAME (shared/providers.ts,
 * `JiraSteps`): the hand-off, the review and the merge choice, each with a list of
 * blocks, plus the two single controls ClickUp has — the assigned list and the note
 * button. A project's older hand-off rule is read into the hand-off step by the
 * server; nothing is migrated here.
 */
import type { JiraSteps, JiraStep } from "../../../shared/providers.ts";
import { planOf, type StepTrigger } from "../../../shared/stepBlocks.ts";
import type { MapBlock } from "../../../shared/providers.ts";
import type { Step, StepKind, TrackerAdapter } from "./workflowMap.ts";
import { STEP_ORDER } from "./workflowMap.ts";
import { NO_ASSIGN } from "./stepAssign.ts";
import { api } from "./api.ts";

export const JIRA: TrackerAdapter = {
  tracker: "jira",
  nouns: { name: "Jira", workspace: "site", space: "project", spaces: "projects", list: "project", lists: "projects", item: "card", items: "cards", move: "Transition to", verb: "Transition", reviewButton: true },
  kinds: STEP_ORDER,
  /* No status is proposed for the hand-off or the review: a site's words for them are its own. The merge choice is
     proposed from the statuses that finish a card, which the site's own categories say. */
  suggest: { merge: /./ },
  /* The card drawn in the previews is invented; its status is one of the person's own, passed in by the page. */
  sample: { id: "ORBIT-1042", title: "Retry the webhook when the queue is full", status: "", who: "Ada Test", others: "Sam Orbit" },
};

/**
 * Jira's status categories in the house's colours, so a dot follows the theme: a status that has
 * not started is the quiet slate, one in progress is amber, one that finishes a card is green.
 * Jira's own hexes (blue-gray, yellow, green) are not used; the site sends the category, the app
 * decides how it looks.
 */
export const JIRA_STATUS_DOT: Record<string, string> = { open: "var(--text3)", custom: "var(--warning)", done: "var(--success)" };
export const jiraDotColour = (type: string): string => JIRA_STATUS_DOT[type] ?? "var(--text3)";

/** Where a step is kept, by the kind the map calls it. */
export const JIRA_KEY = { move: "handoff", menu: "review", merge: "merge", people: "people", note: "note" } as const;
type Kind = keyof typeof JIRA_KEY;
/** The kinds a step is built from blocks; the other two are single controls with none. */
type Built = "move" | "menu" | "merge";
const TRIGGER: Record<Built, StepTrigger> = { move: "move", menu: "menu", merge: "merge" };

/** A settings patch, in the shape `POST /jira/steps` takes. */
export type StepsPatch = Partial<Record<(typeof JIRA_KEY)[Kind], Partial<JiraStep>>>;

/** The blocks are read once into the fields the lines, the pins and the coverage use. */
function blockStep(kind: Built, s: JiraStep): Step {
  const plan = planOf<string | number>(TRIGGER[kind], { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: s.blocks });
  const names = plan.move?.names ?? [];
  return { kind, status: names[0] ?? null, also: names.slice(1), unassign: plan.unassign, assign: plan.assign as Step["assign"], blocks: s.blocks as MapBlock[], implicit: false };
}

/** The single controls: on or off, and what they do is the panel's own. */
const plain = (kind: Kind): Step => ({ kind, status: null, also: [], unassign: "none", assign: NO_ASSIGN as Step["assign"], implicit: false });

/** The steps this site has, in the order the map lists them. */
export const jiraSteps = (all: JiraSteps): Step[] =>
  STEP_ORDER.filter((k) => all[JIRA_KEY[k]].enabled).map((k) => (k === "people" || k === "note" ? plain(k) : blockStep(k, all[JIRA_KEY[k]])));

const isKind = (k: StepKind): k is Kind => Object.hasOwn(JIRA_KEY, k);

/** Add a step. It starts empty: nothing is chosen for the person. The two single controls are only on. */
export const jiraAdd = (kind: StepKind): StepsPatch => (isKind(kind) ? { [JIRA_KEY[kind]]: kind === "people" || kind === "note" ? { enabled: true } : { enabled: true, blocks: [] } } : {});
/** Replace a step's blocks, in the order given. The single controls have none. */
export const jiraBlocks = (kind: StepKind, blocks: MapBlock[]): StepsPatch => (kind === "move" || kind === "menu" || kind === "merge" ? { [JIRA_KEY[kind]]: { blocks: blocks as JiraStep["blocks"] } } : {});
/** Take a step away, and whatever it had chosen with it. */
export const jiraRemove = (kind: StepKind): StepsPatch => (isKind(kind) ? { [JIRA_KEY[kind]]: kind === "people" || kind === "note" ? { enabled: false } : { enabled: false, blocks: [] } } : {});

/**
 * The site's custom fields, by name, for a "Set a field" block: the picker offers
 * what the site has instead of asking a person to type a name that may not exist.
 * Null when they could not be read, which the editor says rather than guesses.
 */
export async function jiraFields(): Promise<{ name: string; type: string }[] | null> {
  const r = await api.jiraFields().catch(() => null);
  return r?.ok ? (r.fields ?? []) : null;
}
