/*
 * Copying ClickUp's steps onto Jira's map, away from the screen.
 *
 * Both trackers hold the same kinds of step built from the same blocks
 * (shared/stepBlocks.ts), so a copy translates VALUES, not shapes. The one value
 * that does not travel is a status: ClickUp names its own, Jira names its own,
 * and the two are matched by name — trimmed, case aside — against the statuses
 * the Jira map has already read. A name with no match is a question and never a
 * guess, because a step pointed at a status Jira does not have is a button that
 * never shows.
 *
 * Nothing is deleted. A copied step that lands where Jira already has one is a
 * clash the person answers, and "keep" leaves Jira's own step exactly as it was.
 * A block naming a ClickUp member is dropped: a member id is ClickUp's, and a
 * Jira step names Jira accounts.
 */
import type { JiraStep, MapBlock } from "../../../shared/providers.ts";
import { JIRA_KEY, type StepsPatch } from "./jiraWorkflow.ts";
import type { Step, StepKind } from "./workflowMap.ts";

/** A status ClickUp names that Jira has no status for, and the names the person can pick instead. */
export interface StatusAsk {
  kind: StepKind;
  /** The ClickUp name as its settings hold it. */
  name: string;
  /** Jira's own statuses, in the order the map lists them. */
  choices: string[];
}

/** Something a ClickUp step carries that Jira has no meaning for, said in the confirmation. */
export interface Dropped { kind: StepKind; what: string; why: string }

/** One step to copy. */
export interface CopyStep {
  kind: StepKind;
  /** Its blocks, with every status Jira has already in Jira's own spelling. */
  blocks: MapBlock[];
  /** Names still waiting on an answer: the step is not saved until each has one. */
  waiting: string[];
  /** Jira already has this placement: saved only when the person says replace. */
  clash: boolean;
}

export interface CopyPlan {
  steps: CopyStep[];
  asks: StatusAsk[];
  dropped: Dropped[];
}

/** What the person answered about one name: a Jira status to use instead, or null for "skip this step". */
export interface CopyAnswer { kind: StepKind; name: string; to: string | null }

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One key per question, for a form's state; two steps naming one status are two questions. */
export const askKey = (a: { kind: StepKind; name: string }): string => `${a.kind}:${a.name.trim().toLowerCase()}`;

const memberLine = (kind: StepKind, names: string[], one: boolean): Dropped => ({
  kind,
  what: `the ${one ? "person" : "people"} named on ClickUp's card (${names.join(", ")})`,
  why: one ? "a ClickUp member is not a Jira account" : "ClickUp members are not Jira accounts",
});

/** One block, read into Jira's words; null when nothing of it is left to do. */
function mapBlock(kind: StepKind, b: MapBlock, statuses: readonly { name: string }[], dropped: Dropped[]): { block: MapBlock | null; waiting: string[] } {
  switch (b.type) {
    case "move": {
      if (b.fallback) dropped.push({ kind, what: "ClickUp's own guess for a status", why: "Jira's statuses are your site's, so there is nothing to guess" });
      const names = b.statusNames.map((n) => statuses.find((s) => same(s.name, n))?.name ?? n.trim());
      const waiting = names.filter((n) => !statuses.some((s) => same(s.name, n)));
      return { block: { type: "move", statusNames: names, ...(b.ask ? { ask: true as const } : null) }, waiting };
    }
    case "unassign": {
      if (b.who !== "people") return { block: b, waiting: [] };
      const names = (b.people ?? []).map((p) => p.name);
      if (names.length) dropped.push(memberLine(kind, names, names.length === 1));
      /* Asking when it runs still works: the people are picked on the card, from Jira's own accounts. */
      return { block: b.ask ? { type: "unassign", who: "none", ask: true } : null, waiting: [] };
    }
    case "assign": {
      const named = [...(b.who === "person" && b.person ? [b.person.name] : []), ...((b.also ?? []).map((p) => p.name))];
      if (named.length) dropped.push(memberLine(kind, named, named.length === 1));
      if (b.ask) return { block: { type: "assign", who: "none", ask: true }, waiting: [] };
      return { block: b.who === "person" ? null : b, waiting: [] };
    }
    default: return { block: b, waiting: [] };
  }
}

/** What a copy would save, and what it has to ask first. Answers are not guessed: the plan is the same until they are given. */
export function copyPlan(from: readonly Step[], to: readonly Step[], statuses: readonly { name: string }[]): CopyPlan {
  const steps: CopyStep[] = [];
  const asks: StatusAsk[] = [];
  const dropped: Dropped[] = [];
  for (const s of from) {
    const clash = to.some((x) => x.kind === s.kind);
    if (s.kind === "people" || s.kind === "note") { steps.push({ kind: s.kind, blocks: [], waiting: [], clash }); continue; }
    const blocks: MapBlock[] = [];
    const waiting: string[] = [];
    for (const b of s.blocks ?? []) {
      const m = mapBlock(s.kind, b, statuses, dropped);
      if (m.block) blocks.push(m.block);
      for (const n of m.waiting) if (!waiting.includes(n)) waiting.push(n);
    }
    for (const name of waiting) asks.push({ kind: s.kind, name, choices: statuses.map((x) => x.name) });
    steps.push({ kind: s.kind, blocks, waiting, clash });
  }
  return { steps, asks, dropped };
}

/**
 * The save that copies what the person answered for. A step is left out while one of its
 * names has no answer, when the answer is "skip this step", and when it clashes with Jira's
 * own and the person said keep. Everything else lands in one patch.
 */
export function copyPatch(plan: CopyPlan, answers: readonly CopyAnswer[] = [], replace: readonly StepKind[] = []): StepsPatch {
  const out: StepsPatch = {};
  for (const st of plan.steps) {
    if (st.clash && !replace.includes(st.kind)) continue;
    const mine = answers.filter((a) => a.kind === st.kind);
    if (st.waiting.some((n) => !mine.some((a) => same(a.name, n) && a.to))) continue;
    const blocks = st.blocks.map((b) => (b.type === "move" ? { ...b, statusNames: b.statusNames.map((n) => mine.find((a) => same(a.name, n))?.to ?? n) } : b));
    out[JIRA_KEY[st.kind]] = st.kind === "people" || st.kind === "note" ? { enabled: true } : { enabled: true, blocks: blocks as JiraStep["blocks"] };
  }
  return out;
}

/** How many steps that save would copy, for the button that makes it. */
export const copyCount = (plan: CopyPlan, answers: readonly CopyAnswer[] = [], replace: readonly StepKind[] = []): number =>
  Object.keys(copyPatch(plan, answers, replace)).length;
