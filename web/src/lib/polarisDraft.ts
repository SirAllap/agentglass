// The Polaris view's draft as one value. Every click and every Save goes through these
// functions, so what one Save writes is decided here and not inside the component's handlers.
// A draft's doors are the positions its rows draw: every transition re-derives them from the
// layer the save would write, so the draft, the rows and the Save cannot disagree.
import {
  DOOR_IDS, DOOR_MODES, PRESETS, resolvePolaris,
  type DoorId, type DoorValue, type PolarisPresetName, type PresetId, type SettingsAnswer, type StoredPolaris,
} from "../../../shared/polaris.ts";
import {
  doorEdits, effectiveAfter, layerToSave, liveSentence, ownedDoors, patchChanges, withoutDoor, type Effective, type Scope,
} from "./polarisView.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface Draft {
  /** The positions the rows show: this draft's resets, preset and edits, resolved against the layer below. */
  doors: Record<DoorId, DoorValue>;
  preset: PolarisPresetName;
  /** The preset card pressed on this draft: a choice even when it is already the label it inherits. */
  picked: PresetId | null;
  enabled: boolean;
}

export interface DraftState {
  /** The answer the draft was built from: what Discard restores and what a change is measured against. */
  base: SettingsAnswer;
  draft: Draft;
  /** The doors this Save drops, so the layer below is in force again. */
  resets: Set<DoorId>;
}

/** The positions one save leaves: the one function the rows, the diff and the confirmation all read. */
const resolved = (base: SettingsAnswer, scope: Scope, resets: ReadonlySet<DoorId>, picked: PresetId | null, doors: Record<DoorId, DoorValue>): Record<DoorId, DoorValue> =>
  effectiveAfter(base, scope, resets, picked, doorEdits(doors, base.doors, resets)).doors;

/** A draft whose doors are exactly the positions its own save plan leaves. */
const reseated = (base: SettingsAnswer, scope: Scope, draft: Draft, resets: ReadonlySet<DoorId>): Draft =>
  ({ ...draft, doors: resolved(base, scope, resets, draft.picked, draft.doors) });

export const draftState = (a: SettingsAnswer): DraftState => ({
  base: a,
  draft: { doors: structuredClone(a.doors), preset: a.preset, picked: null, enabled: a.enabled },
  resets: new Set(),
});

export function pickPreset(s: DraftState, scope: Scope, id: PresetId): DraftState {
  // A reset is dropped rather than kept: the preset writes every one of its doors on the save, so
  // keeping them would be nearly the same draft. Not a guard: the door that matters is the preset.
  const resets = new Set<DoorId>();
  const draft = { ...s.draft, preset: id, picked: id, doors: structuredClone(PRESETS[id].doors) };
  return { ...s, resets, draft: reseated(s.base, scope, draft, resets) };
}

export function patchDoor(s: DraftState, scope: Scope, door: DoorId, patch: Record<string, unknown>): DraftState {
  const shown = savePlan(s, scope).effective.doors;
  // A click on the value a row already shows is no edit: it must not take back "use global" and leave Save disabled.
  if (!patchChanges(shown[door], patch)) return s;
  const resets = withoutDoor(s.resets, door);
  const draft: Draft = { ...s.draft, picked: null, preset: s.draft.preset === "none" ? "none" : "custom", doors: { ...shown, [door]: { ...shown[door], ...patch } } };
  return { ...s, resets, draft: reseated(s.base, scope, draft, resets) };
}

/** One block at its safest position: each of its doors back to its first mode, the numbers left alone. */
export function safestPosition(s: DraftState, scope: Scope, doors: readonly DoorId[]): DraftState {
  const resets = new Set([...s.resets].filter((d) => !doors.includes(d)));
  const next = { ...savePlan(s, scope).effective.doors };
  for (const door of doors) next[door] = { ...next[door], mode: DOOR_MODES[door][0] };
  const draft: Draft = { ...s.draft, picked: null, preset: s.draft.preset === "none" ? "none" : "custom", doors: next };
  return { ...s, resets, draft: reseated(s.base, scope, draft, resets) };
}

/** The positions of the layer below: for a project, the global layer as stored. */
export const belowDoors = (a: SettingsAnswer, scope: Scope): Record<DoorId, DoorValue> =>
  scope === "project" ? resolvePolaris(a.below ?? {}, null).settings.doors : structuredClone(PRESETS.guided.doors);

/**
 * A block back to the global setting. The rows must show what takes over, not the value this layer
 * is dropping: the reset is what the save writes, the position below is what the person then has.
 * A door this draft moved is taken back too, or the button would leave a pressed preset in force.
 */
export function useGlobalDoors(s: DraftState, scope: Scope, doors: readonly DoorId[]): DraftState {
  if (scope !== "project") return s;
  const owned = ownedDoors(s.base, scope, doors);
  const taken = doors.filter((d) => owned.includes(d) || s.resets.has(d) || !same(s.draft.doors[d], s.base.doors[d]));
  if (!taken.length) return s;
  const below = belowDoors(s.base, scope);
  const resets = new Set([...s.resets, ...taken]);
  const next = { ...savePlan(s, scope).effective.doors };
  for (const door of taken) next[door] = structuredClone(below[door]);
  // A reset pressed after a preset is the later word: the preset label goes, its values stay on
  // the doors this block does not touch.
  const draft = { ...s.draft, picked: null, doors: next };
  return { ...s, resets, draft: reseated(s.base, scope, draft, resets) };
}

/** The doors "Use the general setting" would take back: the layer's own, or ones this draft moved off it. */
export function draftedDoors(s: DraftState, scope: Scope, doors: readonly DoorId[]): DoorId[] {
  const owned = ownedDoors(s.base, scope, doors);
  return doors.filter((d) => owned.includes(d) || s.resets.has(d) || !same(s.draft.doors[d], s.base.doors[d]));
}

export const toggleEnabled = (s: DraftState): DraftState => ({ ...s, draft: { ...s.draft, enabled: !s.draft.enabled } });

/**
 * A refreshed answer arriving under a draft that is kept: the person's clicks stay, measured on
 * the layer the save will write. The rows and the plan are re-derived at Save anyway, so this
 * re-derive is for the rows drawn between the refresh and the next click, not for the save.
 */
export function rebaseDraft(s: DraftState, a: SettingsAnswer, scope: Scope): DraftState {
  const edits = doorEdits(s.draft.doors, s.base.doors, s.resets);
  const doors = effectiveAfter(a, scope, s.resets, s.draft.picked, edits).doors;
  return { base: a, resets: s.resets, draft: { ...s.draft, doors } };
}

export interface SavePlan {
  resets: Set<DoorId>;
  chosen: PresetId | null;
  edits: Partial<Record<DoorId, DoorValue>>;
  effective: Effective;
  /** Every door that would act without asking once saved. */
  live: DoorId[];
  /** The doors that need the person's word before this Save: a live position coming into force or becoming this layer's own. */
  consent: DoorId[];
  moved: DoorId[];
  dirty: boolean;
  presetMoved: boolean;
  unsaved: number;
}

/**
 * What Save changes would write, and what it would leave in force. The preset written is the card
 * the person pressed, never the label they started from, and a reset door is dropped instead of
 * stored whole: a door-only save writes that door and nothing it inherits.
 */
export function savePlan(s: DraftState, scope: Scope): SavePlan {
  const chosen = s.draft.picked;
  // The doors a preset set are the preset's, not edits: measured against it, a card pressed on its
  // own moves nothing and the name is stored, and only a door moved afterwards counts as custom.
  const from = chosen ? PRESETS[chosen].doors : s.base.doors;
  const edits = doorEdits(s.draft.doors, from, s.resets);
  const effective = effectiveAfter(s.base, scope, s.resets, chosen, edits);
  const moved = DOOR_IDS.filter((d) => !same(s.draft.doors[d], from[d]) || s.resets.has(d));
  const presetMoved = chosen !== null || s.draft.preset !== s.base.preset;
  const enabledMoved = s.draft.enabled !== s.base.enabled;
  return {
    resets: s.resets, chosen, edits, effective, live: effective.live, consent: effective.consent, moved, presetMoved,
    dirty: moved.length > 0 || presetMoved || enabledMoved,
    // A preset card is one choice; once a door is moved the card is no longer the choice and the
    // count is what a save would write, not the one label it also writes.
    unsaved: (chosen !== null ? 1 : moved.length) + (enabledMoved ? 1 : 0),
  };
}

/** What Save changes: the consent it asks for and the layer it writes, from the one plan. */
export interface SaveCommit { plan: SavePlan; layer: StoredPolaris }

/** One Save, decided once: the plan the confirmation reads is the plan the layer is written from. */
export function saveCommit(s: DraftState, answer: SettingsAnswer, scope: Scope): SaveCommit {
  const plan = savePlan({ ...s, base: answer }, scope);
  return { plan, layer: layerToSave(answer, scope, plan.resets, plan.chosen, plan.edits) };
}

/** The sentence under each door the confirmation names. */
export const consentSentence = (door: DoorId, eff: Effective): string => liveSentence(door, eff.doors[door]);
