/*
 * A preset: one named setup a person saves, shares and applies, as a validated
 * `.agxpreset` file.
 *
 * It carries what agentglass can honour and nothing else: the flow (the path,
 * the places, the stages, the arrows and the team) and the policy parts a setup
 * is made of (the engines, the rounds, the limits, the rules, the safety and the
 * project's own refusals). There is no second `workers` map: names, prompts,
 * tools and chains live on the flow's roles, and engines and limits live on the
 * policy, so a preset holds each of them once.
 *
 * `includes` says which parts a file carries and a press applies. A part that is
 * switched off is not written into the file at all — a prompt may mention a
 * path or a habit — and `applyPreset` refuses to apply a part the file was not
 * shared with, so a missing prompt can never come back as a placeholder.
 *
 * What can never be in one, and is written into every file: keys, sign-ins,
 * projects, paths, history, and the shipped always-refused list. A preset cannot
 * grant network or a push: it has no field for either, and a safety part wider
 * than the ceiling already in force is refused with a sentence rather than
 * applied. Applying is a pure function; the page saves what it returns through
 * the routes it already uses.
 */
import {
  ROLE_IDS, closed, envelopeWithin, looksLikeSecret, validChain, validEnvelope, validLimits, validPolicyRules,
  validatePolicy, type Chain, type Envelope, type Policy, type PolicyRule, type Validated,
} from "./orchestration.ts";
import { validateFlow, type Flow, type FlowEdge, type FlowRole } from "./flow.ts";
import type { RoleId } from "./workerRoles.ts";

export const PRESET_FORMAT = "agentglass-preset";
export const PRESET_VERSION = 1;
export const PRESETS_MAX = 20;
export const PRESET_NAME_MAX = 60;

/** The parts a setup is made of, in the order a person reads them. */
export const PRESET_PARTS = ["flow", "look", "prompts", "eng", "fb", "lim", "rules", "safety", "refused", "team"] as const;
export type PresetPart = (typeof PRESET_PARTS)[number];

/** What each part carries, in the words of the share sheet. */
export const PRESET_PART_WORDS: Readonly<Record<PresetPart, { label: string; hint: string }>> = {
  flow: { label: "The flow", hint: "The steps, their order, the stages and where each one goes on pass and on fail." },
  look: { label: "Names, icons and colours", hint: "How each worker reads on the canvas and in the team." },
  prompts: { label: "Prompts and tools", hint: "What each worker is told at the start of a turn, and which tools it may use." },
  eng: { label: "Engines and models", hint: "Which engine and model each worker and the main agent runs on." },
  fb: { label: "Fallbacks and rounds", hint: "What a role tries next, and how many rounds a failing arrow gets before it asks." },
  lim: { label: "Limits", hint: "Workers at once, minutes per turn and retries with the next engine." },
  rules: { label: "Rules that move roles", hint: "The conditions, such as a plan running low moving the builders." },
  safety: { label: "Safety and permissions", hint: "What a worker may do by default, and the most the main agent may allow." },
  refused: { label: "Also refused here", hint: "Commands refused on top of the shipped list. The shipped list is never in a file." },
  team: { label: "Team roles off the path", hint: "The roles kept in the team with no place on the path." },
};

/** Parts a mockup file may name that this build has no setting for: refused by name, never dropped. */
const NO_HOME: Readonly<Record<string, string>> = {
  orch: "the orchestrator's standing notes have no setting here; leave \"orch\" out of the file",
};

export const PRESET_NEVER_INCLUDED: readonly string[] = [
  "keys", "sign-ins", "projects", "paths", "history", "the shipped always-refused commands",
];

export interface PresetFile {
  format: typeof PRESET_FORMAT;
  version: typeof PRESET_VERSION;
  name: string;
  includes: PresetPart[];
  /** The whole flow. The parts switched off are not written into its roles. */
  flow?: Flow;
  policy?: {
    base?: { orchestrator?: Chain; workers?: Partial<Record<RoleId, Chain>> };
    rules?: PolicyRule[];
    ceiling?: Envelope;
    workerDefault?: Envelope;
    limits?: Policy["limits"];
  };
  /** The project's own prefixes, on top of the shipped list. It only ever adds. */
  alsoRefusedHere?: string[];
  neverIncluded?: string[];
}

/** What a preset applies to: the policy and the flow in force, the flow absent under All projects with none. */
export interface PresetTarget { policy: Policy; flow: Flow | null }

const bad = (field: string, what: string): { ok: false; error: string } => ({ ok: false, error: `${field}: ${what}` });
const failed = (r: unknown): r is { ok: false; error: string } =>
  !!r && typeof r === "object" && (r as { ok?: unknown }).ok === false && typeof (r as { error?: unknown }).error === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/'()+\u00b7-]{0,59}$/;

/** The fields a file may leave out because a part was switched off, and what the flow validator sees while it checks one that did. */
const PLACEHOLDER: Readonly<Record<string, unknown>> = {
  name: "Role", does: "A role in this setup.", ico: "chart", hue: "g-general", prompt: "Say what this role does.", tools: [],
};

/** The part each of those fields belongs to, so a missing one is only excused when its part is off. */
const ROLE_FIELD_PART: Readonly<Record<string, PresetPart>> = {
  name: "look", does: "look", ico: "look", hue: "look", prompt: "prompts", tools: "prompts",
};

/** What a flow without its own structure is checked against: one stage, the first role on the path, no blocks and no arrows. */
const PROBE_STAGE = "stage";
const PROBE_CHAIN: Chain = [{ engine: "opencode", model: "" }];

/** The parts a flow's data belongs to; the flow key is present whenever any of them is. */
export const PRESET_FLOW_PARTS: readonly PresetPart[] = ["flow", "look", "prompts", "fb", "team"];

/** The parts a setup can apply with no project above it: everything but the flow's. */
export function presetPolicyParts(includes: readonly PresetPart[]): PresetPart[] {
  return includes.filter((p) => !PRESET_FLOW_PARTS.includes(p));
}

/**
 * The parts of `asked` this preset can be written with. A part is carried only when the preset holds it — the
 * flow for every flow part — so the share panel offers no combination, and `withoutParts` writes none, that
 * this module's own importer refuses.
 */
export function presetWritableParts(preset: PresetFile, asked: readonly PresetPart[] = preset.includes): PresetPart[] {
  return PRESET_PARTS.filter((p) => asked.includes(p) && preset.includes.includes(p) && (!PRESET_FLOW_PARTS.includes(p) || preset.flow !== undefined));
}

/** Whether a shipped setup already wears this name: a person's card would hide one of ours. */
export function presetNameTaken(name: string, shipped: readonly { name: string }[]): boolean {
  return shipped.some((p) => p.name === name);
}

/**
 * The parts "save mine" writes. Under All projects they are the ones every project shares: a flow belongs to one
 * project, so a setup saved there must not carry the roster of whichever project the page happened to read.
 */
export function presetSaveParts(hasProject: boolean): PresetPart[] {
  return hasProject ? [...PRESET_PARTS] : presetPolicyParts(PRESET_PARTS);
}

function validName(v: unknown): Validated<string> {
  if (typeof v !== "string") return bad("name", "has to be text");
  const s = v.trim();
  if (!s) return bad("name", "is empty; a preset has a name a person reads");
  if (s.length > PRESET_NAME_MAX) return bad("name", `is longer than ${PRESET_NAME_MAX} characters`);
  if (!NAME_RE.test(s)) return bad("name", "has to be letters, digits, spaces and . _ : / ' ( ) + - only");
  if (looksLikeSecret(s)) return bad("name", "looks like a key; a name is all this field takes");
  return { ok: true, value: s };
}

function validIncludes(v: unknown): Validated<PresetPart[]> {
  if (!Array.isArray(v)) return bad("includes", "has to be a list of parts");
  const out: PresetPart[] = [];
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (typeof p !== "string") return bad(`includes[${i}]`, "has to be a part name");
    if (NO_HOME[p]) return bad(`includes[${i}]`, `"${p}": ${NO_HOME[p]}`);
    if (!(PRESET_PARTS as readonly string[]).includes(p)) {
      return bad(`includes[${i}]`, `"${p}" is not a part of a setup; a setup has ${PRESET_PARTS.join(", ")}`);
    }
    if (out.includes(p as PresetPart)) return bad(`includes[${i}]`, `"${p}" is named twice`);
    out.push(p as PresetPart);
  }
  return { ok: true, value: out };
}

/**
 * The flow with the fields a switched-off part left out filled in, so the one
 * flow validator can check its structure. The placeholders are never applied:
 * `applyPreset` refuses a part the file was not shared with.
 */
function probeFlow(v: unknown, includes: readonly PresetPart[], at: string): Validated<Flow> {
  if (!isObj(v)) return bad(at, "has to be the flow the preset carries");
  const roster = v.roster;
  if (!Array.isArray(roster)) return bad(`${at}.roster`, "has to be the roles of the setup");
  const hasFlow = includes.includes("flow");
  const hasEng = includes.includes("eng");
  const filled: Record<string, unknown>[] = [];
  for (let i = 0; i < roster.length; i++) {
    const listed = roster[i];
    const role: Record<string, unknown> = isObj(listed) ? { ...listed } : {};
    for (const k of ["name", "does", "ico", "hue", "prompt", "tools"] as const) {
      if (role[k] !== undefined) continue;
      const part = ROLE_FIELD_PART[k]!;
      // A field the file says it carries and left out is a broken file, not a part switched off.
      if (includes.includes(part)) return bad(`${at}.roster[${i}].${k}`, `is missing, and includes ${part}`);
      role[k] = PLACEHOLDER[k];
    }
    if (role.chain === undefined) {
      if (hasEng) return bad(`${at}.roster[${i}].chain`, "is missing, and includes eng");
      // Built-ins and a person's step store an empty chain; a role of a person's own needs one to be checked at all.
      role.chain = role.policyRole !== undefined || role.actor === "person" ? [] : PROBE_CHAIN;
    }
    if (!hasFlow) {
      // Without the flow part the file says nothing about where a role sits; the validator only needs a stage that exists.
      role.stage = PROBE_STAGE;
      role.required = false;
      role.readsOnly = role.readsOnly ?? false;
    } else if (role.stage === undefined) {
      return bad(`${at}.roster[${i}].stage`, "is missing, and includes flow");
    }
    filled.push(role);
  }
  // A failing arrow without the fallbacks part has no cap in the file; the project keeps its own when the file is applied.
  const edges = hasFlow && !includes.includes("fb") && Array.isArray(v.edges)
    ? v.edges.map((e) => (isObj(e) && e.on === "fail" && e.maxRounds === undefined ? { ...e, maxRounds: 2 } : e))
    : v.edges;
  const structure = hasFlow
    ? { ...v, edges }
    : { ...v, path: filled.map((r) => r.id).slice(0, 1), blocks: [], stages: [{ id: PROBE_STAGE, label: "Stage" }], edges: [] };
  return validateFlow({ ...structure, roster: filled });
}

function validPolicyPart(v: unknown): Validated<NonNullable<PresetFile["policy"]>> {
  const o = closed(v, "policy", ["base", "rules", "ceiling", "workerDefault", "limits"], []);
  if (failed(o)) return o;
  const policy: NonNullable<PresetFile["policy"]> = {};
  if (o.base !== undefined) {
    const b = closed(o.base, "policy.base", ["orchestrator", "workers"], []);
    if (failed(b)) return b;
    const base: NonNullable<PresetFile["policy"]>["base"] = {};
    if (b.orchestrator !== undefined) {
      const c = validChain(b.orchestrator, "policy.base.orchestrator");
      if (!c.ok) return c;
      base.orchestrator = c.value;
    }
    if (b.workers !== undefined) {
      const w = closed(b.workers, "policy.base.workers", ROLE_IDS, []);
      if (failed(w)) return w;
      const workers: Partial<Record<RoleId, Chain>> = {};
      for (const r of ROLE_IDS) {
        if (w[r] === undefined) continue;
        const c = validChain(w[r], `policy.base.workers.${r}`);
        if (!c.ok) return c;
        workers[r] = c.value;
      }
      base.workers = workers;
    }
    policy.base = base;
  }
  if (o.rules !== undefined) {
    const r = validPolicyRules(o.rules, "policy.rules");
    if (!r.ok) return r;
    policy.rules = r.value;
  }
  if (o.ceiling !== undefined) {
    const c = validEnvelope(o.ceiling, "policy.ceiling");
    if (!c.ok) return c;
    policy.ceiling = c.value;
  }
  if (o.workerDefault !== undefined) {
    const c = validEnvelope(o.workerDefault, "policy.workerDefault");
    if (!c.ok) return c;
    policy.workerDefault = c.value;
  }
  if (o.limits !== undefined) {
    const l = validLimits(o.limits, "policy.limits");
    if (!l.ok) return l;
    policy.limits = l.value;
  }
  if (policy.ceiling && policy.workerDefault && !envelopeWithin(policy.workerDefault, policy.ceiling)) {
    return bad("policy.workerDefault", "is wider than the ceiling the file carries; a setup cannot hand out more than it says");
  }
  return { ok: true, value: policy };
}

/**
 * Check a `.agxpreset` file. Closed at the top and at every object in it, with
 * each field checked by the validator that already owns it, so a file cannot
 * turn into a setting by accident and a typo is refused by name.
 */
export function validatePreset(raw: unknown): Validated<PresetFile> {
  const o = closed(raw, "preset", ["format", "version", "name", "includes", "flow", "policy", "alsoRefusedHere", "neverIncluded"], ["format", "version", "name", "includes"]);
  if (failed(o)) return o;
  if (o.format !== PRESET_FORMAT) return bad("format", `has to be "${PRESET_FORMAT}"`);
  if (o.version !== PRESET_VERSION) return bad("version", `has to be ${PRESET_VERSION}`);
  const name = validName(o.name);
  if (!name.ok) return name;
  const includes = validIncludes(o.includes);
  if (!includes.ok) return includes;
  const flowParts = includes.value.some((p) => PRESET_FLOW_PARTS.includes(p));
  if (flowParts && o.flow === undefined) return bad("flow", "is in includes, and the file has no flow");
  const preset: PresetFile = { format: PRESET_FORMAT, version: PRESET_VERSION, name: name.value, includes: includes.value };
  if (o.flow !== undefined) {
    const f = probeFlow(o.flow, includes.value, "flow");
    if (!f.ok) return f;
    preset.flow = f.value;
  }
  if (o.policy !== undefined) {
    const p = validPolicyPart(o.policy);
    if (!p.ok) return p;
    preset.policy = p.value;
  }
  if (o.alsoRefusedHere !== undefined) {
    // The deny list's own validator: a prefix, never a key, never a free command line.
    const e = validEnvelope({ write: "none", network: false, commit: false, docker: false, deny: o.alsoRefusedHere }, "alsoRefusedHere");
    if (!e.ok) return e;
    preset.alsoRefusedHere = e.value.deny;
  }
  if (o.neverIncluded !== undefined && !Array.isArray(o.neverIncluded)) return bad("neverIncluded", "has to be a list");
  // Whatever a file says it leaves out, this build's list is the one written back.
  return { ok: true, value: { ...preset, neverIncluded: [...PRESET_NEVER_INCLUDED] } };
}

/** A file's text, as a drop or a paste hands it over: JSON, then the one validator. */
export function parsePresetText(text: string): Validated<PresetFile> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "this is not a .agxpreset file: it is not JSON" }; }
  return validatePreset(raw);
}

/** A person's own presets, as the server stores them. */
export function validatePresetList(raw: unknown): Validated<PresetFile[]> {
  if (!Array.isArray(raw)) return bad("presets", "has to be a list of presets");
  if (raw.length > PRESETS_MAX) return bad("presets", `holds at most ${PRESETS_MAX} presets, it has ${raw.length}`);
  const out: PresetFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = validatePreset(raw[i]);
    if (!p.ok) return p;
    if (out.some((x) => x.name === p.value.name)) return bad(`presets[${i}].name`, `"${p.value.name}" is used by an earlier preset`);
    out.push(p.value);
  }
  return { ok: true, value: out };
}

/** A file's text, as it is previewed and downloaded: the parts switched off are not in it. */
export function presetText(preset: PresetFile, includes: readonly PresetPart[] = preset.includes): string {
  return JSON.stringify(withoutParts(preset, includes), null, 2);
}

/** The preset with the switched-off parts taken out, exactly as it is written to disk. A part this preset does not
 *  carry is left out too, so what the share panel can ask for is only what the importer accepts back. */
export function withoutParts(preset: PresetFile, asked: readonly PresetPart[]): PresetFile {
  const includes = presetWritableParts(preset, asked);
  const has = (p: PresetPart) => includes.includes(p);
  const out: PresetFile = {
    format: PRESET_FORMAT, version: PRESET_VERSION, name: preset.name, includes: [...includes],
    neverIncluded: [...PRESET_NEVER_INCLUDED],
  };
  const flowParts = includes.some((p) => PRESET_FLOW_PARTS.includes(p));
  if (preset.flow && flowParts) {
    const roster = preset.flow.roster
      .filter((r) => has("team") || preset.flow!.path.includes(r.id) || preset.flow!.blocks.some((b) => b.id === r.id))
      .map((r) => {
        const role: Partial<FlowRole> & { id: string } = { ...r };
        if (!has("look")) { delete role.name; delete role.does; delete role.ico; delete role.hue; }
        if (!has("prompts")) { delete role.prompt; delete role.tools; }
        // A chain is the engine a role runs on: without the engines part there is none to write.
        if (!has("eng")) delete role.chain;
        // Where a role sits and whether it must run are the flow's: without it they name stages the file does not carry.
        if (!has("flow")) { delete role.stage; delete role.required; }
        return role;
      });
    // A flow whose parts were switched off is not a whole Flow: it is what the file holds, and the validator fills the rest on the way back in.
    out.flow = (has("flow")
      ? { ...preset.flow, roster, edges: has("fb") ? preset.flow.edges : preset.flow.edges.map(({ maxRounds: _rounds, ...e }) => e) }
      : { version: preset.flow.version, roster }) as unknown as Flow;
  }
  if (preset.policy) {
    const policy: NonNullable<PresetFile["policy"]> = {};
    if (has("eng") && preset.policy.base) policy.base = preset.policy.base;
    if (has("rules") && preset.policy.rules) policy.rules = preset.policy.rules;
    if (has("lim") && preset.policy.limits) policy.limits = preset.policy.limits;
    if (has("safety")) {
      if (preset.policy.ceiling) policy.ceiling = preset.policy.ceiling;
      if (preset.policy.workerDefault) policy.workerDefault = preset.policy.workerDefault;
    }
    if (Object.keys(policy).length) out.policy = policy;
  }
  if (has("refused") && preset.alsoRefusedHere) out.alsoRefusedHere = preset.alsoRefusedHere;
  return out;
}

/** The file a person's current setup makes, so "save mine" and "share" write the same shape. */
export function presetOf(target: PresetTarget, name: string, includes: readonly PresetPart[] = PRESET_PARTS): PresetFile {
  const strip = (flow: Flow): Flow => ({
    ...flow,
    roster: flow.roster.map((r) => { const c = { ...r }; delete c.resolvedChain; return c; }),
  });
  const preset: PresetFile = {
    format: PRESET_FORMAT, version: PRESET_VERSION, name, includes: [...includes],
    policy: {
      base: {
        orchestrator: target.policy.base.orchestrator.value,
        workers: Object.fromEntries(ROLE_IDS.map((r) => [r, target.policy.base.workers[r].value])) as Record<RoleId, Chain>,
      },
      rules: target.policy.rules,
      ceiling: target.policy.ceiling,
      workerDefault: target.policy.workerDefault,
      limits: target.policy.limits,
    },
    alsoRefusedHere: target.policy.workerDefault.deny,
    neverIncluded: [...PRESET_NEVER_INCLUDED],
  };
  // A file that carries no flow part carries no flow: a name saved under All projects must not store a project's roster.
  if (target.flow && includes.some((p) => PRESET_FLOW_PARTS.includes(p))) preset.flow = strip(target.flow);
  return preset;
}

/** A file name a person can recognise: "night-shift.agxpreset". */
export function presetFileName(name: string): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "preset";
  return `${stem}.agxpreset`;
}

const addRules = (policy: Policy, rules: readonly PolicyRule[]): Policy => {
  const ids = new Map(rules.map((r) => [r.id, r] as const));
  const kept = policy.rules.filter((r) => !ids.has(r.id));
  return { ...policy, rules: [...kept, ...rules] };
};

/**
 * The flow with the parts that were asked for applied. A part the file was not
 * shared with is never applied, so what a person switched off cannot come back
 * as a placeholder; a role this project already has keeps its name, prompt and
 * chain unless the file carries those parts.
 */
function mergeFlow(preset: PresetFile, current: Flow | null, included: readonly PresetPart[]): Validated<Flow> {
  const imported = preset.flow!;
  const has = (p: PresetPart) => included.includes(p);
  if (!current) {
    for (const p of ["look", "prompts", "fb"] as const) {
      if (has(p) && !preset.includes.includes(p)) return bad("includes", `asks for ${p}, and the file was shared without it`);
    }
    return { ok: true, value: imported };
  }
  const roster: FlowRole[] = [];
  for (let i = 0; i < imported.roster.length; i++) {
    const r = imported.roster[i]!;
    const cur = current.roster.find((x) => x.id === r.id);
    const onPath = imported.path.includes(r.id) || imported.blocks.some((b) => b.id === r.id);
    if (!cur && !has("team") && !(has("flow") && onPath)) continue;
    if (!cur) {
      // The name and prompt the validator filled in to check the shape are not this role's: never store them.
      const missing = (["look", "prompts"] as const).find((p) => !preset.includes.includes(p));
      if (missing) {
        const field = missing === "look" ? "name" : "prompt";
        return bad(`flow.roster[${i}].${field}`, `is a role this project does not have, and the file was shared without ${missing === "look" ? "names" : "prompts"}: apply it to a project that has this role, or use a file that carries them`);
      }
      // A role of a person's own arrives with its engines or not at all: the chain the validator filled in is not one to store.
      if (!preset.includes.includes("eng") && r.policyRole === undefined && r.actor !== "person") {
        return bad(`flow.roster[${i}].chain`, "is a role this project does not have, and the file was shared without its engines: apply it to a project that has this role, or use a file that carries them");
      }
    }
    const next: FlowRole = { ...r };
    if (cur && !has("look")) { next.name = cur.name; next.does = cur.does; next.ico = cur.ico; next.hue = cur.hue; }
    if (cur && !has("prompts")) { next.prompt = cur.prompt; next.tools = cur.tools; }
    // Either part switched off leaves the chain this project already has.
    if (cur && (!has("eng") || !has("fb"))) next.chain = cur.chain;
    if (cur && !has("flow")) {
      // The structure stays this project's: a role keeps the stage it sits in and what it is allowed.
      next.stage = cur.stage; next.required = cur.required; next.readsOnly = cur.readsOnly;
      if (cur.policyRole) next.policyRole = cur.policyRole; else delete next.policyRole;
      if (cur.actor) next.actor = cur.actor; else delete next.actor;
      if (cur.policyRole || cur.actor) next.chain = cur.chain;
    }
    if (!cur && !has("flow")) {
      next.stage = current.stages.some((s) => s.id === next.stage) ? next.stage : current.stages[0]!.id;
      next.required = false;
    }
    roster.push(next);
  }
  for (const r of current.roster) {
    if (roster.some((x) => x.id === r.id)) continue;
    if (has("team") && has("flow")) continue;
    const stage = imported.stages.some((s) => s.id === r.stage) ? r.stage : imported.stages[0]!.id;
    roster.push({ ...r, stage, required: false });
  }
  const structure = has("flow") ? imported : current;
  const edges: FlowEdge[] = structure.edges.map((e) => {
    if (has("fb") || structure === current || e.on !== "fail") return e;
    const mine = current.edges.find((x) => x.from === e.from && x.to === e.to && x.on === e.on);
    // A cap belongs to the fallbacks part: keep the project's, and use the screen's default for an arrow it does not have.
    return { ...e, maxRounds: mine?.maxRounds ?? 2 };
  });
  const probe: Flow = { version: 1, path: structure.path, blocks: structure.blocks, stages: structure.stages, edges, roster };
  return validateFlow(probe);
}

/**
 * What a press on "Use this preset" would save, or the reason it cannot.
 *
 * Pure: it reads the file and the pair already in force and returns the pair to
 * store. It may not widen the safety beyond the ceiling in force (a person's own
 * limit always wins), it applies only the parts both asked for and carried, and
 * an empty `includes` applies nothing at all.
 */
export function applyPreset(preset: PresetFile, target: PresetTarget, included: readonly PresetPart[] = preset.includes): Validated<PresetTarget> {
  for (const p of included) {
    if (!preset.includes.includes(p)) return bad("includes", `asks for ${p}, and the file was shared without it`);
    if ((PRESET_FLOW_PARTS as readonly string[]).includes(p)) {
      if (!preset.flow) return bad("includes", `asks for ${p}, and the file has no flow`);
      // A flow belongs to one project: with none above the page there is nothing for a flow part to change.
      if (!target.flow) return bad("includes", `asks for ${p}, and a flow belongs to one project: pick one, or apply the policy parts only`);
    }
  }
  if (included.length === 0) return { ok: true, value: target };
  const has = (p: PresetPart) => included.includes(p);
  let policy = target.policy;
  if (has("eng")) {
    const base = preset.policy?.base;
    if (!base) return bad("policy.base", "is in includes, and the file has no engines");
    if (base.orchestrator) policy = { ...policy, base: { ...policy.base, orchestrator: { ...policy.base.orchestrator, value: base.orchestrator } } };
    if (base.workers) {
      const workers = { ...policy.base.workers };
      for (const id of ROLE_IDS) { const c = base.workers[id]; if (c) workers[id] = { ...workers[id], value: c }; }
      policy = { ...policy, base: { ...policy.base, workers } };
    }
  }
  if (has("rules")) {
    if (!preset.policy?.rules) return bad("policy.rules", "is in includes, and the file has no rules");
    policy = addRules(policy, preset.policy.rules);
  }
  if (has("lim")) {
    if (!preset.policy?.limits) return bad("policy.limits", "is in includes, and the file has no limits");
    policy = { ...policy, limits: preset.policy.limits };
  }
  if (has("safety")) {
    const safety = preset.policy;
    if (!safety?.ceiling || !safety.workerDefault) return bad("policy.ceiling", "is in includes, and the file carries no safety");
    if (!envelopeWithin(safety.workerDefault, safety.ceiling)) return bad("policy.workerDefault", "is wider than the ceiling the file carries");
    if (!envelopeWithin(safety.ceiling, policy.ceiling)) {
      return bad("policy.ceiling", "asks for more than this project's most the main agent may allow; raise that limit on purpose first, or apply the parts below it");
    }
    // The refusals in force stay: a file may add to them, never take one away (the `refused` part only ever adds).
    const deny = [...new Set([...policy.workerDefault.deny, ...safety.workerDefault.deny])];
    policy = { ...policy, ceiling: safety.ceiling, workerDefault: { ...policy.workerDefault, ...safety.workerDefault, deny } };
  }
  if (has("refused")) {
    if (!preset.alsoRefusedHere) return bad("alsoRefusedHere", "is in includes, and the file carries no extra refusals");
    const deny = [...new Set([...policy.workerDefault.deny, ...preset.alsoRefusedHere])];
    policy = { ...policy, workerDefault: { ...policy.workerDefault, deny } };
  }
  const checked = validatePolicy(policy);
  if (!checked.ok) return checked;
  let flow = target.flow;
  if (PRESET_FLOW_PARTS.some(has)) {
    const merged = mergeFlow(preset, target.flow, included);
    if (!merged.ok) return merged;
    flow = merged.value;
  }
  return { ok: true, value: { policy: checked.value, flow } };
}
