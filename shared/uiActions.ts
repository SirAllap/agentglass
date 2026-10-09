/*
 * Every door an agent has into the app's own screen, as data.
 *
 * Both sides import this and nothing else: the server turns a POST /control
 * body into a validated command from it (server/src/control.ts), and the
 * window runs the command through a handler table typed by it
 * (web/src/lib/uiActions.ts), so an id with no handler is a compile error and
 * a closed set cannot drift between the two. The wire shape is
 *
 *   {"cmd":"ui","do":"settings.open","args":{"page":"appearance"}}
 *
 * and the older {"cmd":"view","to":"git"} spellings are aliases for registry
 * entries: `legacy` says which body each one is, so there is one list and the
 * old spelling is a way of writing it, not a second list.
 *
 * Level 1 is "look or open": nothing here changes a setting, a file or a
 * remote. The server refuses an entry above the level it was told to accept
 * and an id that is not in this file at all, so a new door is a new line here
 * and nothing else is reachable.
 *
 * What a registry entry cannot do is describe what a handler does with the
 * window it lands in. That is the handler's business, and it calls the seam
 * the UI itself uses.
 */

/*
 * Every view the rail can hold. The 0.8 redesign made the dashboard a view and
 * added tasks, files and the browser, so an external controller can reach every
 * one of them, not the six the workspace used to hold. `browser` earns its place
 * for a further reason: an agent driving the built-in browser (browserdrive.ts)
 * needs that view mounted before anything can answer it, and the alternative was
 * telling the agent to ask a human to click a tab.
 *
 * `seat` (the understudy) is on the list for the ORDINARY reason rather than a
 * special one, and it is worth saying so out loud because the view sounds like it
 * should be an exception: it is a scorecard of decisions a stand-in would have
 * made, it acts on nothing, and everything it shows already rides the same
 * read-only socket. A view the keyboard reaches with one key and /control
 * answers 400 for is the drift a closed list exists to make visible. A retired
 * view (`understudy` left the rail on 2026-09-08) leaves this list with it.
 */
export const VIEW_IDS = ["dash", "git", "diff", "pr", "tasks", "docker", "term", "chat", "browser", "files", "lantern", "seat", "plugins"] as const;

/** The pages Settings can be opened on. `plugin:<name>` pages come and go with
 *  the installed plugins and are not a closed set, so they are not here. */
export const SETTINGS_PAGE_IDS = [
  "prefs", "appearance", "notifications", "rail", "keys", "terminal", "diff", "browser", "tasks", "hooks", "lantern",
  "understudy", "budgets", "recipes", "review-prompts", "saved-replies", "connections", "clickup", "remote", "plugins",
  "tmux", "privacy", "about", "log", "onboarding",
] as const;

export const PANEL_IDS = ["stats", "skills", "search", "help", "palette"] as const;
export const MACHINE_TABS = ["ports", "resources", "locks"] as const;
export const GIT_MODALS = ["insights", "bisect"] as const;
export const BOARD_KINDS = ["pr", "tasks", "files"] as const;

export type UiLevel = 1 | 2 | 3;
/** open: shows something. read: answers with state. change: alters a local
 *  setting. external: has an effect outside the app. Only `open` is built. */
export type UiKind = "open" | "read" | "change" | "external";

/**
 * What one argument may be. Closed on purpose: there is no "any string", so
 * nothing a caller sends reaches a setter or a request without a shape.
 *
 * `slug` is for ids the app itself minted (a settings row, a theme): letters,
 * digits and `. _ : -`. `ref` is a git ref's spelling. `abspath` and `relpath`
 * are spellings only; whether anything exists there is answered, as it always
 * was, by the route a window asks under its own credentials.
 */
export type ArgSpec =
  | { t: "enum"; values: readonly string[]; optional?: true }
  | { t: "num"; values: readonly number[]; optional?: true }
  | { t: "bool"; optional?: true }
  | { t: "slug"; max: number; optional?: true }
  | { t: "ref"; optional?: true }
  | { t: "abspath"; optional?: true }
  | { t: "relpath"; optional?: true }
  /** Whether another argument's absolute path is a folder: said by the caller
   *  as "file" or "dir", else read from the spelling (a trailing slash). A
   *  validated command carries it already, so the window's second look over a
   *  normalized path, which has lost its slash, reads the same answer. */
  | { t: "pathKind"; of: string };

export interface UiActionDef {
  level: UiLevel;
  kind: UiKind;
  args: Readonly<Record<string, ArgSpec>>;
  /** One line for a person reading the list: what opens. */
  surface: string;
  /** The old `{cmd, ...}` body that spells this entry. `pin` fixes fields that
   *  tell two entries with one `cmd` apart; every other field of the old body
   *  is the argument of the same name. */
  legacy?: { cmd: string; pin?: Readonly<Record<string, string>> };
  /** Cross-field rules a per-argument spec cannot say. Null refuses. */
  refine?: (a: Record<string, unknown>) => Record<string, unknown> | null;
  /** App chords (keybindings.ts AppChordId) this entry is the agent's door for. */
  chords?: readonly string[];
}

const def = <const D extends UiActionDef>(d: D): D => d;

export const UI_ACTIONS = {
  "view.open": def({ level: 1, kind: "open", surface: "a workspace view", legacy: { cmd: "view" }, args: { to: { t: "enum", values: VIEW_IDS } } }),
  "workspace.toggle": def({
    level: 1, kind: "open", surface: "the workspace (last view that was not the dashboard)", legacy: { cmd: "workspace" },
    args: { open: { t: "bool", optional: true } },
  }),
  "esc.peel": def({ level: 1, kind: "open", surface: "peels the top overlay, as Escape does", legacy: { cmd: "esc" }, args: {} }),
  "panel.open": def({ level: 1, kind: "open", surface: "stats, skills, search, help or the command palette", legacy: { cmd: "open" }, args: { what: { t: "enum", values: PANEL_IDS } } }),
  "finder.open": def({
    level: 1, kind: "open", surface: "the file finder on one absolute path", legacy: { cmd: "open", pin: { what: "finder" } }, chords: ["files.palette"],
    args: { path: { t: "abspath" }, kind: { t: "pathKind", of: "path" } },
  }),
  // One verb, not a free string: the ones that want to join it, compacting and
  // sending, reach into a real conversation.
  "chat.new": def({ level: 1, kind: "open", surface: "a new chat tab", legacy: { cmd: "chat", pin: { do: "new" } }, args: {} }),
  "theme.set": def({
    level: 1, kind: "open", surface: "pins a palette by name, or steps the list", legacy: { cmd: "theme" },
    args: { name: { t: "slug", max: 64, optional: true }, dir: { t: "num", values: [1, -1], optional: true } },
    // A name pins one palette and wins over a direction; neither is no command.
    refine: (a) => (a.name !== undefined ? { name: a.name } : a.dir !== undefined ? { dir: a.dir } : null),
  }),
  "zoom.step": def({ level: 1, kind: "open", surface: "window zoom in, out or reset", legacy: { cmd: "zoom" }, args: { dir: { t: "num", values: [1, -1, 0] } } }),
  "settings.open": def({
    level: 1, kind: "open", surface: "Settings on one page, optionally scrolled to one row (the plugin market is inside page plugins)",
    args: { page: { t: "enum", values: SETTINGS_PAGE_IDS }, row: { t: "slug", max: 80, optional: true } },
  }),
  "machine.open": def({ level: 1, kind: "open", surface: "the machine panel on ports, resources or locks", args: { tab: { t: "enum", values: MACHINE_TABS } } }),
  "project.picker": def({ level: 1, kind: "open", surface: "the project picker", args: {} }),
  "windows.switcher": def({ level: 1, kind: "open", surface: "the window switcher", chords: ["windows.switcher"], args: {} }),
  "bench.toggle": def({ level: 1, kind: "open", surface: "the floating bench, shown or hidden", chords: ["bench.toggle"], args: {} }),
  "bench.file": def({ level: 1, kind: "open", surface: "a file on the bench, read-write as the bench always is", args: { root: { t: "abspath" }, path: { t: "relpath" } } }),
  "bench.board": def({ level: 1, kind: "open", surface: "a board (pull requests, tasks, files) as a bench tab", args: { root: { t: "abspath" }, kind: { t: "enum", values: BOARD_KINDS } } }),
  "peek.file": def({ level: 1, kind: "open", surface: "the file viewer, reading", args: { root: { t: "abspath" }, path: { t: "relpath" } } }),
  "git.modal": def({ level: 1, kind: "open", surface: "Insights or Bisect over the checkout the Git view is on", args: { which: { t: "enum", values: GIT_MODALS } } }),
  "git.compare": def({ level: 1, kind: "open", surface: "the Compare modal against one ref", args: { base: { t: "ref" } } }),
  "git.blame": def({ level: 1, kind: "open", surface: "the Blame modal on one file of the checkout", args: { path: { t: "relpath" } } }),
} as const satisfies Record<string, UiActionDef>;

export type UiActionId = keyof typeof UI_ACTIONS;
export const UI_ACTION_IDS = Object.keys(UI_ACTIONS) as UiActionId[];

type Val<S> =
  S extends { t: "enum"; values: readonly (infer V)[] } ? V
  : S extends { t: "num"; values: readonly (infer V)[] } ? V
  : S extends { t: "bool" } ? boolean
  : S extends { t: "pathKind" } ? "file" | "dir"
  : string;
type Args<A> =
  { [K in keyof A as A[K] extends { optional: true } ? never : K]: Val<A[K]> } &
  { [K in keyof A as A[K] extends { optional: true } ? K : never]?: Val<A[K]> };
/** The validated arguments of one registry entry, typed from its spec. */
export type UiArgs<Id extends UiActionId> = Args<(typeof UI_ACTIONS)[Id]["args"]>;

/** A validated command as it travels: the `ui` wire shape. */
export type UiCmd = { [Id in UiActionId]: { cmd: "ui"; do: Id; args: UiArgs<Id> } }[UiActionId];

// ── validators ──────────────────────────────────────────────────────────────

/** PATH_MAX on Linux. */
const MAX_PATH = 4096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The path a finder command may carry. Spelling only: nothing here touches the
 * disk, and whether the finder may LOOK at the place is answered where it
 * always was, by /browse and /preview each time a window asks, under that
 * window's own credentials. A refused or missing path therefore opens the
 * finder on its own "closed" or "not there" state rather than being second-
 * guessed here with the caller's locality instead of the viewer's. POSIX paths
 * only; a Windows drive path is the next thing after this and is not here.
 *
 * An absolute, already-normalized POSIX path: no `.`, `..` or empty segment, so
 * the string every window shows and fetches is the one the caller wrote. A
 * trailing slash is the one spelling allowed to differ, and it is how a folder
 * is asked for. Control characters, not just NUL: a newline in a path is a
 * log-injection and a rendering surprise in every window that draws it.
 */
export function absPath(raw: unknown): { path: string; kind: "file" | "dir" } | null {
  if (typeof raw !== "string" || raw.length > MAX_PATH || !raw.startsWith("/") || CONTROL_CHARS.test(raw)) return null;
  if (raw === "/") return { path: "/", kind: "dir" };
  const dir = raw.endsWith("/");
  const body = dir ? raw.slice(0, -1) : raw;
  if (body.slice(1).split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return { path: body, kind: dir ? "dir" : "file" };
}

/** A path under some root: relative, normalized, no way up. */
export function relPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_PATH || raw.startsWith("/") || CONTROL_CHARS.test(raw)) return null;
  return raw.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ? null : raw;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// A ref the way git spells one. Never starts with `-`, so it cannot be read as
// an option by anything it is later handed to, and has no `..` range syntax.
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;

function one(spec: ArgSpec, v: unknown): unknown {
  switch (spec.t) {
    case "enum": return typeof v === "string" && spec.values.includes(v) ? v : undefined;
    case "num": return typeof v === "number" && spec.values.includes(v) ? v : undefined;
    case "bool": return typeof v === "boolean" ? v : undefined;
    case "slug": return typeof v === "string" && v.length <= spec.max && SLUG.test(v) ? v : undefined;
    case "ref": return typeof v === "string" && REF.test(v) && !v.includes("..") ? v : undefined;
    case "abspath": return absPath(v)?.path;
    case "relpath": return relPath(v) ?? undefined;
    case "pathKind": return undefined;
  }
}

/**
 * The arguments of one entry from an untrusted object, or null.
 *
 * Fields the spec does not name are dropped, a required one that is missing is
 * a refusal, and an optional one that is present but wrong is a refusal too:
 * a Stream Deck button that sends `dir: 5` has a bug it should hear about, not
 * a zoom that quietly did something else.
 */
export function parseArgs(d: UiActionDef, raw: unknown): Record<string, unknown> | null {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return null;
  const b = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(d.args)) {
    if (spec.t === "pathKind") continue;
    if (b[k] === undefined) {
      if ("optional" in spec && spec.optional) continue;
      return null;
    }
    const v = one(spec, b[k]);
    if (v === undefined) return null;
    out[k] = v;
  }
  for (const [k, spec] of Object.entries(d.args)) {
    if (spec.t === "pathKind") out[k] = b[k] === "file" || b[k] === "dir" ? b[k] : (absPath(b[spec.of])?.kind ?? "file");
  }
  return d.refine ? d.refine(out) : out;
}

/**
 * A `ui` command from an id and untrusted args, or null. Deny by default: an id
 * that is not in `registry` is refused, and so is an entry above `maxLevel`.
 * The registry is a parameter so a test can hand it entries the real one does
 * not (yet) have and watch them be refused.
 */
export function parseUi(
  registry: Readonly<Record<string, UiActionDef>>, id: unknown, args: unknown, maxLevel: UiLevel,
): { cmd: "ui"; do: string; args: Record<string, unknown> } | null {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(registry, id)) return null;
  const d = registry[id]!;
  if (d.level > maxLevel) return null;
  const a = parseArgs(d, args);
  return a ? { cmd: "ui", do: id, args: a } : null;
}

// ── the old spellings ───────────────────────────────────────────────────────

const ENTRIES = Object.entries(UI_ACTIONS) as [UiActionId, UiActionDef][];
/** Pinned spellings first, so `{cmd:"open",what:"finder"}` is not read as a panel. */
const LEGACY = ENTRIES.filter(([, d]) => d.legacy).sort(([, a], [, b]) => Number(!!b.legacy?.pin) - Number(!!a.legacy?.pin));

/** The registry entry an old `{cmd, ...}` body spells, with its arguments checked. */
export function legacyToUi(b: Record<string, unknown>, maxLevel: UiLevel): { id: UiActionId; args: Record<string, unknown> } | null {
  for (const [id, d] of LEGACY) {
    const l = d.legacy!;
    if (b.cmd !== l.cmd) continue;
    if (l.pin && !Object.entries(l.pin).every(([k, v]) => b[k] === v)) continue;
    if (d.level > maxLevel) return null;
    const args = parseArgs(d, b);
    return args ? { id, args } : null;
  }
  return null;
}

/** The old body for an entry's validated arguments: `{cmd, ...pin, ...args}`. */
export function uiToLegacy(id: UiActionId, args: Record<string, unknown>): ({ cmd: string } & Record<string, unknown>) | null {
  const l = (UI_ACTIONS[id] as UiActionDef).legacy;
  return l ? { cmd: l.cmd, ...l.pin, ...args } : null;
}

/** The registry id a validated legacy body stands for, or null. Pure: it only
 *  matches `cmd` and the pinned fields, the arguments having been checked. */
export function idOfLegacy(cmd: { cmd: string } & Record<string, unknown>): UiActionId | null {
  for (const [id, d] of LEGACY) {
    const l = d.legacy!;
    if (cmd.cmd !== l.cmd) continue;
    if (l.pin && !Object.entries(l.pin).every(([k, v]) => cmd[k] === v)) continue;
    return id;
  }
  return null;
}

/** Whichever spelling a command arrived in, as a registry id and its arguments.
 *  What the window runs, so both spellings share one handler. */
export function uiOf(cmd: { cmd: string } & Record<string, unknown>): UiCmd | null {
  if (cmd.cmd === "ui") {
    const id = cmd.do as UiActionId;
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(UI_ACTIONS, id) ? ({ cmd: "ui", do: id, args: (cmd.args ?? {}) as never } as UiCmd) : null;
  }
  const id = idOfLegacy(cmd);
  if (!id) return null;
  const { cmd: _c, ...rest } = cmd;
  for (const k of Object.keys((UI_ACTIONS[id] as UiActionDef).legacy?.pin ?? {})) delete rest[k];
  return { cmd: "ui", do: id, args: rest } as unknown as UiCmd;
}
