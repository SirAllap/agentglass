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

export interface BrowserProfile {
  /** Slug, and the partition suffix. Empty is the default profile. */
  id: string;
  name: string;
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

export function addProfile(profiles: readonly BrowserProfile[], rawName: string):
  { profiles: BrowserProfile[]; profile: BrowserProfile } | { error: string } {
  const name = rawName.trim().slice(0, 24);
  if (!name) return { error: "give it a name" };
  if (profiles.length >= MAX_PROFILES) return { error: `${MAX_PROFILES} profiles is the limit` };
  // The default is not in the list and cannot be shadowed by a second "Default".
  if (name.toLowerCase() === DEFAULT_PROFILE.name.toLowerCase()) return { error: "that name is taken" };
  if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: "that name is taken" };
  const profile = { id: mintProfileId(name, profiles.map((p) => p.id)), name };
  return { profiles: [...profiles, profile], profile };
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
      const { id, name } = (p ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string" || !id || !SLUG.test(id)) continue;
      if (out.some((o) => o.id === id)) continue;
      out.push({ id, name: name.slice(0, 24) });
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
