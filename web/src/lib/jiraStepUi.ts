/*
 * The steps a Jira card gets on a pull request: which buttons there are, what
 * they say, and what they will ask before they run. The decisions live here,
 * away from the screen, so a test can read every state.
 *
 * Words that name a status come from the saved step (the site's own names) and
 * from the card; none is written here. A step that moves the card to a status it
 * is already in offers nothing, like the hand-off before it.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { JiraHandoffRule, JiraStepKey, JiraSteps, JiraStepsRead, ProviderTask } from "../../../shared/providers.ts";
import { planOf, type StepTrigger } from "../../../shared/stepBlocks.ts";
import { NO_ASSIGN } from "./stepAssign.ts";
import { JIRA } from "./jiraWorkflow.ts";

/** Said once, where the buttons would be, while the switch is off. */
export const STEPS_OFF = "Changes in Jira are off, so a step does not run. Turn them on in Settings.";

const TRIGGER: Record<"handoff" | "review", StepTrigger> = { handoff: "move", review: "menu" };
const NAME: Record<"handoff" | "review", string> = { handoff: "Hand off", review: "Review" };

export interface StepOffer {
  key: "handoff" | "review";
  label: string;
  /** What pressing it does, in order, as a sentence for the tooltip. */
  /** This project keeps its own older hand-off rule: what the server runs is that rule, not the step's blocks. */
  byRule: boolean;
  asksStatus: boolean;
  asksClear: boolean;
  asksAssign: boolean;
  asksComment: boolean;
  /** The comment's template when it asks, to start the edit from. */
  comment: string | null;
  /** The status a fixed move goes to, when it does. */
  to: string | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What decides which rule a card is run by: its project, the projects whose older hand-off rule still wins over
 * the hand-off step (the server's `overrides`), and those rules. For such a project the server moves the card by
 * its own rule, so the button and the question say that, not what the site-wide step names.
 */
export interface RuleContext { project: string; overrides: readonly string[]; rules: Readonly<Record<string, JiraHandoffRule>> }

/** The buttons a card gets from the saved steps, in order. A step that is off, or that has nothing to do here, is not one. */
export function stepOffers(steps: JiraSteps | null, task: Pick<ProviderTask, "status">, ctx?: RuleContext): StepOffer[] {
  if (!steps) return [];
  const out: StepOffer[] = [];
  for (const key of ["handoff", "review"] as const) {
    const s = steps[key];
    if (!s.enabled || !s.blocks.length) continue;
    const plan = planOf<string | number>(TRIGGER[key], { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: s.blocks });
    // The hand-off an older per-project rule still decides is run by that rule: its status, its question, its take-off.
    const rule = key === "handoff" && ctx && ctx.overrides.includes(ctx.project) ? ctx.rules[ctx.project] : undefined;
    const asksStatus = rule ? rule.askTo : plan.move?.ask === true;
    const to = !asksStatus ? (rule ? rule.to?.name : plan.move?.names[0]) ?? null : null;
    // Already where a fixed move would take it, and nothing else for the step to do.
    const onlyMove = !plan.comment && !plan.link && (rule ? !rule.clear && !rule.askClear : plan.unassign === "none") && (rule || (plan.assign.who === "none" && !plan.askAssign && !plan.askUnassign && plan.takeOff.length === 0));
    if (to && onlyMove && task.status && same(task.status, to)) continue;
    out.push({
      key, to, byRule: !!rule,
      label: to ? `${JIRA.nouns.move} ${to}` : `${NAME[key]}${asksStatus || (!rule && (plan.askAssign || plan.askUnassign)) || (rule && rule.askClear) || plan.comment?.ask ? "…" : ""}`,
      asksStatus, asksClear: rule ? rule.askClear : plan.askUnassign !== null, asksAssign: rule ? false : plan.askAssign !== null, asksComment: plan.comment?.ask === true,
      comment: plan.comment?.ask ? plan.comment.text : null,
    });
  }
  return out;
}

/** Does pressing this open a question first? Every step confirms; this says whether there is more to choose. */
export const hasQuestions = (o: StepOffer): boolean => o.asksStatus || o.asksClear || o.asksAssign || o.asksComment;

// --- the saved steps, read once and shared ------------------------------------

let held: JiraStepsRead | null = null;
let asking: Promise<JiraStepsRead | null> | null = null;
const subs = new Set<(s: JiraStepsRead | null) => void>();

export function loadJiraSteps(): Promise<JiraStepsRead | null> {
  if (held) return Promise.resolve(held);
  asking ??= api.jiraSteps().then((r) => (r?.ok && r.steps ? { steps: r.steps, overrides: r.overrides ?? [] } : null)).catch(() => null).then((s) => { asking = null; if (s) noteJiraSteps(s); return s; });
  return asking;
}

/** What the Settings page saved, or the server answered: every reader redraws from it. */
export function noteJiraSteps(s: JiraStepsRead): void {
  held = s;
  for (const f of subs) f(s);
}

export function useJiraSteps(): JiraStepsRead | null {
  const [s, setS] = useState<JiraStepsRead | null>(held);
  useEffect(() => {
    subs.add(setS);
    void loadJiraSteps();
    return () => { subs.delete(setS); };
  }, []);
  return s;
}

/** Test seam: the module keeps what it read for the window's life. */
export function __forgetJiraSteps(): void { held = null; asking = null; }

export type { JiraStepKey };
