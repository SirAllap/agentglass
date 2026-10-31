// What the Polaris card and the Pull requests section show, decided here with no window.
// The server stores and acts (server/src/polaris.ts); this turns its answers into rows and its
// rows back into the one PUT that changes a layer.
import {
  DOOR_IDS, DOOR_MODES, DOOR_SINCE, POLARIS_VERSION, PRESETS, isLive, raisesToLive,
  type BaseRed, type DoorId, type DoorValue, type Layer, type PolarisItem, type PolarisClass, type PresetId, type SettingsAnswer, type SettingsChange, type StoredPolaris,
} from "../../../shared/polaris.ts";
import { DOOR_COPY, GROUPS, type GroupId } from "./polarisCopy.ts";

/** Which stored layer the page edits: a project's own, or the global one. */
export type Scope = "project" | "global";
export const scopeOf = (root: string): Scope => (root ? "project" : "global");

/** The layer being edited, as it is stored: only what that layer contains, never what it inherits. */
export function storedOf(a: SettingsAnswer, scope: Scope): StoredPolaris {
  const doors: Partial<Record<DoorId, DoorValue>> = {};
  for (const d of DOOR_IDS) if (a.layers[d] === scope) doors[d] = a.doors[d];
  return {
    version: a.version,
    ...(a.enabledLayer === scope ? { enabled: a.enabled } : {}),
    ...(a.presetLayer === scope ? { preset: a.preset } : {}),
    ...(Object.keys(doors).length ? { doors } : {}),
  };
}

const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export const presetChoices = (): { id: PresetId | "custom"; label: string }[] =>
  [...PRESET_IDS.map((id) => ({ id, label: PRESETS[id].label })), { id: "custom", label: "Custom" }];

/** The preset shown as chosen: the stored label, or none when nothing was ever chosen on this page. */
export const presetShown = (a: SettingsAnswer): PresetId | "custom" | null => (a.preset === "none" ? null : a.preset);

/** The chip on the Coordinator card: Polaris and the preset it runs, or nothing while it is off. */
export const chipLabel = (a: SettingsAnswer | null): string | null =>
  !a?.enabled ? null : a.preset === "none" ? "Polaris" : `Polaris, ${a.preset === "custom" ? "Custom" : PRESETS[a.preset].label}`;

// ── changes ──

export const turnOn = (on: boolean): SettingsChange => ({ enabled: on });
export const pickPreset = (id: PresetId): SettingsChange => ({ preset: id });

/** One door changed. The whole door goes down, since the server stores a door as a unit; the layer then reads Custom. */
export function changeDoor(a: SettingsAnswer, scope: Scope, door: DoorId, patch: Record<string, unknown>): SettingsChange {
  const cur = storedOf(a, scope);
  const next: DoorValue = { ...a.doors[door], ...patch } as DoorValue;
  return { settings: { ...cur, preset: "custom", doors: { ...cur.doors, [door]: next } } };
}

/** A door goes back to what the layer below says: in a project, the global one; in the global layer, the Guided position. */
export function resetDoors(a: SettingsAnswer, scope: Scope, doors: readonly DoorId[]): SettingsChange {
  const cur = storedOf(a, scope);
  const rest: Partial<Record<DoorId, DoorValue>> = { ...cur.doors };
  for (const d of doors) {
    if (scope === "project") delete rest[d];
    else rest[d] = structuredClone(PRESETS.guided.doors[d]);
  }
  const { preset: _p, doors: _d, ...keep } = cur;
  const any = Object.keys(rest).length > 0;
  return { settings: { ...keep, ...(any ? { preset: "custom" as const, doors: rest } : {}) } };
}
export const groupDoors = (group: GroupId): readonly DoorId[] => GROUPS.find((g) => g.id === group)!.doors;

/** A project's own setting dropped altogether, so the project follows the global one. */
export const inheritAll = (): SettingsChange => ({ settings: null });

// ── door rows ──

export type Mark = "Live" | "Dry run" | null;
/** Which doors act beyond a draft, or would act if it were not a dry run. */
export function markOf(door: DoorId, value: DoorValue): Mark {
  if (isLive(door, value.mode)) return "Live";
  return door === "relaunch" && value.mode === "dry" ? "Dry run" : null;
}

/** Whether a door has settings to draw under its row: the dock always, labels and lookAgain while their mode uses them. The counts live in the Limits group. */
export const showsParams = (door: DoorId, mode: string): boolean =>
  door === "dock" || (["labels", "lookAgain"].includes(door) && mode !== DOOR_MODES[door][0]);

/** The numbers that cap what a door does, drawn together in the Limits group. */
export interface LimitSpec { door: DoorId; param: "size" | "cap" | "tries" | "hours"; name: string; hint: string }
export const LIMITS: readonly LimitSpec[] = [
  { door: "cards", param: "size", name: "Orbit limit", hint: "Most cards running at once. Beyond it the orchestrator is told to wait." },
  { door: "relaunch", param: "cap", name: "Attempts per run", hint: "Attempts on one run, the first included. 1 never runs a job again." },
  { door: "startSession", param: "tries", name: "Start tries", hint: "Tries before it stops and tells you, with a pause between them." },
  { door: "course", param: "hours", name: "Drifting before a course", hint: "Hours a pull request drifts before a course is proposed." },
];
export interface LimitView extends LimitSpec { value: number; on: boolean; layer: Layer; source: string | null; doorName: string }
export function limitViews(a: SettingsAnswer, scope: Scope): LimitView[] {
  return LIMITS.map((l) => ({
    ...l, value: Number(a.doors[l.door][l.param]), on: a.doors[l.door].mode !== DOOR_MODES[l.door][0],
    layer: a.layers[l.door], source: sourceWords(scope, a.layers[l.door]), doorName: DOOR_COPY[l.door].name,
  }));
}

export interface DoorView {
  door: DoorId;
  name: string;
  what: string;
  example: string;
  keep: string;
  value: DoorValue;
  layer: Layer;
  options: { id: string; label: string }[];
  mark: Mark;
  /** In a project: whether the value comes from the global layer or the safe default, not from the project. */
  inherits: boolean;
  /** The words next to a door that is not set by this layer. */
  source: string | null;
  isNew: boolean;
}

/** A door added by a later version: nothing stored anywhere for it while other doors are stored. */
export const newDoors = (a: SettingsAnswer): DoorId[] =>
  Object.values(a.layers).every((l) => l === "default") ? [] : DOOR_IDS.filter((d) => a.layers[d] === "default");

export function sourceWords(scope: Scope, layer: Layer): string | null {
  if (layer === "default") return "Not set: it starts in its safe position";
  if (scope === "project" && layer === "global") return "Inherits global";
  return null;
}

export function doorView(a: SettingsAnswer, scope: Scope, door: DoorId): DoorView {
  const c = DOOR_COPY[door];
  const value = a.doors[door];
  const layer = a.layers[door];
  return {
    door, name: c.name, what: c.what, example: c.example, keep: c.keep, value, layer,
    options: DOOR_MODES[door].map((m) => ({ id: m, label: c.modes[m] ?? m })),
    mark: markOf(door, value),
    inherits: scope === "project" && layer !== "project",
    source: sourceWords(scope, layer),
    isNew: newDoors(a).includes(door),
  };
}

export interface GroupView { id: GroupId; sub: string; doors: DoorView[]; limits: LimitView[]; newCount: number; resetLabel: string }
export function groupViews(a: SettingsAnswer, scope: Scope): GroupView[] {
  return GROUPS.map((g) => {
    const doors = g.doors.map((d) => doorView(a, scope, d));
    return {
      id: g.id, sub: g.sub, doors, limits: g.id === "Limits" ? limitViews(a, scope) : [], newCount: doors.filter((d) => d.isNew).length,
      resetLabel: scope === "project" ? "Use global" : "Reset to Guided",
    };
  });
}

// ── going live ──

const LIVE_SENTENCE: Partial<Record<DoorId, (v: DoorValue) => string>> = {
  relaunch: (v) => `Polaris will run a CI job again when a runner dropped it, up to ${v.cap} attempts per run. It will not merge, move a card, comment or post.`,
  cards: (v) => `Polaris will keep up to ${v.size} cards running at once. It never claims a card for anyone.`,
  diagnose: () => "Polaris will read a failing job log by itself and give a verdict. It only reads.",
  startSession: (v) => `Polaris will offer a session for each card that is ready, and try up to ${v.tries} times to start it. Each start is still your click.`,
};

/** What the person is asked before a door goes to a live position, or null when the change needs no question. */
export function liveQuestion(door: DoorId, prev: DoorValue, next: DoorValue): string | null {
  return raisesToLive(door, prev, next) ? LIVE_SENTENCE[door]?.(next) ?? null : null;
}
/** The doors a preset would put live that are not live now. */
export function presetLiveDoors(a: SettingsAnswer, id: PresetId): DoorId[] {
  return DOOR_IDS.filter((d) => isLive(d, PRESETS[id].doors[d].mode) && !isLive(d, a.doors[d].mode));
}
export const presetQuestion = (a: SettingsAnswer, id: PresetId): string | null => {
  const live = presetLiveDoors(a, id);
  return live.length ? `${PRESETS[id].label} puts these doors live: ${live.map((d) => DOOR_COPY[d].name.toLowerCase()).join("; ")}. None of them can merge, post or comment.` : null;
};

// ── items ──

export const CLASS_ORDER: readonly PolarisClass[] = ["Needs you", "Drifting", "Cleared to land", "Uncharted", "In orbit", "Docked", "Landed"];
const rank = (c: PolarisClass) => CLASS_ORDER.indexOf(c);
export const sortItems = (items: readonly PolarisItem[]): PolarisItem[] =>
  [...items].sort((a, b) => rank(a.cls) - rank(b.cls) || a.number - b.number);

export type ItemTone = "ok" | "warn" | "info" | "line";
export const CLASS_TONE: Record<PolarisClass, ItemTone> = {
  "Cleared to land": "ok", "Needs you": "warn", Drifting: "warn", "In orbit": "info", Docked: "line", Landed: "line", Uncharted: "line",
};
const WAITS_ON: Record<PolarisClass, string> = {
  "Cleared to land": "you", "Needs you": "you or its session", Drifting: "CI or Polaris", "In orbit": "CI", Docked: "you", Landed: "you", Uncharted: "GitHub",
};

export type ItemAct =
  | { kind: "sync" }
  | { kind: "open"; url: string }
  | { kind: "beacon" }
  | { kind: "undock" }
  | { kind: "dock" }
  | { kind: "ignore" }
  | { kind: "course"; text: string }
  | { kind: "cleanup" }
  | { kind: "would-relaunch" };
export interface ItemButton { label: string; what: ItemAct; /** Drawn greyed: it says what a dry run would do, or what is already done. */ ghost?: boolean }

export interface ItemView {
  number: number;
  title: string;
  cls: PolarisClass;
  tone: ItemTone;
  sentence: string;
  waitsOn: string;
  /** The red is the base branch's too: a grey chip beside the class, not a red one. */
  inherited: boolean;
  /** The one button of the course, or null when there is nothing to click. */
  act: ItemButton | null;
  /** Quieter clicks beside it: propose a course, dock it, leave it. Each is the person's, and each does only what its word says. */
  more: ItemButton[];
  /** A line under the sentence: a draft waits, or a pass found nothing new. */
  note: string | null;
}

const excludedOf = (d: DoorValue): number[] => (Array.isArray(d.excluded) ? (d.excluded as number[]) : []);

/** What one item shows: its class, why, who it waits on and the one button of its course. Polaris never merges: a cleared item only opens GitHub. */
export function itemView(item: PolarisItem, doors: SettingsAnswer["doors"]): ItemView {
  const v = itemCourse(item, doors);
  if (item.ignored) return { ...v, act: null, note: "Left alone for this reason. It is looked at again when the reason changes." };
  return { ...v, ...moreOf(item, doors, v) };
}

/** The proposal text of a course: the three things a person can do with a pull request that keeps drifting. */
export const courseText = (item: PolarisItem): string => `#${item.number} keeps drifting. Send its session a beacon, dock it for a week, or leave it.`;

/** The quieter clicks: propose a course (Drifting, course door on), dock it (dock door on), leave it. */
function moreOf(item: PolarisItem, doors: SettingsAnswer["doors"], v: ItemView): Pick<ItemView, "more" | "note"> {
  const more: ItemButton[] = [];
  let note = v.note;
  if (item.cls === "Drifting" && doors.course.mode === "hours") {
    if (item.proposed.includes("course")) note = note ?? "A course is proposed: beacon the session, dock it, or leave it.";
    else more.push({ label: "Propose a course", what: { kind: "course", text: courseText(item) } });
  }
  const canDock = doors.dock.mode === "on" && ["Needs you", "Drifting", "In orbit", "Cleared to land", "Uncharted"].includes(item.cls) && !excludedOf(doors.dock).includes(item.number);
  if (canDock) more.push({ label: "Dock", what: { kind: "dock" } });
  if (item.cls === "Needs you" || item.cls === "Drifting" || item.cls === "Cleared to land") more.push({ label: "Leave it", what: { kind: "ignore" } });
  return { more, note };
}

function itemCourse(item: PolarisItem, doors: SettingsAnswer["doors"]): ItemView {
  const base = { number: item.number, title: item.title, cls: item.cls, tone: CLASS_TONE[item.cls], sentence: item.sentence, waitsOn: WAITS_ON[item.cls], note: null as string | null, more: [] as ItemButton[], inherited: item.reason === "inherited" };
  const open = { label: "Open PR", what: { kind: "open", url: item.url } as ItemAct };
  switch (item.cls) {
    case "Cleared to land":
      // The person merges by hand on GitHub: a copied command would invite a merge from the terminal.
      return { ...base, act: { label: "Open on GitHub", what: { kind: "open", url: item.url } } };
    case "Needs you":
      if (item.reason === "inherited") return { ...base, act: item.canSync ? { label: "Sync", what: { kind: "sync" } } : open };
      return item.draft
        ? { ...base, note: "A beacon is drafted for its session.", act: { label: "Review beacon", what: { kind: "beacon" } } }
        : { ...base, act: open };
    case "Drifting": {
      const mode = doors.relaunch.mode;
      if (item.dropped.length === 0) return { ...base, act: open };
      if (mode === "dry") return { ...base, act: { label: "Would relaunch", what: { kind: "would-relaunch" }, ghost: true } };
      return mode === "live" ? { ...base, note: "Polaris runs the dropped job again by itself.", act: null } : { ...base, act: open };
    }
    case "Docked":
      return { ...base, act: excludedOf(doors.dock).includes(item.number) ? { label: "Undock", what: { kind: "undock" } } : null };
    case "Landed":
      if (doors.cleanup.mode !== "propose") return { ...base, act: null };
      return item.proposed.includes("cleanup")
        ? { ...base, act: { label: "Cleanup proposed", what: { kind: "cleanup" }, ghost: true } }
        : { ...base, act: { label: "Propose cleanup", what: { kind: "cleanup" } } };
    default:
      return { ...base, act: null };
  }
}

/** The numbers of an excluded list without one. */
export const withoutNumber = (d: DoorValue, n: number): DoorValue => ({ ...d, excluded: excludedOf(d).filter((x) => x !== n) });

/** Items that wait on the person: Needs you always, Cleared to land unless that door is off, and any with a sync draft for its session. */
export function waitingOnYou(items: readonly PolarisItem[], doors: SettingsAnswer["doors"]): PolarisItem[] {
  return sortItems(items).filter((i) => !i.ignored && (i.cls === "Needs you" || (i.cls === "Cleared to land" && doors.cleared.mode !== "off") || i.syncDraft !== null));
}
/** The beacon an item shows: the one for its current reason, or the sync note, which is kept under the reason "synced". */
export function beaconOf(item: PolarisItem): { draft: string | null; reason: string | undefined } {
  return item.draft !== null || item.syncDraft === null ? { draft: item.draft, reason: item.reason ?? undefined } : { draft: item.syncDraft, reason: "synced" };
}

// ── a red the base has too ──

const sha7 = (s: string) => s.slice(0, 7);
const prs = (n: number) => `${n} pull request${n === 1 ? "" : "s"}`;
export interface BannerView {
  base: string;
  tone: "red" | "fixed";
  title: string;
  detail: string;
  url?: string;
  /** Sync all: the pull requests it syncs, or null while the base is red or none can. */
  syncAll: { label: string; numbers: number[] } | null;
}
/** One banner per base that some pull request inherits a red from. Empty while that is not true. */
export function baseBanners(bases: readonly BaseRed[] | undefined): BannerView[] {
  return (bases ?? []).map((b) => {
    const checks = b.checks.join(", ");
    const url = b.url ? { url: b.url } : {};
    if (!b.fixed) {
      return { base: b.base, tone: "red" as const, title: `${b.base} is red on ${checks} since ${sha7(b.sinceSha)}.`, detail: `${prs(b.inheritors.length)} inherit${b.inheritors.length === 1 ? "s" : ""} it.`, ...url, syncAll: null };
    }
    const wait = b.inheritors.length - b.canSync.length;
    return {
      base: b.base, tone: "fixed" as const, title: `${b.base} is fixed at ${sha7(b.tipSha)}.`,
      detail: `${b.canSync.length} of ${prs(b.inheritors.length)} can sync${wait > 0 ? `; ${wait} still ${wait === 1 ? "has" : "have"} checks running` : ""}.`, ...url,
      syncAll: b.canSync.length ? { label: `Sync all (${b.canSync.length})`, numbers: [...b.canSync] } : null,
    };
  });
}
/** The note that pops when a base goes green with something to sync, keyed by the fixing commit so it shows once per fix. */
export function fixNotice(bases: readonly BaseRed[] | undefined): { key: string; text: string } | null {
  const b = (bases ?? []).find((x) => x.fixed && x.canSync.length > 0);
  return b ? { key: `${b.base}@${b.tipSha}`, text: `${b.base} fixed at ${sha7(b.tipSha)}. ${prs(b.canSync.length)} can sync.` } : null;
}
/** The base an item inherits from, for the commit a sync names. */
export const baseOfItem = (bases: readonly BaseRed[] | undefined, number: number): BaseRed | undefined => bases?.find((b) => b.inheritors.includes(number));
/** What to say beside the Sync button when this machine's copy has commits GitHub does not have. */
export const syncWarning = (local: { ahead: number } | null): string | null =>
  local && local.ahead > 0 ? "Local commits not pushed. A sync will make your next push need a pull first." : null;
/** The line after a sync click: what happened, in plain words. */
export function syncResult(r: { ok: boolean; outcome?: string; error?: string } | null): string {
  if (!r) return "That did not go through";
  if (!r.ok) return r.error ?? "That did not go through";
  return r.outcome === "skipped-in-dry-run" ? "Dry run: nothing was pushed. Make the relaunch door live to sync for real." : "Syncing. Polaris watches the new checks.";
}
/** Cleared to land rings only when that door says so; everything else here is a quiet row. */
export const ringsFor = (item: PolarisItem, doors: SettingsAnswer["doors"]): boolean => item.cls === "Cleared to land" && doors.cleared.mode === "bell";

/** Per-class counts for the section's one-line summary, in the order a person reads them. */
export function classCounts(items: readonly PolarisItem[]): { cls: PolarisClass; n: number }[] {
  return CLASS_ORDER.map((cls) => ({ cls, n: items.filter((i) => i.cls === cls).length })).filter((c) => c.n > 0);
}

// ── beacon ──

/** Whether Send can be pressed, and what to say beside it. With match on the server finds the one session; with ask the person picks. */
export function sendState(match: string, picked: string): { can: boolean; hint: string } {
  if (picked) return { can: true, hint: "Goes to the session you picked, once, when it is idle." };
  return match === "use"
    ? { can: true, hint: "Goes to the one session on this branch, once, when it is idle." }
    : { can: false, hint: "Pick the session it goes to." };
}

/** The edit of a beacon draft can be saved: some text, and not the text it already has. */
export const draftSaveable = (current: string | null, edited: string): boolean => edited.trim().length > 0 && edited.trim() !== (current ?? "").trim();

// ── the settings format ──

export interface FormatNotice { from: number; to: number; badge: string; doors: DoorId[]; sentence: string; example: string }
/** Whether the layer being edited has anything the person stored. */
export const hasLayer = (a: SettingsAnswer, scope: Scope): boolean =>
  a.enabledLayer === scope || a.presetLayer === scope || DOOR_IDS.some((d) => a.layers[d] === scope);

/** The chip beside the card: the format the layer is saved in, or the move from an older one. */
export const formatBadge = (a: SettingsAnswer, current = POLARIS_VERSION): string => (a.version < current ? `Format ${a.version} to ${current}` : `Format ${a.version}`);

/** What a layer saved in an older format is told on opening: the doors a later format added, off for it until it turns them on. Null when there is nothing to say. */
export function formatNotice(a: SettingsAnswer, scope: Scope, current = POLARIS_VERSION, since: Partial<Record<DoorId, number>> = DOOR_SINCE): FormatNotice | null {
  if (a.version >= current || !hasLayer(a, scope)) return null;
  const doors = DOOR_IDS.filter((d) => (since[d] ?? 1) > a.version);
  if (!doors.length) return null;
  const names = doors.map((d) => `“${DOOR_COPY[d].name}”`);
  return {
    from: a.version, to: current, badge: formatBadge(a, current), doors,
    sentence: doors.length === 1
      ? `Polaris has one new door. ${names[0]} is off for you until you turn it on. Your other doors did not change.`
      : `Polaris has ${doors.length} new doors. ${names.join(", ")} are off for you until you turn them on. Your other doors did not change.`,
    example: DOOR_COPY[doors[0]!].example,
  };
}
/** Saving the layer in the current format closes the notice; the doors are as they were. */
export const stampFormat = (a: SettingsAnswer, scope: Scope, current = POLARIS_VERSION): SettingsChange => ({ settings: { ...storedOf(a, scope), version: current } });
/** Undo puts back the layer as it was before the notice was closed. */
export const undoStamp = (before: StoredPolaris): SettingsChange => ({ settings: before });

// ── Assisted setup ──

export type AssistState = { ok: true; engine: string; title: string } | { ok: false; why: string };
/** The engine for Assisted setup is the one set for the builder role; none installed means the button waits. */
export function assistState(roles: { ok: boolean; roles?: Record<string, { provider: string }>; providers?: { id: string; title: string; installed: boolean }[] } | null): AssistState {
  const kind = roles?.ok ? roles.roles?.builder?.provider : undefined;
  if (!kind) return { ok: false, why: "No agent engine is set up to run this." };
  const p = roles?.providers?.find((x) => x.id === kind);
  if (p && !p.installed) return { ok: false, why: `${p.title} is not installed here.` };
  return { ok: true, engine: kind, title: p?.title ?? kind };
}

/** The prompt of the terminal the button opens: the agent reads the doors and sets them through the settings door, never by editing files. */
export function assistPrompt(root: string): string {
  const ids = DOOR_IDS.map((d) => `polaris.door.${d}`).join(", ");
  const scope = root ? ` --root ${root}` : "";
  return [
    "Help me set up Polaris, the pull request abilities of the orchestrator in agentglass.",
    `Read the current doors with: agentglass-ui settings get polaris.enabled${scope}, then agentglass-ui settings get polaris.door.<door>${scope} for each of ${ids}.`,
    `Change one with: agentglass-ui settings set polaris.door.<door> '<json>'${scope}. A door value is {"mode": "...", ...settings}.`,
    "Narrowing a door applies at once. Opening one wider, or turning anything live, waits for my click in the app; say so when it does.",
    "Ask me about my team and repository first (who reviews, which checks gate a merge, whether CI drops jobs), then propose the doors one group at a time: Watching, Landing, Signals, Automatic, Limits.",
    "Never merge, comment, label or post anything. Polaris itself never does.",
  ].join("\n");
}
