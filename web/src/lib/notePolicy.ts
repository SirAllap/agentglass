import type { SystemNote } from "./sysNotify.ts";

/**
 * What a note is allowed to do when it arrives.
 *
 * Every note behind the bell has a SOURCE — the Lantern, an agent asking, a
 * desktop app — and a LEVEL, its urgency. The two answer different questions:
 * the level decides how loud a note may be, the source is what a person can
 * say "not this one" about. Before this there were two unrelated switches and
 * neither was either: Quiet only reached the mirrored notes, and the switch for
 * agentglass's own alerts was all or nothing, so a desk of five agents put
 * dozens of rows behind the bell in an hour and "Quiet on" still showed them.
 *
 * Three levels, one rule each:
 *
 *   urgent (2)  something is STOPPED until a person acts. Always interrupts —
 *               popup, sound, badge — and cannot be muted by source.
 *   normal (1)  news. Badged; interrupts only with Quiet off.
 *   quiet  (0)  a row, findable, with its destination. No badge, no sound.
 *
 * Quiet is on by default: the calm reading of the bell is "only what is
 * stopped reaches you", and turning it off is a choice somebody makes.
 *
 * Mirrored desktop notes are never louder than normal and never interrupt with
 * Quiet on — the desktop already drew its own popup for them, so ours was the
 * second copy of the same interruption.
 */

/** Sources that stop an agent or answer a promise the person made. Muting
 *  one would turn "stop interrupting me" into "an agent blocked and nobody
 *  said", so the mute control is not offered for them. */
const UNMUTABLE = new Set(["gate", "understudy", "reminder", "devices"]);
export const canMute = (source: string): boolean => !UNMUTABLE.has(source);

export const DESKTOP = "desktop:";
export const isDesktop = (source: string): boolean => source.startsWith(DESKTOP);

/** Where a note came from, as the unit a person mutes. */
export function sourceOf(n: Pick<SystemNote, "app" | "source">): string {
  if (n.source) return n.source;
  return (n.app || "agentglass").trim().toLowerCase();
}

const LABELS: Record<string, string> = {
  gate: "Approvals",
  agents: "Agents",
  lantern: "Lantern",
  errors: "Failing agents",
  understudy: "Deputy",
  reminder: "Reminders",
  devices: "Paired devices",
  schedule: "Scheduled starts",
  git: "Branches behind",
  ci: "Checks",
  pr: "PR conversation",
  clickup: "Cards",
  update: "Updates",
  agentglass: "agentglass",
};

/** A source as a person would name it. */
export function sourceLabel(source: string): string {
  if (isDesktop(source)) {
    const app = source.slice(DESKTOP.length);
    return app ? app[0]!.toUpperCase() + app.slice(1) : "Desktop";
  }
  return LABELS[source] ?? source;
}

/** The filter a source sits under in the panel. */
export type Lane = "agents" | "work" | "desktop";
const AGENT_SOURCES = new Set(["gate", "agents", "lantern", "errors", "understudy", "schedule"]);
export function laneOf(source: string): Lane {
  if (isDesktop(source)) return "desktop";
  return AGENT_SOURCES.has(source) ? "agents" : "work";
}

export type Delivery = {
  /** Recorded in the list at all. */
  keep: boolean;
  /** Counts toward the unread badge. */
  badge: boolean;
  /** Takes the screen: a toast, a popup, a sound. Where it shows is whereItShows's answer. */
  interrupt: boolean;
};

/**
 * What a person said about one app: "pop up" (the default) or "bell only".
 * Mute is the third choice and lives in the muted set below, because a muted
 * row is not kept at all and a bell-only one is.
 */
export type AppRule = "popup" | "bell";
export const OUR_RULE = "agentglass";

export type PolicyState = {
  muted: ReadonlySet<string>;
  /** News pop-ups off (the stored `agentglass.sysNotify.quiet`). */
  quiet: boolean;
  /** Silence all: no card, no sound, no badge for anything but an agent that waits. */
  silence?: boolean;
  /** Per-app Pop up / Bell only, keyed by source ("desktop:slack") or OUR_RULE for agentglass's own news. */
  rules?: Readonly<Record<string, AppRule>>;
};

/**
 * Apps whose notes are worth keeping and not worth a pop-up: a screenshot tool
 * saying it saved, a player saying the track changed. Bell only unless the
 * person says otherwise — a rule they set wins over this list.
 */
const LOW_VALUE = /screenshot|hyprshot|grimblast|satty|flameshot|snapshot|spotify|music|playerctl|mpris|rhythmbox|cmus|mpd|ncspot/;
export const defaultRule = (source: string): AppRule =>
  isDesktop(source) && LOW_VALUE.test(source.slice(DESKTOP.length)) ? "bell" : "popup";

/** The rule that applies to a source: the person's, else the default. agentglass's own sources share one rule. */
export function ruleFor(source: string, rules: Readonly<Record<string, AppRule>> = {}): AppRule {
  const key = isDesktop(source) ? source : OUR_RULE;
  return rules[key] ?? defaultRule(key);
}

/**
 * Something stopped until the person acts, or something they armed by hand. It always reaches them.
 *
 * From the gate only a note with a key counts: that is the open hold, cleared
 * by its key when it resolves. An unkeyed gate note ("Approve X did not take")
 * is urgent but nothing is held any more, so it does not break through DND.
 *
 * A PR check result ("ci") is news even when red: it waits on nobody. Only a
 * "Tell me when" watch the person armed (`asked`) makes it break through.
 */
export const waitsOnYou = (n: Pick<SystemNote, "app" | "source" | "urgency"> & { asked?: boolean; key?: string }): boolean =>
  !!n.asked || (n.urgency === 2 && !isNews(sourceOf(n)) && (n.app !== "gate" || !!n.key));

/** Sources whose urgency 2 is still news unless asked for: another app's note, and a PR check. */
const isNews = (source: string): boolean => isDesktop(source) || source === "ci";

export function deliveryFor(n: Pick<SystemNote, "app" | "source" | "urgency"> & { asked?: boolean }, s: PolicyState): Delivery {
  // Something the person armed by hand — "tell me when CI passes" — is what
  // they asked to be interrupted by. Quiet and mutes are about what the app
  // volunteers; a watch that fired into a Quiet machine and said nothing is the
  // one failure this notification cannot have.
  if (n.asked && n.urgency <= 1) return { keep: true, badge: true, interrupt: true };
  const src = sourceOf(n);
  const desktop = isDesktop(src);
  // Asked-for notes returned above when urgency <= 1; an asked red check keeps its 2.
  const level = isNews(src) && !n.asked ? Math.min(n.urgency, 1) : n.urgency;
  // A mute never reaches something stopped: muting "Agents" to stop hearing
  // about prompts left open must not also swallow the one asking permission.
  if (level < 2 && s.muted.has(src) && canMute(src)) return { keep: false, badge: false, interrupt: false };
  if (level === 2) return { keep: true, badge: true, interrupt: true };
  if (level === 1) {
    // Silence all and "Bell only" keep the row and take away the pop-up; only
    // Silence all also takes the badge, because it is the "leave me alone" one.
    if (s.silence) return { keep: true, badge: false, interrupt: false };
    const bellOnly = ruleFor(src, s.rules) === "bell";
    return { keep: true, badge: !desktop || !s.quiet, interrupt: !s.quiet && !bellOnly };
  }
  return { keep: true, badge: false, interrupt: false };
}

/* ── where a note that interrupts shows ───────────────────────────────────── */

export type Screen = {
  /** The desktop's own Do Not Disturb (Omarchy `isDnd`). */
  dnd: boolean;
  /** The agentglass window is on screen (not hidden, not minimised). */
  visible: boolean;
  /** "Agents waiting on you break through DND": with DND on and the window hidden, one desktop popup still goes out. */
  breakThrough: boolean;
};

export type Surface = {
  /** An agentglass card in the window. */
  card: boolean;
  /** One popup on the desktop, raised by agentglass. */
  desktop: boolean;
};

/**
 * One notification, one place. Read the table in Settings ▸ Notifications
 * ("Where it shows") and this is the same table:
 *
 *                      Desktop DND off                 Desktop DND on
 *   other apps         desktop's own popup; bell only  agentglass card
 *   agentglass news    card; desktop popup if hidden   card; bell only if hidden
 *   agent waits        card; desktop popup if hidden   card; desktop popup if hidden
 *                                                      and "break through" is on
 *
 * Another app's note never gets a desktop popup from us: the desktop already
 * drew one (DND off) or was told not to (DND on). That is the double popup
 * this rule exists to end.
 */
export function whereItShows(n: Pick<SystemNote, "app" | "source" | "urgency"> & { asked?: boolean; key?: string }, d: Delivery, s: Screen): Surface {
  const none = { card: false, desktop: false };
  if (!d.interrupt) return none;
  if (isDesktop(sourceOf(n))) return { card: s.dnd && s.visible, desktop: false };
  if (waitsOnYou(n)) return s.visible ? { card: true, desktop: false } : { card: false, desktop: !s.dnd || s.breakThrough };
  return s.visible ? { card: true, desktop: false } : { card: false, desktop: !s.dnd };
}

/* ── old switches, read into the new model ────────────────────────────────── */

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const RULES_KEY = "agentglass.notes.appRules";
const APP_KEY = "agentglass.appNotify";
const QUIET_KEY = "agentglass.sysNotify.quiet";

/**
 * Volume (Off / Quiet / Normal / Loud) is gone; what it stored is not.
 *
 * Quiet and Off need nothing: News pop-ups is the same `quiet` flag read the
 * other way up, and Silence all is still `none`. Normal was Quiet off AND
 * "agentglass's own notifications" off, and nothing on screen said the second
 * half. It becomes the visible rule "agentglass news: Bell only", so the
 * machine behaves as it did and now says why. Loud is News pop-ups on and
 * nothing else. The old key is removed once read, so this runs once.
 */
export function migrateAppRules(st: Store): Record<string, AppRule> {
  let rules: Record<string, AppRule> = {};
  try {
    const raw = JSON.parse(st.getItem(RULES_KEY) || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) if (v === "popup" || v === "bell") rules[k] = v;
    }
  } catch { rules = {}; }
  const own = st.getItem(APP_KEY);
  if (own !== null) {
    // Only Normal (quiet off, own alerts off) becomes the rule, as the approved
    // mockup maps it. The old Volume control wrote appNotify only on Normal,
    // Loud or Off, and picking Quiet afterwards left that "0" behind: under
    // Quiet it is a leftover of an earlier pick, not a choice. Quiet maps to
    // News pop-ups off and no rule.
    const normal = own === "0" && st.getItem(QUIET_KEY) === "0";
    if (normal && !(OUR_RULE in rules)) {
      rules = { ...rules, [OUR_RULE]: "bell" };
      try { st.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* private mode */ }
    }
    try { st.removeItem(APP_KEY); } catch { /* private mode */ }
  }
  return rules;
}

let rulesCache: { raw: string | null; rules: Readonly<Record<string, AppRule>> } | null = null;
const rulesListeners = new Set<() => void>();

/** The person's per-app rules: read from storage on every call (so a fresh page and this one agree), the same object while the stored text is unchanged. */
export function appRules(): Readonly<Record<string, AppRule>> {
  try {
    const rules = migrateAppRules(localStorage);
    const raw = localStorage.getItem(RULES_KEY);
    if (rulesCache && rulesCache.raw === raw) return rulesCache.rules;
    rulesCache = { raw, rules };
    return rules;
  } catch { return rulesCache?.rules ?? {}; }
}

/** Pop up or Bell only for one source; the default rule is not stored. */
export function setAppRule(source: string, rule: AppRule): void {
  const key = isDesktop(source) ? source : OUR_RULE;
  const next: Record<string, AppRule> = { ...appRules() };
  if (rule === defaultRule(key)) delete next[key]; else next[key] = rule;
  try { localStorage.setItem(RULES_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  rulesCache = { raw: JSON.stringify(next), rules: next };
  for (const fn of rulesListeners) fn();
}

export function subscribeAppRules(fn: () => void): () => void {
  rulesListeners.add(fn);
  return () => { rulesListeners.delete(fn); };
}

/** Tests only. */
export function __resetAppRules(): void { rulesCache = null; }

/* ── the muted sources, persisted like their neighbours in sysNotify.ts ── */

const MUTED_KEY = "agentglass.notes.muted";

function readMuted(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(MUTED_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && canMute(x)) : []);
  } catch { return new Set(); }
}

let muted: ReadonlySet<string> | null = null;
const mutedListeners = new Set<() => void>();

/** The same Set until it changes, so `useSyncExternalStore` can hold it. */
export function mutedSources(): ReadonlySet<string> {
  return (muted ??= readMuted());
}

export function setMuted(source: string, on: boolean): void {
  if (on && !canMute(source)) return;
  const next = new Set(mutedSources());
  if (on) next.add(source); else next.delete(source);
  muted = next;
  try { localStorage.setItem(MUTED_KEY, JSON.stringify([...next].sort())); }
  catch { /* private mode — muted for this session */ }
  for (const fn of mutedListeners) fn();
}

export function subscribeMuted(fn: () => void): () => void {
  mutedListeners.add(fn);
  return () => { mutedListeners.delete(fn); };
}

/** Tests only: forget the cached set so a stubbed storage is read again. */
export function __resetMuted(): void { muted = null; }

/* ── grouping, for the panel ─────────────────────────────────────────────── */

export type NoteGroup = { source: string; lead: SystemNote; more: SystemNote[] };

/**
 * The list as the panel draws it: one entry per source, newest first, with the
 * older rows from the same source folded under the newest.
 *
 * Urgent rows are never folded — each one is somebody waiting on a decision,
 * and a decision behind "+3 more" is a decision nobody made. They lead their
 * own entry.
 */
export function groupNotes(list: readonly SystemNote[]): NoteGroup[] {
  const out: NoteGroup[] = [];
  const open = new Map<string, NoteGroup>();
  for (const n of list) {
    const src = sourceOf(n);
    if (n.urgency === 2) { out.push({ source: src, lead: n, more: [] }); continue; }
    const g = open.get(src);
    if (g) { g.more.push(n); continue; }
    const fresh = { source: src, lead: n, more: [] };
    open.set(src, fresh);
    out.push(fresh);
  }
  return out;
}

/* ── the Apps list in Settings ────────────────────────────────────────────── */

export type AppChoice = "popup" | "bell" | "mute";
export type AppRow = { source: string; choice: AppChoice; byDefault: boolean };

/**
 * One row per app a person can say something about: agentglass's own news
 * first, then every other app seen in the bell, set by a rule or muted.
 * agentglass's news is never offered Mute (an agent's alerts are not a source
 * to drop wholesale); a muted app reads as Mute whatever its rule says.
 */
export function appRows(seen: Iterable<string>, rules: Readonly<Record<string, AppRule>>, muted: ReadonlySet<string>): AppRow[] {
  const apps = new Set<string>();
  for (const s of seen) if (isDesktop(s)) apps.add(s);
  for (const k of Object.keys(rules)) if (isDesktop(k)) apps.add(k);
  for (const m of muted) if (isDesktop(m)) apps.add(m);
  const row = (source: string): AppRow => ({
    source,
    choice: muted.has(source) ? "mute" : ruleFor(source, rules),
    byDefault: !(source in rules) && !muted.has(source) && defaultRule(source) === "bell",
  });
  return [row(OUR_RULE), ...[...apps].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b))).map(row)];
}

/** What choosing one of the three does: Mute is the muted set, the other two are the rule. */
export function chooseApp(source: string, choice: AppChoice): void {
  if (choice === "mute") { setMuted(source, true); return; }
  setMuted(source, false);
  setAppRule(source, choice);
}

/* ── a test note: one of each kind, routed as a real one ─────────────────── */

/**
 * The three kinds a person can send from Settings ▸ Notifications ▸ Pop-ups
 * (and `agentglass-ui notify test`), to see where a note shows without waiting
 * for a real one. A notify-send from a shell is "another app" and never tests
 * agentglass's own cards, so these go through the app's own path.
 */
export const TEST_KINDS = ["news", "waits", "other"] as const;
export type TestKind = (typeof TEST_KINDS)[number];
export const TEST_KIND_LABEL: Readonly<Record<TestKind, string>> = {
  news: "agentglass news",
  waits: "An agent waits on you",
  other: "Other app",
};

/** The app name a test "Other app" note arrives under, so its rule and mute are its own. */
export const TEST_APP = "test";
/** A test hold's key. Keyed, so it routes as an open hold (waitsOnYou); never `gate:`, so no real hold matches it. */
export const TEST_GATE_KEY = "test:gate";

/**
 * What a test note of one kind is, as far as routing reads it: exactly the
 * fields a real note of that kind carries (a PR check, a gate hold, a mirrored
 * note). The words differ; the routing cannot.
 */
export function testNoteShape(kind: TestKind): Pick<SystemNote, "app" | "source" | "urgency"> & { key?: string } {
  if (kind === "waits") return { app: "gate", source: "gate", urgency: 2, key: TEST_GATE_KEY };
  if (kind === "other") return { app: TEST_APP, source: `${DESKTOP}${TEST_APP}`, urgency: 1 };
  return { app: OUR_RULE, source: "ci", urgency: 1 };
}

/**
 * Who asked for the test: the person's own press of the button, or an agent
 * through the `notify.test` door. An agent's "waits" test is news-level: it
 * keeps the gate's shape (so the card is the gate's card) but never breaks
 * through Desktop DND, Silence all or News pop-ups off, because nobody at the
 * keyboard asked for it.
 */
export type TestBy = "person" | "agent";

/** Where a test note of this kind goes under these settings and this screen: the same answer as a real one. */
export function testRoute(kind: TestKind, p: PolicyState, s: Screen, by: TestBy = "person"): Delivery & Surface {
  const n = testNoteShape(kind);
  if (by === "agent" && kind === "waits") {
    const d = deliveryFor({ ...n, urgency: 1 }, p);
    return { ...d, ...whereItShows(n, d, { ...s, breakThrough: false }) };
  }
  const d = deliveryFor(n, p);
  return { ...d, ...whereItShows(n, d, s) };
}

/**
 * The route a test note is sent on and the words that say it, from one answer.
 * `gates` are the person's channel switches the send also reads: `bell` for
 * the waiting kind (notifies "blocked" "bell"), `desktop` for the popup
 * (notifies "blocked" "desktop" for the waiting kind, channels.desktop for
 * news). The popup goes up only when `route.desktop` says so, and the label is
 * built from that same `route`.
 */
export function testOutcome(kind: TestKind, p: PolicyState, s: Screen, gates: { bell: boolean; desktop: boolean }, by: TestBy = "person"): { route: Delivery & Surface; label: string; sent: boolean } {
  const r = testRoute(kind, p, s, by);
  if (kind === "waits" && !gates.bell) return { route: { ...r, card: false, desktop: false }, label: "off: Interrupt me for · blocked is off", sent: false };
  const route = { ...r, desktop: r.desktop && gates.desktop };
  return { route, label: routeLabel(kind, route, s), sent: true };
}

/** Where it went, in words, for the card and the bell row. */
export function routeLabel(kind: TestKind, r: Delivery & Surface, s: Pick<Screen, "dnd">): string {
  if (!r.keep) return "muted: not kept";
  if (r.card) return "agentglass card";
  if (r.desktop) return "desktop popup";
  // Another app's note with DND off: the desktop draws its own popup and
  // agentglass only keeps the row. A test never passes through the desktop, so
  // no popup shows for it; the label says what happened, then what a real one gets.
  if (kind === "other" && r.interrupt && !s.dnd) return "bell only (a real app's note also gets the desktop's own popup)";
  return r.badge ? "bell only" : "bell only, not counted";
}
