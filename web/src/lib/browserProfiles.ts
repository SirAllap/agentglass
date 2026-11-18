/**
 * Separate browsing identities, the way Orca's "New Profile…" gives them.
 *
 * One partition means one cookie jar: signing into a site as yourself and as a
 * test user needs two windows, or a sign-out between them. Chromium already
 * keeps profiles apart perfectly — the only thing missing here was letting a
 * tab say which one it belongs to.
 *
 * A profile IS its partition. There is no store to keep in sync, no migration,
 * and nothing to garbage-collect: the cookies live in the partition Chromium
 * makes on first use, and deleting a profile here only forgets the name. That
 * is deliberate — an "erase everything for this profile" button is a different
 * feature with a confirmation dialog, and pretending a rename does it would be
 * the worse kind of surprise.
 *
 * The default profile keeps the bare partition it has always had, so every tab
 * anybody already had open stays signed in to what it was signed in to.
 */

import { isAgentContainer } from "../../../shared/workerContainer.ts";

export interface BrowserProfile {
  /** Slug, and the partition suffix. Empty is the default profile. */
  id: string;
  name: string;
  /** S9: send `X-Agentglass-Agent` to a dev origin from this profile's tabs.
   *  Off unless the profile turns it on — see identify-header.js for what a
   *  dev origin is and why. Absent
   *  is the same as false, so a profile saved before this existed opens off. */
  identify?: boolean;
  /** When a tab last used this container, in ms. Absent on a container saved
   *  before this existed, which reads as "idle since forever" — see `droppable`. */
  usedAt?: number;
  /** An agent's own ask made it. Ids are slugs of names, so a container the
   *  person makes later can land on a removed agent container's id: only this
   *  flag, never the id, lets the vault sign it in or wipe it. */
  agentMade?: boolean;
}

export const DEFAULT_PROFILE: BrowserProfile = { id: "", name: "Default" };

/**
 * How many identities are worth keeping in a menu.
 *
 * Not a technical limit — each one is only a directory Chromium creates lazily.
 * It is a limit on the menu: past a handful, a strip of profile names stops
 * being something you pick from and starts being something you search.
 */
/* Sized for a fleet, not for a person's two or three identities. A profile is
   a name and an id in a list; what costs anything is a tab awake inside it,
   and that is capped where it is spent — see MAX_TABS. */
export const MAX_PROFILES = 64;

/**
 * The shape a partition suffix may take, and the reason it is this narrow.
 *
 * The main process validates the partition a guest attaches on and refuses
 * anything outside the browser's own family. This is the renderer's half of
 * that agreement: lowercase and digits only, so a name can never carry a path
 * separator, a `persist:` of its own, or anything else that would make the
 * string mean something other than "a browsing profile".
 */
const SLUG = /^[a-z0-9]{1,16}$/;

export const isProfileId = (id: string): boolean => id === "" || SLUG.test(id);

/**
 * The partition a tab in this profile attaches on.
 *
 * The default profile is the base string unchanged. That is what keeps every
 * existing login working: had profiles been given a suffix each, the first
 * launch after this would have looked like being signed out of everything.
 */
export function partitionFor(base: string, profileId: string): string {
  if (!base) return base;
  if (!profileId) return base;
  if (isProfileId(profileId)) return `${base}-${profileId}`;
  /*
   * NOT AN ID — AND STILL NOT THE SHARED JAR.
   *
   * This fell through to `base` for anything it did not recognise, and `base`
   * is the person's own cookies. Measured: a tab asking for `pol-proj9175` or
   * for `review-pr-540` — the name the skill's own example uses — attached to
   * `persist:agx`, the default. It was labelled with the profile it asked for
   * the whole time, so `tabs` reported an isolated identity while the requests
   * carried the person's session. An hour of work in the wrong container, no
   * error anywhere.
   *
   * A name is not an id (ids are slugged, names keep their dashes), so the fix
   * upstream is to resolve one to the other. This is the floor under that: an
   * identity we cannot read gets a jar of its own rather than everybody's.
   */
  const own = profileId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15) || "unnamed";
  /* 15 plus the marker, because the main process only admits a suffix of
     sixteen — it validates every partition it is handed, and a longer one
     would be refused there instead of isolating anything. */
  return `${base}-x${own}`;
}

/** A slug from what the user typed, distinct from the ones already taken.
 *  Names are theirs to choose and repeat; ids are not. */
export function mintProfileId(name: string, taken: readonly string[]): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "profile";
  if (!taken.includes(stem)) return stem;
  for (let n = 2; n < 100; n++) {
    const tried = `${stem}${n}`.slice(0, 16);
    if (!taken.includes(tried)) return tried;
  }
  // Ninety-eight collisions on one stem is not a case worth code, but returning
  // a duplicate id would silently merge two profiles' cookies.
  return `p${Date.now().toString(36).slice(-6)}`;
}

/** `dropped` is the idle agent container given up to make room, when one was. */
type Made = { profiles: BrowserProfile[]; profile: BrowserProfile; dropped?: BrowserProfile } | { error: string };

/** A person's profile. The reserved namespace is not theirs to take: an agent's
 *  container and a person's must never be able to collide by name. */
export function addProfile(profiles: readonly BrowserProfile[], rawName: string, room?: Room, by?: "agent"): Made {
  const name = rawName.trim().slice(0, 24);
  if (!name) return { error: "give it a name" };
  if (isAgentContainer(name)) return { error: "that name is reserved for an agent's own container" };
  return mintNamed(profiles, name, room, by === "agent");
}

/** An agent's container. The name arrives namespaced by the relay, and it is
 *  ALWAYS minted — never resolved against the existing list, which is what put
 *  a worker named like a person's profile inside the person's logins. */
export function mintAgentProfile(profiles: readonly BrowserProfile[], rawName: string, room?: Room): Made {
  /* No cap here: `agent:` + a legal 64-character name is 70, and slicing it
     made a container the relay's own `agentContainerName` never matched. The
     relay validates the name; a stored profile name is not a path. */
  const name = rawName.trim();
  if (!isAgentContainer(name)) return { error: "an agent's container name is namespaced by the relay" };
  const mine = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (mine) return { profiles: [...profiles], profile: mine };
  return mintNamed(profiles, name, room, true);
}

function mintNamed(profiles: readonly BrowserProfile[], name: string, room?: Room, agentMade = false): Made {
  let dropped: BrowserProfile | undefined;
  if (profiles.length >= MAX_PROFILES) {
    dropped = room ? droppable(profiles, room)[0] : undefined;
    if (!dropped) return { error: FULL_REFUSAL };
    profiles = profiles.filter((p) => p.id !== dropped!.id);
  }
  /* A dropped id is never minted again: its partition may still be mid-wipe,
     and an agent handed it would see the last one's cookies, then lose its own
     login when the wipe lands. Every agent id starts `agent`, so two names
     colliding on 12 letters is the normal case, not a rare one. */
  const taken = [...profiles.map((p) => p.id), ...(room?.retired ?? []), ...(dropped ? [dropped.id] : [])];
  // The default is not in the list and cannot be shadowed by a second "Default".
  if (name.toLowerCase() === DEFAULT_PROFILE.name.toLowerCase()) return { error: "that name is taken" };
  if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: "that name is taken" };
  const profile: BrowserProfile = {
    id: mintProfileId(name, taken), name, ...(room ? { usedAt: room.now } : {}), ...(agentMade ? { agentMade: true } : {}),
  };
  return { profiles: [...profiles, profile], profile, ...(dropped ? { dropped } : {}) };
}

/** What a full list may give up, and when. */
export interface Room {
  /** Container ids with a tab open in them. */
  busy: ReadonlySet<string>;
  /** Container ids a lane window is attached on. */
  lanes: ReadonlySet<string>;
  now: number;
  /** Ids of containers dropped before, never handed out again — see `retireIds`. */
  retired?: ReadonlySet<string>;
}

/** An agent's container left idle this long may be dropped to make room. */
export const IDLE_DROP_MS = 24 * 60 * 60 * 1000;

export const FULL_REFUSAL = `${MAX_PROFILES} containers is the limit: Settings ▸ Browser ▸ Containers ▸ Remove unused`;

/**
 * The containers that may go, oldest first.
 *
 * Only an agent's own (`agent:*`): a person's container is theirs to remove.
 * Never one with a tab open, never one a lane window is attached on, and never
 * one used in the last day. A container saved before `usedAt` existed has no
 * date and counts as the oldest — those are exactly the leftovers of workers
 * long gone that filled the list.
 */
export function droppable(profiles: readonly BrowserProfile[], room: Room): BrowserProfile[] {
  return profiles
    .filter((p) => isAgentContainer(p.name) && !room.busy.has(p.id) && !room.lanes.has(p.id))
    .filter((p) => room.now - (p.usedAt ?? 0) > IDLE_DROP_MS)
    .sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
}

/** The line the person's log gets when a container is dropped to make room. */
export function droppedNote(p: BrowserProfile): string {
  const since = p.usedAt ? new Date(p.usedAt).toISOString().slice(0, 10) : "before use was recorded";
  return `dropped container ${p.name}, idle since ${since}`;
}

/**
 * "Remove unused" in Settings, served by whoever holds the live list.
 *
 * The Browser panel registers while it is mounted: it knows which containers
 * have a tab open, and it owns the list. With no panel mounted there is no tab
 * open anywhere, and Settings reads the stored list itself (`unusedFromStore`).
 */
export interface UnusedContainers { list(): BrowserProfile[]; remove(ids: readonly string[]): number }
let unused: UnusedContainers | null = null;
export function setUnusedContainers(h: UnusedContainers | null): void { unused = h; }
export function unusedContainers(): UnusedContainers | null { return unused; }

/** The panel-less half: the stored list, with a container's saved strip
 *  counting as a tab so a container the person will reopen is kept. */
export function unusedFromStore(
  store: Pick<Storage, "getItem" | "setItem"> | null, saved: (id: string) => number, lanes: ReadonlySet<string>, now: number,
  /** The ids a confirm counted: only those go, and only while still droppable. */
  only?: readonly string[],
): { gone: BrowserProfile[]; kept: BrowserProfile[] } {
  const all = loadProfiles(store);
  const busy = new Set(all.filter((p) => saved(p.id) > 0).map((p) => p.id));
  const gone = droppable(all, { busy, lanes, now }).filter((p) => !only || only.includes(p.id));
  const ids = new Set(gone.map((p) => p.id));
  return { gone, kept: all.filter((p) => !ids.has(p.id)) };
}

/** Mark these containers used now. Same list back when nothing moved, so a
 *  caller can skip the save; a stamp less than an hour old is left alone.
 *  `closed` lost its last tab just now: always stamped, because idle starts
 *  there — a tab open 30 h with no strip change left a 30 h old stamp. */
export function touchProfiles(
  profiles: readonly BrowserProfile[], ids: ReadonlySet<string>, now: number, closed: ReadonlySet<string> = new Set(),
): readonly BrowserProfile[] {
  let moved = false;
  const next = profiles.map((p) => {
    if (closed.has(p.id) && p.usedAt !== now) { moved = true; return { ...p, usedAt: now }; }
    if (!ids.has(p.id) || now - (p.usedAt ?? 0) < 60 * 60 * 1000) return p;
    moved = true;
    return { ...p, usedAt: now };
  });
  return moved ? next : profiles;
}

/** Forget the name. The partition's cookies stay where they are — see the note
 *  at the top: erasing them is a different button with a different question. */
export function removeProfile(profiles: readonly BrowserProfile[], id: string): BrowserProfile[] {
  return profiles.filter((p) => p.id !== id);
}

export function profileName(profiles: readonly BrowserProfile[], id: string): string {
  if (!id) return DEFAULT_PROFILE.name;
  return profiles.find((p) => p.id === id)?.name ?? id;
}

const KEY = "agx_browser_profiles";
const RETIRED_KEY = "agx_browser_retired";
/** Enough that a retired id comes back only long after its wipe finished. */
const MAX_RETIRED = 256;

/** Ids of dropped containers, newest last. Unreadable reads as none. */
export function retiredIds(store: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const doc: unknown = JSON.parse(store?.getItem(RETIRED_KEY) ?? "[]");
    return new Set(Array.isArray(doc) ? doc.filter((id): id is string => typeof id === "string" && SLUG.test(id)) : []);
  } catch {
    return new Set();
  }
}

/** Mark ids as dropped, before their wipe starts, so no mint reuses them. */
export function retireIds(store: Pick<Storage, "getItem" | "setItem"> | null, ids: readonly string[]): void {
  const all = [...retiredIds(store)].filter((id) => !ids.includes(id));
  const next = [...all, ...ids.filter(isProfileId).filter(Boolean)].slice(-MAX_RETIRED);
  try { store?.setItem(RETIRED_KEY, JSON.stringify(next)); } catch { /* private mode, quota, no store */ }
}

/**
 * Read the list back, defensively.
 *
 * Anything unreadable is treated as "no profiles yet" rather than thrown: this
 * runs while the browser panel is mounting, and a bad line in localStorage must
 * not be the reason the panel does not draw. A tab whose profile has been
 * forgotten still works — it keeps its partition and the menu shows the raw id.
 */
export function loadProfiles(store: Pick<Storage, "getItem" | "setItem"> | null): BrowserProfile[] {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return [];
    const doc: unknown = JSON.parse(raw);
    if (!Array.isArray(doc)) return [];
    const out: BrowserProfile[] = [];
    for (const p of doc) {
      const { id, name, identify, usedAt, agentMade } = (p ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string" || !id || !SLUG.test(id)) continue;
      if (out.some((o) => o.id === id)) continue;
      /* No name cap here either: `addProfile` already bounds a person's name,
         and an agent's container is `agent:` + a legal 64-character name. */
      out.push({
        id, name,
        ...(identify === true ? { identify: true } : {}),
        ...(typeof usedAt === "number" && Number.isFinite(usedAt) && usedAt > 0 ? { usedAt } : {}),
        /* A reserved `agent:` name is never a person's (addProfile refuses it). */
        ...(agentMade === true || isAgentContainer(name) ? { agentMade: true } : {}),
      });
    }
    return out.slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function saveProfiles(store: Pick<Storage, "getItem" | "setItem"> | null, profiles: readonly BrowserProfile[]): void {
  try { store?.setItem(KEY, JSON.stringify(profiles)); } catch { /* private mode, quota, no store */ }
}

/**
 * A colour for a profile, derived from its id rather than stored.
 *
 * The tab strip mixes profiles, so a tab has to say which identity it is
 * without being read: a dot is glanceable where a name in a menu is not. The
 * hue is a hash so it never has to be picked, migrated, or kept unique — two
 * profiles landing on similar hues is a much smaller problem than a colour
 * field that can disagree with the name it belongs to.
 */
export function profileHue(id: string): number {
  /*
   * NEIGHBOURING NAMES MUST NOT GET NEIGHBOURING COLOURS.
   *
   * This used to be `h = (h * 31 + charCode) % 360` read straight as a hue,
   * and the last character of a name moved the answer by ONE degree. Agents
   * are named in series — aglab2, aglab3, aglab4 — so ten containers came out
   * ten shades of the same yellow. Measured on a real bar: indistinguishable.
   *
   * So: mix the whole string properly (FNV-1a), then step around the wheel by
   * the golden angle. Two hashes one apart land 137° apart, which is the
   * opposite of the old behaviour and exactly what a list of aglab1..aglab10
   * needs.
   */
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  /*
   * And the answer is one of fourteen, not one of 360.
   *
   * A free hue puts two containers 4° apart as easily as 140° — measured, with
   * the golden angle alone: aglab6 at 216 and aglab9 at 220, which on screen is
   * one colour. Two that land on the SAME slot are a smaller problem than two
   * that land 4° apart: the first reads as "these two share a colour", the
   * second reads as a rendering artefact and is read wrong.
   *
   * Fourteen, spaced by at least 14°, and none of them in the 90–150 band this
   * app spends on "success" — a container is not a status.
   */
  return HUES[h % HUES.length]!;
}

const HUES = [222, 258, 285, 312, 338, 8, 26, 42, 58, 74, 170, 188, 204, 160];

/**
 * Every partition this browser keeps cookies in.
 *
 * For the controls that must reach all of them — "forget these sites" is the
 * one that matters, since a privacy button that clears one jar of several is
 * worse than no button: it reports a number and looks finished.
 *
 * The default is always first and always present, whatever the caller passes:
 * a list built from the profile menu alone would sweep the profiles and leave
 * the identity most people actually browse with untouched.
 */
export function partitionsFor(base: string, profileIds: readonly string[]): string[] {
  if (!base) return [];
  const out = [base];
  for (const id of profileIds) {
    /* Ids only. This list comes from the profile MENU, so anything that is not
       a minted id is a hand-edited file rather than a profile — and a sweep is
       the one place where widening on a bad value costs data. `partitionFor`
       is deliberately more forgiving: it has to put a tab SOMEWHERE, and the
       one place it must never put it is the person's own jar. */
    if (!isProfileId(id)) continue;
    const p = partitionFor(base, id);
    if (p !== base && !out.includes(p)) out.push(p);
  }
  return out;
}
