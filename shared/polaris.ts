/*
 * Polaris: the orchestrator's pull request abilities, with no server and no window.
 *
 * What a person may switch (the doors and their modes), the presets that set them
 * all at once, the guardrails that no door moves, and the pure rule that files one
 * pull request under a class with one reason. The server stores the settings and the
 * actions (server/src/polaris.ts); this file only decides.
 */

/** The doors, in the order the Settings card draws them. */
export const DOOR_IDS = [
  "follow", "dock", "cards", "cleared", "labels", "approvals", "redsNamed", "signals", "diagnose",
  "relaunch", "rerunButton", "beacon", "match", "course", "cleanup", "startSession", "lookAgain",
] as const;
export type DoorId = (typeof DOOR_IDS)[number];
export const isDoorId = (v: unknown): v is DoorId => typeof v === "string" && (DOOR_IDS as readonly string[]).includes(v);

/** Each door's modes from the safest to the most open: the index is the openness rank. */
export const DOOR_MODES = {
  follow: ["off", "on"],
  dock: ["off", "on"],
  cards: ["off", "on"],
  cleared: ["off", "quiet", "bell"],
  labels: ["off", "on"],
  approvals: ["people", "any"],
  redsNamed: ["block", "name"],
  signals: ["off", "on"],
  diagnose: ["off", "click", "auto"],
  relaunch: ["off", "dry", "live"],
  rerunButton: ["off", "button"],
  beacon: ["off", "draft"],
  match: ["ask", "use"],
  course: ["off", "hours"],
  cleanup: ["off", "propose"],
  startSession: ["off", "click"],
  lookAgain: ["off", "on"],
} as const satisfies Record<DoorId, readonly string[]>;
export type DoorMode<D extends DoorId = DoorId> = (typeof DOOR_MODES)[D][number];

/** Higher is more open. -1 for a mode the door does not have. */
export const openness = (door: DoorId, mode: unknown): number => (DOOR_MODES[door] as readonly unknown[]).indexOf(mode);

/** The positions that act on the world beyond a draft: only the person moves a door there. */
const LIVE: Partial<Record<DoorId, string>> = { relaunch: "live", startSession: "click", cards: "on", diagnose: "auto" };
export const isLive = (door: DoorId, mode: unknown): boolean => LIVE[door] === mode;

export interface LabelRule { /** Base branch it applies to; any when absent. */ base?: string; /** Path prefixes of changed files; any change when empty. */ paths?: string[]; label: string }

type Spec = { def: unknown; ok: (v: unknown) => boolean };
const int = (lo: number, hi: number): Spec["ok"] => (v) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const oneOf = (...xs: unknown[]): Spec["ok"] => (v) => xs.includes(v);
const list = (ok: (x: unknown) => boolean, max: number): Spec["ok"] => (v) => Array.isArray(v) && v.length <= max && v.every(ok);
const labelRule: Spec["ok"] = (r) => {
  const o = r as LabelRule;
  return !!o && typeof o === "object" && typeof o.label === "string" && o.label.length > 0 && o.label.length <= 80
    && (o.base === undefined || typeof o.base === "string") && (o.paths === undefined || list((p) => typeof p === "string", 20)(o.paths));
};

/** The settings a door carries beside its mode, with their defaults. */
export const DOOR_PARAMS: Record<DoorId, Record<string, Spec>> = {
  follow: {}, signals: {}, cleared: {}, approvals: {}, redsNamed: {}, diagnose: {}, rerunButton: {}, beacon: {}, match: {}, cleanup: {},
  dock: { label: { def: "docked", ok: (v) => typeof v === "string" && v.length > 0 && v.length <= 80 }, excluded: { def: [], ok: list(int(1, 1e9), 200) } },
  cards: { size: { def: 2, ok: int(1, 5) } },
  labels: { rules: { def: [], ok: list(labelRule, 50) } },
  relaunch: { cap: { def: 3, ok: int(1, 3) } },
  course: { hours: { def: 24, ok: oneOf(4, 12, 24, 48) } },
  startSession: { tries: { def: 3, ok: int(1, 3) } },
  lookAgain: { minutes: { def: 15, ok: (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 1440 }, steps: { def: 1, ok: int(1, 5) } },
};

/** One door as stored: its mode, its settings, and any key a newer version added (kept, never read). */
export interface DoorValue { mode: string; [param: string]: unknown }
export interface PolarisSettings {
  version: number;
  enabled: boolean;
  /** The label of what was last chosen; any later change of one door stores custom. */
  preset: PolarisPresetName;
  doors: Record<DoorId, DoorValue>;
  [unknownKey: string]: unknown;
}
/** What a scope writes down: only what the person set. A missing door reads the next layer. */
export interface StoredPolaris { version?: number; enabled?: boolean; preset?: PolarisPresetName; doors?: Partial<Record<DoorId, DoorValue>>; [unknownKey: string]: unknown }

export const POLARIS_VERSION = 1;
/** The format a door first appeared in. A door not listed has been there since format 1. */
export const DOOR_SINCE: Partial<Record<DoorId, number>> = {};
export type PresetId = "watchOnly" | "guided" | "fullAutopilot";
export type PolarisPresetName = PresetId | "custom" | "none";

const defaultsOf = (door: DoorId): Record<string, unknown> =>
  Object.fromEntries(Object.entries(DOOR_PARAMS[door]).map(([k, s]) => [k, structuredClone(s.def)]));
/** A door in its safe position (its lowest mode) with default settings. */
export const safeDoor = (door: DoorId): DoorValue => ({ mode: DOOR_MODES[door][0], ...defaultsOf(door) });

/** The door as it would be stored, or why not. Unknown keys pass; a known key that is wrong is refused by name. */
export function checkDoor(door: DoorId, raw: unknown, base: DoorValue = safeDoor(door)): { value: DoorValue } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${door}: an object {mode, ...settings}` };
  const o = raw as Record<string, unknown>;
  if (!(DOOR_MODES[door] as readonly unknown[]).includes(o.mode)) return { error: `${door}.mode: one of ${DOOR_MODES[door].join(", ")}` };
  const out: DoorValue = { ...base, ...o, mode: o.mode as string };
  for (const [k, s] of Object.entries(DOOR_PARAMS[door])) {
    if (k in o && !s.ok(o[k])) return { error: `${door}.${k}: not a valid value` };
    if (!(k in out)) out[k] = structuredClone(s.def);
  }
  return { value: out };
}

const door = (id: DoorId, mode: string, params: Record<string, unknown> = {}): DoorValue => ({ ...safeDoor(id), mode, ...params });

const WATCH: Record<DoorId, DoorValue> = {
  ...Object.fromEntries(DOOR_IDS.map((d) => [d, safeDoor(d)])) as Record<DoorId, DoorValue>,
  follow: door("follow", "on"), dock: door("dock", "on"), cleared: door("cleared", "quiet"), labels: door("labels", "on"),
  approvals: door("approvals", "people"), redsNamed: door("redsNamed", "name"), match: door("match", "use"),
  lookAgain: door("lookAgain", "on", { minutes: 30, steps: 1 }),
};
const GUIDED: Record<DoorId, DoorValue> = {
  ...WATCH,
  signals: door("signals", "on"), diagnose: door("diagnose", "click"), relaunch: door("relaunch", "dry", { cap: 3 }),
  rerunButton: door("rerunButton", "button"), beacon: door("beacon", "draft"), course: door("course", "hours", { hours: 24 }),
  cleanup: door("cleanup", "propose"), lookAgain: door("lookAgain", "on", { minutes: 15, steps: 1 }),
};
const FULL: Record<DoorId, DoorValue> = {
  ...GUIDED,
  cards: door("cards", "on", { size: 2 }), diagnose: door("diagnose", "auto"), relaunch: door("relaunch", "live", { cap: 3 }),
  course: door("course", "hours", { hours: 4 }), startSession: door("startSession", "click", { tries: 3 }),
  lookAgain: door("lookAgain", "on", { minutes: 5, steps: 5 }),
};
export const PRESETS: Record<PresetId, { label: string; doors: Record<DoorId, DoorValue> }> = {
  watchOnly: { label: "Watch only", doors: WATCH },
  guided: { label: "Guided", doors: GUIDED },
  fullAutopilot: { label: "Full autopilot", doors: FULL },
};

const presetName = (v: unknown): PolarisPresetName =>
  v === "watchOnly" || v === "guided" || v === "fullAutopilot" || v === "custom" ? v : "none";

/** The layer a person gets by choosing a preset: all 17 doors overwritten, its name stored. */
export const withPreset = (cur: StoredPolaris | null, id: PresetId): StoredPolaris => ({ ...(cur ?? {}), preset: id, doors: structuredClone(PRESETS[id].doors) });
/** One door changed, by anyone: the layer now reads custom. */
export const withDoor = (cur: StoredPolaris | null, door: DoorId, value: DoorValue): StoredPolaris =>
  ({ ...(cur ?? {}), preset: "custom", doors: { ...(cur?.doors ?? {}), [door]: value } });
/** Polaris switched on or off for a layer. On with no stored doors writes Guided; with doors it keeps them. */
export const withEnabled = (cur: StoredPolaris | null, on: boolean): StoredPolaris =>
  on && !cur?.doors ? { ...withPreset(cur, "guided"), enabled: true } : { ...(cur ?? {}), enabled: on };

/** Off, every door in its safe position. A door a later version adds reads this way until the person sets it. */
export function defaultPolaris(): PolarisSettings {
  const doors = Object.fromEntries(DOOR_IDS.map((d) => [d, safeDoor(d)])) as Record<DoorId, DoorValue>;
  return { version: POLARIS_VERSION, enabled: false, preset: "none", doors };
}

/**
 * Whatever is stored, read as complete settings: a missing or unusable key reads its
 * default, an unknown key is kept, and a version newer than this one is read, not refused.
 */
export function normalizePolaris(raw: unknown): PolarisSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stored = o.doors && typeof o.doors === "object" && !Array.isArray(o.doors) ? (o.doors as Record<string, unknown>) : {};
  const doors = { ...stored } as Record<string, DoorValue>;
  for (const d of DOOR_IDS) {
    const o = stored[d] as Record<string, unknown> | undefined;
    // An unknown mode is the safe door; a mode that is fine with one bad setting keeps the mode and defaults that setting.
    const bad = Object.keys(DOOR_PARAMS[d]).filter((k) => o && k in o && !DOOR_PARAMS[d][k]!.ok(o[k]));
    const r = o && typeof o === "object" ? checkDoor(d, Object.fromEntries(Object.entries(o).filter(([k]) => !bad.includes(k)))) : null;
    doors[d] = r && "value" in r ? r.value : safeDoor(d);
  }
  const { preset: _p, ...rest } = o;
  const version = Number.isInteger(o.version) && (o.version as number) >= 1 ? (o.version as number) : POLARIS_VERSION;
  return { ...rest, version, enabled: o.enabled === true, preset: presetName(o.preset), doors: doors as Record<DoorId, DoorValue> };
}

/** The stored form of a request, or why it is refused. Unknown keys pass; a known key that is wrong is named. */
export function validateStoredPolaris(raw: unknown): { ok: true; value: StoredPolaris } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "polaris: an object" };
  const o = raw as Record<string, unknown>;
  if ("enabled" in o && typeof o.enabled !== "boolean") return { ok: false, error: "enabled: true or false" };
  if ("version" in o && (!Number.isInteger(o.version) || (o.version as number) < 1)) return { ok: false, error: "version: a whole number" };
  if ("preset" in o && presetName(o.preset) !== o.preset) return { ok: false, error: "preset: watchOnly, guided, fullAutopilot, custom or none" };
  const rest = o;
  if (o.doors === undefined) return { ok: true, value: rest as StoredPolaris };
  if (!o.doors || typeof o.doors !== "object" || Array.isArray(o.doors)) return { ok: false, error: "doors: an object" };
  const doors: Record<string, unknown> = { ...(o.doors as object) };
  for (const d of DOOR_IDS) {
    if (!(d in doors)) continue;
    const r = checkDoor(d, doors[d]);
    if ("error" in r) return { ok: false, error: r.error };
    doors[d] = r.value;
  }
  return { ok: true, value: { ...rest, doors } as StoredPolaris };
}

export type Layer = "project" | "global" | "default";
/** The settings in force: per door, the project's value, else the global one, else the safe default. */
export function resolvePolaris(global: unknown, project: unknown): { settings: PolarisSettings; layers: Record<DoorId, Layer>; enabledLayer: Layer; presetLayer: Layer } {
  const g = (global && typeof global === "object" ? global : {}) as StoredPolaris;
  const p = (project && typeof project === "object" ? project : {}) as StoredPolaris;
  const doors: Record<string, unknown> = {};
  const layers = {} as Record<DoorId, Layer>;
  for (const d of DOOR_IDS) {
    const hasP = !!p.doors && d in p.doors, hasG = !!g.doors && d in g.doors;
    layers[d] = hasP ? "project" : hasG ? "global" : "default";
    if (hasP) doors[d] = p.doors![d]; else if (hasG) doors[d] = g.doors![d];
  }
  const enabledLayer: Layer = typeof p.enabled === "boolean" ? "project" : typeof g.enabled === "boolean" ? "global" : "default";
  const enabled = enabledLayer === "project" ? p.enabled : enabledLayer === "global" ? g.enabled : false;
  const presetLayer: Layer = p.preset !== undefined ? "project" : g.preset !== undefined ? "global" : "default";
  const preset = presetLayer === "project" ? p.preset : presetLayer === "global" ? g.preset : "none";
  return { settings: normalizePolaris({ ...g, ...p, enabled, preset, doors }), layers, enabledLayer, presetLayer };
}

/** Which way is narrower for a setting a door carries: 1 = lower, -1 = higher. A setting not listed here has no direction. */
const NARROWER: Record<string, 1 | -1> = { cap: 1, size: 1, tries: 1, steps: 1, hours: -1, minutes: -1 };

/**
 * True when `next` is a safer or cheaper position for this door than `prev`: a lower mode,
 * or the same mode with less, and nothing at all moved the wide way. When several fields
 * change at once the widest wins, so a lower mode with a wider setting is not narrowing.
 */
export function doorNarrows(door: DoorId, prev: unknown, next: unknown): boolean {
  const a = prev as DoorValue | null, b = next as DoorValue | null;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ra = openness(door, a.mode), rb = openness(door, b.mode);
  if (ra < 0 || rb < 0 || rb > ra) return false;
  let tighter = rb < ra;
  for (const k of Object.keys(DOOR_PARAMS[door])) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    const dir = NARROWER[k];
    if (!dir) return false;
    if ((Number(b[k]) - Number(a[k])) * dir > 0) return false;
    tighter = true;
  }
  return tighter;
}

/** The new value is a live position that is not a step back: only the person puts a door there. */
export const raisesToLive = (door: DoorId, prev: unknown, next: unknown): boolean =>
  isLive(door, (next as DoorValue | null)?.mode) && !doorNarrows(door, prev, next);

// ── guardrails ──

export const GUARDRAILS: readonly { title: string; detail: string }[] = [
  { title: "Polaris never merges", detail: "Merging is always your click, on GitHub. The app shows a link or a command." },
  { title: "Nothing is posted, sent or changed outside the app without your click", detail: "No comment, label, review, card move or issue change leaves its draft until you click. A message to a session is a draft that your click sends." },
  { title: "A door you have not set starts in its safe position", detail: "Off, or a dry run that shows what it would do. That includes doors a later version adds. Choosing a preset is you setting them." },
  { title: "Only relaunching dropped CI jobs acts on GitHub by itself", detail: "Reading, sorting, diagnosing and proposing only read or draft. No push, no edit, no rerun of a job that failed on its own steps. Bringing a branch up to date with its base is your click, never automatic." },
];
export const ALSO_NEVER: readonly string[] = [
  "Never writes to a production or staging database",
  "Never edits the code of a pull request",
  "Never weakens a test",
  "Never touches a paused pull request or a running one",
  "Never starts a third card while two are running",
  "Never claims a card for anyone",
  "Never messages the same session twice for the same reason",
  "Never closes a working session or removes its worktree",
];

// ── jobs ──

export interface PolarisJob { conclusion: string | null; stepConclusions: (string | null)[] }
/** The runner took the job back before any step ran: it failed and no step has a conclusion. A cancelled job is not dropped. */
export const droppedJob = (job: PolarisJob): boolean => job.conclusion === "failure" && job.stepConclusions.every((c) => !c);
export const RELAUNCH_CAP = 3;
/** The cap is the total attempts including the first, counted per workflow run: relaunch only while the run is below it and nothing is still running. */
export const canRelaunch = (run: { attempt: number; pending: boolean }, cap = RELAUNCH_CAP): boolean =>
  run.attempt < Math.min(cap, RELAUNCH_CAP) && !run.pending;

// ── classes and reasons ──

export const CLASSES = ["Cleared to land", "Needs you", "Drifting", "In orbit", "Docked", "Landed", "Uncharted"] as const;
export type PolarisClass = (typeof CLASSES)[number];

/** The fourteen questions, in the order they are asked. The first yes is the reason. */
export const REASONS = ["paused", "unknown", "conflict", "labels", "inherited", "failing", "waiting", "runner", "behind", "changes", "review", "github", "redsNamed", "ready"] as const;
export type PolarisReason = (typeof REASONS)[number];

export const REASON_CLASS: Record<PolarisReason, PolarisClass> = {
  paused: "Docked", unknown: "Uncharted", conflict: "Needs you", labels: "Needs you", inherited: "Needs you", failing: "Needs you", waiting: "In orbit",
  runner: "Drifting", behind: "Needs you", changes: "Needs you", review: "Needs you", github: "Needs you",
  redsNamed: "Cleared to land", ready: "Cleared to land",
};

export interface PolarisCheck {
  name: string;
  state: "success" | "failure" | "pending" | "skipped" | "neutral";
  required?: boolean;
  runId?: number;
  /** GitHub counts attempts per workflow run. */
  runAttempt?: number;
  /** Red on the base branch too, at the base commit this run tested: not this pull request's doing. Set by the sweep, never guessed. */
  inherited?: boolean;
  /** The job behind a failed check, read by the sweep only when relaunch is not off. */
  job?: PolarisJob;
}
export interface PrFacts {
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  /** On the person's list of pull requests to leave alone. */
  excluded: boolean;
  labels: string[];
  base?: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's merge state (CLEAN, BEHIND, DIRTY, BLOCKED...), when it said. */
  mergeStateStatus?: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  approvals: { isBot: boolean }[];
  checks: PolarisCheck[];
  /** Check names the base branch requires, when the check itself did not say. */
  requiredNames: string[];
  changedFiles: string[];
  labelRules: LabelRule[];
}
export interface ClassifyOptions {
  /** people: a bot's approval is not one. */
  approvals?: "people" | "any";
  /** name: an optional red is named and does not block. block: it blocks like a required one. */
  redsNamed?: "name" | "block";
  dockLabel?: string;
}
export interface Verdict { cls: PolarisClass; reason: PolarisReason | null; sentence: string; names?: string[] }

// ── what the HTTP routes answer, shared so the window types its calls from the same place ──

/** One run of a failed check and the job inside it that could be run again. */
export interface RunRef { runId: number; attempt: number; pending: boolean; job: PolarisJob & { id: number } }
export interface PolarisItem extends Verdict {
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  ignored: boolean;
  draft: string | null;
  /** The proposals the person already has for this item and reason, so a button is not offered twice. */
  proposed: ("course" | "cleanup")[];
  /** A dropped job that could be run again, for the relaunch door. */
  dropped: RunRef[];
  /** After a sync left this machine's copy alone (changes, or commits GitHub lacks): a draft for its session. */
  syncDraft: string | null;
  /** The commit the person saw as the head: a sync names it so it never races a push. */
  headSha: string;
  /** Set when the reason is inherited: the red checks and the base commit the failed run tested. */
  inherited?: { checks: string[]; baseSha: string };
  /** The base is green again at a newer commit and nothing is running here: a click may sync this one. */
  canSync: boolean;
}
/** A base branch some pull requests inherit a red from. Present only while at least one does. */
export interface BaseRed {
  base: string;
  checks: string[];
  /** The base commit the failed runs tested. */
  sinceSha: string;
  tipSha: string;
  /** Every inherited check is green at a newer base commit. */
  fixed: boolean;
  inheritors: number[];
  canSync: number[];
  /** The base's check run, for the link in the banner. */
  url?: string;
}
export interface ItemsAnswer { ok: true; enabled: boolean; items: PolarisItem[]; uncharted?: string; bases?: BaseRed[] }
/** GET and PUT /polaris/settings: the settings in force for a project (or the global ones) and which layer each came from. */
export interface SettingsAnswer extends PolarisSettings {
  ok: true;
  root?: string;
  layers: Record<DoorId, Layer>;
  enabledLayer: Layer;
  presetLayer: Layer;
}
/** What a PUT /polaris/settings changes: a preset, the switch, or a whole stored layer (null drops a project's own). */
export type SettingsChange = { preset: PresetId } | { enabled: boolean } | { settings: StoredPolaris | null };
/** The doors a person's click can name; the relaunch is the sweep's, never a click. */
export type ClickAction = "beacon-draft" | "beacon-edit" | "beacon-discard" | "dock" | "ignore" | "propose" | "sync";
/** `headSha` and `baseSha` are for a sync: the head the person saw, and the fixed base commit. */
export interface ActionBody { type: ClickAction; reason?: string; text?: string; paneId?: string; door?: "course" | "cleanup"; headSha?: string; baseSha?: string }
export interface ActionAnswer { ok: boolean; outcome?: "done" | "skipped-in-dry-run"; error?: string }

const isOk = (c: PolarisCheck) => c.state === "success" || c.state === "skipped" || c.state === "neutral";
const list2 = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", "));

/** Files one pull request under a class with one reason. The first rule that matches wins. */
export function classifyPr(f: PrFacts, o: ClassifyOptions = {}): Verdict {
  if (f.state === "MERGED") return { cls: "Landed", reason: null, sentence: "Merged." };
  if (f.state === "CLOSED") return { cls: "Landed", reason: null, sentence: "Closed without merging." };
  const say = (reason: PolarisReason, sentence: string, names?: string[]): Verdict => ({ cls: REASON_CLASS[reason], reason, sentence, ...(names ? { names } : {}) });

  if (f.draft || f.excluded || f.labels.includes(o.dockLabel ?? "docked")) return say("paused", "Docked: a draft, an excluded pull request or one with the docked label.");
  if (f.mergeable === "UNKNOWN" || f.mergeStateStatus === "UNKNOWN") return say("unknown", "GitHub has not said yet whether it merges cleanly.");
  if (f.mergeable === "CONFLICTING" || f.mergeStateStatus === "DIRTY") return say("conflict", "It conflicts with the base branch.");

  const missing = f.labelRules
    .filter((r) => (!r.base || r.base === f.base) && (!r.paths?.length || f.changedFiles.some((p) => r.paths!.some((x) => p.startsWith(x)))))
    .map((r) => r.label).filter((l) => !f.labels.includes(l));
  if (missing.length) return say("labels", `A label is missing: ${list2(missing)}.`, missing);

  const required = (c: PolarisCheck) => c.required === true || f.requiredNames.includes(c.name);
  const reqs = f.checks.filter(required);
  // Reds are split into gating and optional only when every required check is ok.
  const split = o.redsNamed !== "block" && reqs.length > 0 && reqs.every(isOk);
  const reds = f.checks.filter((c) => c.state === "failure" && !(c.job && droppedJob(c.job)));
  const failing = split ? reds.filter(required) : reds;
  // Only when every red is the base's: one of its own reds still reads as failing.
  if (failing.length && failing.every((c) => c.inherited)) return say("inherited", `Red on the base branch too: ${list2(failing.map((c) => c.name))}. Not caused by this pull request.`, failing.map((c) => c.name));
  if (failing.length) return say("failing", `Failing: ${list2(failing.map((c) => c.name))}.`, failing.map((c) => c.name));
  if (f.checks.some((c) => c.state === "pending")) return say("waiting", "Checks are still running.");
  const dropped = f.checks.filter((c) => c.state === "failure" && c.job && droppedJob(c.job));
  if (dropped.length) return say("runner", `The runner dropped ${list2(dropped.map((c) => c.name))} before any step ran.`, dropped.map((c) => c.name));

  if (f.mergeStateStatus === "BEHIND") return say("behind", "The branch is behind the base branch.");
  if (f.reviewDecision === "CHANGES_REQUESTED") return say("changes", "A reviewer asked for changes.");
  const people = f.approvals.filter((a) => !a.isBot).length;
  if (f.reviewDecision === "REVIEW_REQUIRED" || (f.reviewDecision === "APPROVED" && o.approvals !== "any" && people === 0)) {
    return say("review", f.approvals.length && people === 0 ? "Only a bot reviewed." : "It needs a review.");
  }
  if (f.mergeStateStatus && !["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(f.mergeStateStatus)) return say("github", `GitHub says it cannot merge yet (${f.mergeStateStatus.toLowerCase()}).`);

  const optional = f.checks.filter((c) => c.state === "failure" && !required(c));
  if (split && optional.length) return say("redsNamed", `Cleared to land. Optional and red: ${list2(optional.map((c) => c.name))}.`, optional.map((c) => c.name));
  return say("ready", "Cleared to land.");
}
