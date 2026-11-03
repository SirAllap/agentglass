/*
 * The draft one worker editor holds, and the flow it becomes: pure, so the
 * editor's two commitments are asserted without a renderer — a save goes
 * through `validateFlow` and a refusal is shown instead of stored, and a new
 * role exists only when the person presses Add worker.
 *
 * Its ceiling, stated: the draft carries what the flow owns (name, stage, line,
 * prompt, chain of a role of its own, tools, reads only, the commands the role
 * may run, required, one failing arrow). Engine, model and the reviewer's
 * settings are POLICY and save through their own controls as they change.
 */
import {
  FLOW_HUES, FLOW_PROMPT_MAX, FLOW_ROUNDS_MAX, roleById, validateFlow, type Flow, type FlowRole,
} from "../../../../../shared/flow.ts";
import type { Chain } from "../../../../../shared/orchestration.ts";
import { addRole, clearFail, freshRoleId, setFail, setRequired, updateRole } from "../../../lib/flowEdit.ts";
import { ENGINE_CHOICES } from "./flowScreenCopy.ts";

export interface WorkerDraft {
  id: string;
  name: string;
  stage: string;
  does: string;
  prompt: string;
  chain: Chain;
  tools: string[];
  readsOnly: boolean;
  /** Commands this role may run that the floor refuses; one per line in the editor. */
  allow: string[];
  required: boolean;
  failTo: string;
  rounds: number;
  ico: string;
  hue: string;
}

/** Where a new role goes: on the path after `index - 1`, or only in the team. */
export type WorkerPlace = { kind: "path"; index: number } | { kind: "team" };

/**
 * The chain with a new first step. A fallback that ran the same engine and model
 * is dropped: the flow's validator refuses a repeated step, and a second try on
 * it could not answer differently.
 */
export const withFirstStep = (chain: Chain, engine: string, model: string): Chain => [
  { engine, model },
  ...chain.slice(1).filter((c) => c.engine !== engine || c.model !== model),
];

/** The sentence the editor prints, and the flow keeps Required off a role that is not on the path. */
export const REQUIRED_OFF_PATH = "Only a step on the path can be required. Put this role on the path first.";

/** The mockup's order and glyphs: Name and look first, Where it goes for a new role, and the rest after it. */
export const SECTIONS = [
  { id: "id", label: "Name and look", icon: "tag" },
  { id: "who", label: "Who does the work", icon: "users" },
  { id: "prompt", label: "Prompt", icon: "note" },
  { id: "place", label: "Where it goes", icon: "flag" },
  { id: "path", label: "What happens next", icon: "loop" },
  { id: "may", label: "What it may do", icon: "hand" },
  { id: "rules", label: "Rules that move it", icon: "gauge" },
  { id: "check", label: "Who checks this", icon: "eye" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** The prompt a new role starts with, from its name and its one line. */
export const generatedPrompt = (name: string, does: string): string =>
  `You are ${name.trim()}. ${does.trim()}\n\n- Read the handoff before you start.\n- Keep to what the handoff asks.\n- End with what you did and what is still open.`;

export function draftOf(flow: Flow, role: FlowRole): WorkerDraft {
  const edge = flow.edges.find((e) => e.on === "fail" && e.from === role.id);
  return {
    id: role.id, name: role.name, stage: role.stage, does: role.does, prompt: role.prompt,
    chain: [...(role.resolvedChain ?? role.chain)], tools: [...role.tools], readsOnly: role.readsOnly, allow: [...(role.allow ?? [])],
    required: role.required, failTo: edge?.to ?? "", rounds: edge?.maxRounds ?? 2, ico: role.ico, hue: role.hue,
  };
}

export function freshDraft(flow: Flow): WorkerDraft {
  const engine = ENGINE_CHOICES[0]!;
  return {
    id: "", name: "", stage: flow.stages[0]!.id, does: "", prompt: "",
    chain: [{ engine: engine.id, model: engine.models[0] ?? "" }], tools: ["read", "run"], readsOnly: false, allow: [],
    required: false, failTo: "", rounds: 2, ico: "terminal", hue: FLOW_HUES[flow.roster.length % FLOW_HUES.length]!,
  };
}

/** "Start from a team role": the team's fields fill the draft; the id stays new, so nothing is overwritten. */
export function draftFromTeam(flow: Flow, roleId: string, draft: WorkerDraft): WorkerDraft {
  const from = roleById(flow, roleId);
  if (!from) return draft;
  return {
    ...draft, name: from.name, stage: from.stage, does: from.does, prompt: from.prompt,
    chain: [...(from.resolvedChain ?? from.chain)], tools: [...from.tools], readsOnly: from.readsOnly, ico: from.ico, hue: from.hue,
  };
}

export type Applied = { ok: true; flow: Flow; id: string } | { ok: false; error: string };

/**
 * The flow the draft becomes, or the validator's refusal. Nothing is created
 * for a new role until this returns ok, and `flow` is never mutated.
 */
export function applyDraft(flow: Flow, draft: WorkerDraft, place: WorkerPlace | null): Applied {
  const existing = draft.id ? roleById(flow, draft.id) : undefined;
  const name = draft.name.trim();
  const does = draft.does.trim();
  if (!name || !does) return { ok: false, error: "A worker needs a name and one line about what it does." };

  let next = flow;
  let id = draft.id;
  if (existing) {
    const ownChain = !existing.policyRole && !existing.actor;
    next = updateRole(flow, existing.id, {
      name, stage: draft.stage, does, prompt: draft.prompt.trim(), tools: [...draft.tools], readsOnly: draft.readsOnly, allow: [...draft.allow],
      ico: draft.ico, hue: draft.hue,
      ...(ownChain ? { chain: [...draft.chain] } : {}),
    });
    const onPath = next.path.includes(existing.id);
    next = setRequired(next, existing.id, onPath && draft.required);
    if (onPath && !existing.actor) next = draft.failTo ? setFail(next, existing.id, draft.failTo, Math.min(draft.rounds, FLOW_ROUNDS_MAX)) : clearFail(next, existing.id);
  } else {
    id = freshRoleId(flow, name);
    const role: FlowRole = {
      id, name, does, stage: draft.stage,
      prompt: (draft.prompt.trim() || generatedPrompt(name, does)).slice(0, FLOW_PROMPT_MAX),
      chain: [...draft.chain], tools: [...draft.tools], readsOnly: draft.readsOnly, allow: [...draft.allow], required: false,
      ico: draft.ico, hue: draft.hue,
    };
    const added = addRole(flow, role, place?.kind === "path" ? place.index : undefined);
    if (!added.ok) return added;
    next = added.flow;
    if (place?.kind === "path" && draft.required) next = setRequired(next, id, true);
    if (place?.kind === "path" && draft.failTo) next = setFail(next, id, draft.failTo, Math.min(draft.rounds, FLOW_ROUNDS_MAX));
  }

  const checked = validateFlow(next);
  return checked.ok ? { ok: true, flow: checked.value, id } : { ok: false, error: checked.error };
}

/** Only the reviewing block carries the reviewer's settings; every other role points at it. */
export const showsReviewer = (role: FlowRole | null | undefined): boolean => role?.policyRole === "reviewer";

/** The name the flow gives the reviewing block, for the sentence other blocks show. */
export function reviewerName(flow: Flow): string {
  return flow.roster.find((r) => r.policyRole === "reviewer")?.name ?? "the reviewing block";
}
