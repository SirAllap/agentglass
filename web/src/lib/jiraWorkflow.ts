/*
 * Jira's side of the workflow map: how its saved steps read as steps, and what
 * saving a change to one sends.
 *
 * Jira's steps are global to the site and held by status NAME (shared/providers.ts,
 * `JiraSteps`): three places, each with a list of blocks. There is no reviewer list
 * or note button, which are ClickUp's own settings. A project's older hand-off rule
 * is read into the hand-off step by the server; nothing is migrated here.
 */
import type { JiraSteps, JiraStep } from "../../../shared/providers.ts";
import { planOf, type StepTrigger } from "../../../shared/stepBlocks.ts";
import type { MapBlock } from "../../../shared/providers.ts";
import type { Step, StepKind, TrackerAdapter } from "./workflowMap.ts";
import { NO_ASSIGN } from "./stepAssign.ts";

export const JIRA: TrackerAdapter = {
  tracker: "jira",
  nouns: { name: "Jira", workspace: "site", space: "project", spaces: "projects", list: "project", lists: "projects", item: "card", items: "cards", move: "Transition to", verb: "Transition", reviewButton: true },
  kinds: ["move", "menu", "merge"],
  /* No status is proposed for the hand-off or the review: a site's words for them are its own. The merge choice is
     proposed from the statuses that finish a card, which the site's own categories say. */
  suggest: { merge: /./ },
  /* The card drawn in the previews is invented; its status is one of the person's own, passed in by the page. */
  sample: { id: "ORBIT-1042", title: "Retry the webhook when the queue is full", status: "", who: "Ada Test", others: "Sam Rivera" },
};

/** Where a step is kept, by the kind the map calls it. */
export const JIRA_KEY = { move: "handoff", menu: "review", merge: "merge" } as const;
type Kind = keyof typeof JIRA_KEY;
const TRIGGER: Record<Kind, StepTrigger> = { move: "move", menu: "menu", merge: "merge" };

/** A settings patch, in the shape `POST /jira/steps` takes. */
export type StepsPatch = Partial<Record<(typeof JIRA_KEY)[Kind], Partial<JiraStep>>>;

/** The blocks are read once into the fields the lines, the pins and the coverage use. */
function blockStep(kind: Kind, s: JiraStep): Step {
  const plan = planOf<string | number>(TRIGGER[kind], { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: s.blocks });
  const names = plan.move?.names ?? [];
  return { kind, status: names[0] ?? null, also: names.slice(1), unassign: plan.unassign, assign: plan.assign as Step["assign"], blocks: s.blocks as MapBlock[], implicit: false };
}

/** The steps this site has, in the order the map lists them. */
export const jiraSteps = (all: JiraSteps): Step[] =>
  (Object.keys(JIRA_KEY) as Kind[]).filter((k) => all[JIRA_KEY[k]].enabled).map((k) => blockStep(k, all[JIRA_KEY[k]]));

const isKind = (k: StepKind): k is Kind => Object.hasOwn(JIRA_KEY, k);

/** Add a step. It starts empty: nothing is chosen for the person. */
export const jiraAdd = (kind: StepKind): StepsPatch => (isKind(kind) ? { [JIRA_KEY[kind]]: { enabled: true, blocks: [] } } : {});
/** Replace a step's blocks, in the order given. */
export const jiraBlocks = (kind: StepKind, blocks: MapBlock[]): StepsPatch => (isKind(kind) ? { [JIRA_KEY[kind]]: { blocks: blocks as JiraStep["blocks"] } } : {});
/** Take a step away, and whatever it had chosen with it. */
export const jiraRemove = (kind: StepKind): StepsPatch => (isKind(kind) ? { [JIRA_KEY[kind]]: { enabled: false, blocks: [] } } : {});
