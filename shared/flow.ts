/*
 * The flow: the steps a project's orchestrator follows, as data a person edits.
 *
 * Types and one closed-schema validator, nothing that reads a file or a clock,
 * so every rule is asserted without a server. The screens draw this; the
 * orchestrator is told it; neither keeps a list of its own.
 *
 * What is not here: an engine or a model on a built-in role. A role of the
 * kind the policy already knows names `policyRole` and its chain is the
 * policy's, resolved when the flow is read (`resolvedChain`, never saved); a
 * role a person makes owns its `chain` here.
 */
import { ROLE_IDS, closed, looksLikeSecret, validChain, type Chain, type Validated } from "./orchestration.ts";
import { NEVER_LIFTABLE, type RoleId } from "./workerRoles.ts";

export interface FlowRole {
  /** Unique inside one flow, and never reused for another role. */
  id: string;
  name: string;
  /** One line under the name: what the role does, on the block and in the roster. */
  does: string;
  /** What it does and what it hands back, in the person's words. */
  prompt: string;
  /** A built-in role: the orchestration policy owns its chain. */
  policyRole?: RoleId;
  /** Its own chain when it is not a built-in; empty where a person answers. */
  chain: Chain;
  tools: string[];
  readsOnly: boolean;
  /** Command prefixes this role may run that the floor refuses, `docker` or
   *  `make deploy`; never one of `NEVER_LIFTABLE`. */
  allow?: string[];
  /** The orchestrator must not skip this step when it is on the path. */
  required: boolean;
  /** An id from `stages`. */
  stage: string;
  /** The block's icon name and colour token, chosen by the person and drawn as
   *  it is. `hue` is a token name: the screen reads `var(--<hue>)`. */
  ico: string;
  hue: string;
  /** A person answers at this step; nothing runs. */
  actor?: "person";
  /** Read from the policy, never saved. */
  resolvedChain?: Chain;
}

export interface FlowStage {
  id: string;
  label: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** `pass` moves on; `fail` goes back. Never a boolean: the screen says fail. */
  on: "pass" | "fail";
  /** Only on a `fail` edge: how many times it may go round before a person is asked. */
  maxRounds?: number;
}

/** Where a person put one role on the canvas. A role without a block is in the team and not on the path. */
export interface FlowBlock {
  id: string;
  x: number;
  y: number;
}

export interface Flow {
  version: 1;
  /** Role ids in the suggested order. */
  path: string[];
  blocks: FlowBlock[];
  /** Every role of the team, those off the path included. */
  roster: FlowRole[];
  stages: FlowStage[];
  edges: FlowEdge[];
}

export const FLOW_MAX_ROLES = 24;
export const FLOW_MAX_STAGES = 12;
export const FLOW_MAX_EDGES = 40;
export const FLOW_MAX_TOOLS = 12;
export const FLOW_MAX_ALLOW = 8;
export const FLOW_PROMPT_MAX = 2000;
export const FLOW_NAME_MAX = 60;
export const FLOW_DOES_MAX = 200;
export const FLOW_ROUNDS_MAX = 12;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/'()+\u00b7-]{0,59}$/;
const DOES_RE = /^[A-Za-z0-9][A-Za-z0-9 .,;:'’()/&!?+-]{0,199}$/;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/+@-]{0,39}$/;
/** The shape `Envelope.deny` takes (orchestration.ts's PREFIX_RE), copied so a
 *  grant is read the same way as a refusal. */
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._ /-]{0,39}$/;

/** The icons and colour tokens the mockup draws, one closed set each: a name
 *  outside them is a typo that would paint the fallback icon without saying so.
 *  These are the mockup's twenty-six picker glyphs, in its own order. */
export const FLOW_ICONS = ["star", "rocket", "planet", "comet", "moon", "telescope", "satellite", "radar", "lantern", "bug", "bolt", "database", "terminal", "branch", "hourglass", "spark", "chart", "rover", "lens", "preflight", "lander", "beaker", "shieldstar", "dish", "logbook", "dock"] as const;
/** The names the flow drew before the mockup's set, each and the nearest glyph
 *  it has now: a role saved in that build is read, not thrown away. */
export const FLOW_ICON_WAS: Readonly<Record<string, string>> = {
  compass: "chart", wrench: "rover", eye: "lens", flask: "beaker", check: "preflight",
  flag: "lander", loop: "hourglass", server: "dish", shield: "shieldstar",
  panes: "terminal", code: "database", git: "branch", rocket: "rocket", map: "logbook",
};
export function flowIconName(name: string): string {
  return FLOW_ICON_WAS[name] ?? name;
}
export const FLOW_HUES = ["g-agents", "g-workspace", "g-library", "g-general", "g-connections", "success", "warning", "error"] as const;

const bad = (field: string, what: string): { ok: false; error: string } => ({ ok: false, error: `${field}: ${what}` });
const failed = (r: unknown): r is { ok: false; error: string } =>
  !!r && typeof r === "object" && (r as { ok?: unknown }).ok === false && typeof (r as { error?: unknown }).error === "string";

const ROLE_KEYS = ["id", "name", "does", "prompt", "policyRole", "chain", "tools", "readsOnly", "allow", "required", "stage", "ico", "hue", "actor", "resolvedChain"] as const;
const ROLE_REQUIRED = ["id", "name", "does", "prompt", "chain", "tools", "readsOnly", "required", "stage", "ico", "hue"] as const;

function wholeIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

function validName(v: unknown, field: string): Validated<string> {
  if (typeof v !== "string") return bad(field, "has to be text");
  const s = v.trim();
  if (!s) return bad(field, "is empty");
  if (s.length > FLOW_NAME_MAX) return bad(field, `is longer than ${FLOW_NAME_MAX} characters`);
  if (!NAME_RE.test(s)) return bad(field, "has to be letters, digits, spaces and . _ : / ' ( ) · + - only");
  if (looksLikeSecret(s)) return bad(field, "looks like a key; a name is all this field takes");
  return { ok: true, value: s };
}

function validTools(v: unknown, field: string): Validated<string[]> {
  if (!Array.isArray(v)) return bad(field, "has to be a list of tool names");
  if (v.length > FLOW_MAX_TOOLS) return bad(field, `takes at most ${FLOW_MAX_TOOLS} tools, it has ${v.length}`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const t = v[i];
    if (typeof t !== "string" || !TOOL_RE.test(t.trim())) return bad(`${field}[${i}]`, "is not a tool name");
    if (looksLikeSecret(t)) return bad(`${field}[${i}]`, "looks like a key; tool names only");
    if (out.includes(t.trim())) return bad(`${field}[${i}]`, "repeats a tool the role already has");
    out.push(t.trim());
  }
  return { ok: true, value: out };
}

/**
 * The commands a role may run that the floor refuses. A prefix of a never-liftable
 * command is refused by name rather than dropped, so a save that asks for one is
 * answered instead of quietly narrowed.
 */
function validAllow(v: unknown, field: string): Validated<string[]> {
  if (!Array.isArray(v)) return bad(field, "has to be a list of command prefixes");
  if (v.length > FLOW_MAX_ALLOW) return bad(field, `takes at most ${FLOW_MAX_ALLOW} commands, it has ${v.length}`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const t = v[i];
    if (typeof t !== "string" || !COMMAND_RE.test(t.trim())) return bad(`${field}[${i}]`, "is not a command prefix (letters, digits, . _ / - and single spaces)");
    if (looksLikeSecret(t)) return bad(`${field}[${i}]`, "looks like a key; a command prefix is all this field takes");
    const c = t.trim();
    const never = NEVER_LIFTABLE.find((n) => c === n || c.startsWith(`${n} `));
    if (never) return bad(`${field}[${i}]`, `"${never}" is never granted to a worker, whatever its role: that is done by a person`);
    if (out.includes(c)) return bad(`${field}[${i}]`, "repeats a command the role already has");
    out.push(c);
  }
  return { ok: true, value: out };
}

/**
 * Check a whole flow. Every refusal names the field and says what a person
 * would have to do about it; no stack names reach the screen.
 */
export function validateFlow(raw: unknown): Validated<Flow> {
  const top = closed(raw, "flow", ["version", "path", "blocks", "roster", "stages", "edges"]);
  if (failed(top)) return top;
  if (top.version !== 1) return bad("flow.version", "has to be 1");

  const stages = top.stages;
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > FLOW_MAX_STAGES) {
    return bad("flow.stages", `needs 1 to ${FLOW_MAX_STAGES} stages, it has ${Array.isArray(stages) ? stages.length : 0}`);
  }
  const stageIds: string[] = [];
  const stagesOut: FlowStage[] = [];
  for (let i = 0; i < stages.length; i++) {
    const o = closed(stages[i], `flow.stages[${i}]`, ["id", "label"]);
    if (failed(o)) return o;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return bad(`flow.stages[${i}].id`, "has to be lower-case letters, digits and -");
    if (stageIds.includes(o.id)) return bad(`flow.stages[${i}].id`, `"${o.id}" is used by another stage`);
    const label = validName(o.label, `flow.stages[${i}].label`);
    if (!label.ok) return label;
    stageIds.push(o.id);
    stagesOut.push({ id: o.id, label: label.value });
  }

  const roster = top.roster;
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > FLOW_MAX_ROLES) {
    return bad("flow.roster", `needs 1 to ${FLOW_MAX_ROLES} roles, it has ${Array.isArray(roster) ? roster.length : 0}`);
  }
  const roles: FlowRole[] = [];
  for (let i = 0; i < roster.length; i++) {
    const at = `flow.roster[${i}]`;
    const o = closed(roster[i], at, ROLE_KEYS, ROLE_REQUIRED);
    if (failed(o)) return o;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return bad(`${at}.id`, "has to be lower-case letters, digits and -");
    if (roles.some((r) => r.id === o.id)) return bad(`${at}.id`, `"${o.id}" is already another role; two roles cannot share one id`);
    const name = validName(o.name, `${at}.name`);
    if (!name.ok) return name;
    if (typeof o.does !== "string") return bad(`${at}.does`, "has to be one line of text");
    const does = o.does.trim();
    if (!does) return bad(`${at}.does`, "is empty; one line says what this role does");
    if (does.length > FLOW_DOES_MAX) return bad(`${at}.does`, `is longer than ${FLOW_DOES_MAX} characters; the block shows one line`);
    if (!DOES_RE.test(does)) return bad(`${at}.does`, "has to be one line of letters, digits and . , ; : ' ( ) / & ! ? + - only");
    if (looksLikeSecret(does)) return bad(`${at}.does`, "looks like a key; a sentence is all this field takes");
    if (typeof o.prompt !== "string") return bad(`${at}.prompt`, "has to be text");
    const prompt = o.prompt.trim();
    if (!prompt) return bad(`${at}.prompt`, "is empty; a role says what it does and what it hands back");
    if (prompt.length > FLOW_PROMPT_MAX) return bad(`${at}.prompt`, `is longer than ${FLOW_PROMPT_MAX} characters`);
    if (typeof o.readsOnly !== "boolean") return bad(`${at}.readsOnly`, "has to be yes or no");
    if (typeof o.required !== "boolean") return bad(`${at}.required`, "has to be yes or no");
    if (typeof o.stage !== "string" || !stageIds.includes(o.stage)) return bad(`${at}.stage`, "is not one of the stages");
    if (typeof o.ico !== "string") return bad(`${at}.ico`, "is not one of the icons a block draws");
    const ico = flowIconName(o.ico);
    if (!FLOW_ICONS.includes(ico as (typeof FLOW_ICONS)[number])) return bad(`${at}.ico`, "is not one of the icons a block draws");
    if (typeof o.hue !== "string" || !FLOW_HUES.includes(o.hue as (typeof FLOW_HUES)[number])) return bad(`${at}.hue`, "is not one of the colour tokens a block draws");
    if (o.policyRole !== undefined && (typeof o.policyRole !== "string" || !ROLE_IDS.includes(o.policyRole as RoleId))) {
      return bad(`${at}.policyRole`, "is not a worker role agentglass knows");
    }
    if (o.actor !== undefined && o.actor !== "person") return bad(`${at}.actor`, 'is either "person" or left out');
    if (o.actor === "person" && o.policyRole !== undefined) return bad(`${at}.actor`, "and policyRole cannot both be set: a person answers this step, nothing runs");
    const chain = validChainOrNone(o.chain, `${at}.chain`);
    if (failed(chain)) return chain;
    if (o.policyRole !== undefined || o.actor === "person") {
      /* A built-in's chain comes from the policy on every read, and a person's
         step runs nothing: storing a chain here would be a second answer. */
      if (chain.value.length) return bad(`${at}.chain`, o.actor === "person" ? "has to be empty: a person answers this step" : "has to be empty: a built-in role's chain is the policy's, read when the flow is read");
    } else if (!chain.value.length) {
      return bad(`${at}.chain`, "needs at least one engine and model: this role is not a built-in and the policy has no chain for it");
    }
    if (o.resolvedChain !== undefined && !Array.isArray(o.resolvedChain)) return bad(`${at}.resolvedChain`, "has to be a list; it is read from the policy and never saved");
    const tools = validTools(o.tools, `${at}.tools`);
    if (!tools.ok) return tools;
    const allow = o.allow === undefined ? { ok: true as const, value: [] } : validAllow(o.allow, `${at}.allow`);
    if (!allow.ok) return allow;
    const role: FlowRole = {
      id: o.id, name: name.value, does, prompt, chain: chain.value, tools: tools.value,
      readsOnly: o.readsOnly, required: o.required, stage: o.stage,
      ico, hue: o.hue as string,
    };
    if (allow.value.length) role.allow = allow.value;
    if (o.policyRole !== undefined) role.policyRole = o.policyRole as RoleId;
    if (o.actor === "person") role.actor = "person";
    roles.push(role);
  }

  const path = top.path;
  if (!Array.isArray(path) || path.length < 1) return bad("flow.path", "needs at least one step");
  if (path.length > roles.length) return bad("flow.path", `names ${path.length} steps and the team has ${roles.length} roles`);
  const onPath: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    if (typeof id !== "string" || !roles.some((r) => r.id === id)) return bad(`flow.path[${i}]`, "names a role the team does not have");
    if (onPath.includes(id)) return bad(`flow.path[${i}]`, `"${id}" is on the path twice; a step runs once in one order`);
    onPath.push(id);
  }
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i]!;
    if (r.required && !onPath.includes(r.id)) {
      return bad(`flow.roster[${i}].required`, `"${r.id}" is not on the suggested path, and a step nobody runs cannot be required`);
    }
  }

  const blocks = top.blocks;
  if (!Array.isArray(blocks)) return bad("flow.blocks", "has to be a list of places");
  const blocksOut: FlowBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const o = closed(blocks[i], `flow.blocks[${i}]`, ["id", "x", "y"]);
    if (failed(o)) return o;
    if (typeof o.id !== "string" || !roles.some((r) => r.id === o.id)) return bad(`flow.blocks[${i}].id`, "names a role the team does not have");
    if (blocksOut.some((b) => b.id === o.id)) return bad(`flow.blocks[${i}].id`, `"${o.id}" has a place already`);
    if (!wholeIn(o.x, 0, 100000) || !wholeIn(o.y, 0, 100000)) return bad(`flow.blocks[${i}]`, "needs a whole x and y, 0 or more");
    blocksOut.push({ id: o.id, x: o.x, y: o.y });
  }

  const edges = top.edges;
  if (!Array.isArray(edges)) return bad("flow.edges", "has to be a list of arrows");
  if (edges.length > FLOW_MAX_EDGES) return bad("flow.edges", `takes at most ${FLOW_MAX_EDGES} arrows, it has ${edges.length}`);
  const edgesOut: FlowEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const at = `flow.edges[${i}]`;
    const o = closed(edges[i], at, ["from", "to", "on", "maxRounds"], ["from", "to", "on"]);
    if (failed(o)) return o;
    if (typeof o.from !== "string" || !onPath.includes(o.from)) return bad(`${at}.from`, "names a step that is not on the suggested path");
    if (typeof o.to !== "string") return bad(`${at}.to`, "has to be a step");
    if (o.to === o.from) return bad(`${at}.to`, "is the step the arrow leaves; an arrow back to itself says nothing");
    if (typeof o.to === "string" && !onPath.includes(o.to)) return bad(`${at}.to`, "names a step that is not on the suggested path");
    if (o.on !== "pass" && o.on !== "fail") return bad(`${at}.on`, 'is "pass" or "fail"');
    if (o.on === "fail") {
      if (o.maxRounds === undefined) return bad(`${at}.maxRounds`, "is missing; a failing arrow needs a cap, or it goes round for ever and nobody is asked");
      if (!wholeIn(o.maxRounds, 1, FLOW_ROUNDS_MAX)) return bad(`${at}.maxRounds`, `has to be a whole number from 1 to ${FLOW_ROUNDS_MAX}`);
    } else if (o.maxRounds !== undefined) {
      return bad(`${at}.maxRounds`, "belongs to a failing arrow; a passing step moves on");
    }
    if (edgesOut.some((e) => e.from === o.from && e.to === o.to && e.on === o.on)) return bad(at, "says what another arrow already says");
    const edge: FlowEdge = { from: o.from, to: o.to as string, on: o.on };
    if (o.on === "fail") edge.maxRounds = o.maxRounds as number;
    edgesOut.push(edge);
  }

  return { ok: true, value: { version: 1, path: onPath, blocks: blocksOut, roster: roles, stages: stagesOut, edges: edgesOut } };
}

/** A chain, or an empty list: a built-in and a person's step both store none. */
function validChainOrNone(v: unknown, field: string): Validated<Chain> {
  if (Array.isArray(v) && v.length === 0) return { ok: true, value: [] };
  return validChain(v, field);
}

export const roleById = (flow: Flow, id: string): FlowRole | undefined => flow.roster.find((r) => r.id === id);

/** The roles of the suggested path, in order. */
export function pathRoles(flow: Flow): FlowRole[] {
  return flow.path.map((id) => roleById(flow, id)).filter((r): r is FlowRole => !!r);
}

/** The one chain a role runs on, read from the policy for a built-in. */
export const chainOf = (role: FlowRole): Chain => role.resolvedChain ?? role.chain;

/**
 * Whether the Verifier is on the canvas: a block placed for the role whose kind
 * is `verifier`. A roster entry nobody placed is in the team, not on the path.
 */
export const hasVerifierBlock = (flow: Flow): boolean => {
  const placed = new Set(flow.blocks.map((b) => b.id));
  return flow.roster.some((r) => placed.has(r.id) && r.policyRole === "verifier");
};
