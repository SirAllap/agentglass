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
 * Level 1 is "look or open": nothing at that level changes a setting, a file or
 * a remote. Level 2 changes a local setting, and only the ones the window's own
 * settings registry lists (web/src/lib/settingsRegistry.ts): this file names
 * the door, that one names what is behind it. The server refuses an entry above
 * the level it was told to accept and an id that is not in this file at all, so
 * a new door is a new line here and nothing else is reachable.
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
export const GIT_MODALS = ["insights", "bisect", "palette"] as const;
export const BOARD_KINDS = ["pr", "tasks", "files"] as const;
export const PANE_DOORS = ["git", "diff", "pr", "card"] as const;
export const STAGE_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export const STAGE_REVIEW_VERDICTS = ["approve", "request_changes", "comment"] as const;
/** The longest staged body: a commit message or a comment, never a document. */
export const STAGE_BODY_MAX = 8000;
export const STAGE_SUBJECT_MAX = 256;
/**
 * What `ui.read` can be asked about. Each one has exactly one provider in
 * web/src/lib/uiSnapshots.ts, keyed by these ids, so a panel named here with no
 * provider is a compile error and web/test/ui-read-guard.test.ts pins the rest.
 * `settings.*` are the preference panes. The ones in READ_PANELS_LATE are held by
 * the server, so the window asks the same route the pane asks and answers when it
 * has the reply; the rest are read from a pref module or a store, synchronously.
 * The panes no reader describes are listed by UI_READ_NOT_COVERED, with the reason.
 */
export const READ_PANELS_NOW = [
  "view", "chat", "bench", "gates", "settings.diff", "settings.terminal", "settings.browser", "settings.notifications",
  "settings.prefs", "settings.rail", "settings.keys", "settings.tasks", "settings.appearance", "settings.understudy",
] as const;
export const READ_PANELS_LATE = [
  "settings.hooks", "settings.lantern", "settings.budgets", "settings.recipes", "settings.review-prompts",
  "settings.saved-replies", "settings.tmux", "settings.privacy", "settings.plugins", "settings.log", "settings.about",
] as const;
export const READ_PANELS = [...READ_PANELS_NOW, ...READ_PANELS_LATE] as const;

export type UiLevel = 1 | 2 | 3;
/** open: shows something. read: answers with state and shows nothing. change:
 *  alters a local setting. stage: prepares something that has an effect outside
 *  the app (a dialog opened and filled in) and does nothing else; the person's
 *  click is the effect. There is no kind that performs one: level 3 has no
 *  "external" entry because no agent door is allowed to be the thing that
 *  merges, posts or sends. */
export type UiKind = "open" | "read" | "change" | "stage";

/**
 * Which kinds each level may hold, as a type and as data. The pairing is the
 * whole of the level model: a look is level 1, a local change is level 2, and
 * level 3 holds stage entries only. An entry that breaks it does not compile
 * here and is refused by `levelAllows` if a cast got it past the compiler.
 */
export const KINDS_AT_LEVEL: Readonly<Record<UiLevel, readonly UiKind[]>> = {
  1: ["open", "read"],
  2: ["change"],
  3: ["stage"],
};
type LevelKind =
  | { level: 1; kind: "open" | "read" }
  | { level: 2; kind: "change" }
  | { level: 3; kind: "stage" };

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
  /** A whole number from 0 to `max`: a row id the app minted (an event). */
  | { t: "int"; max: number; optional?: true }
  | { t: "abspath"; optional?: true }
  | { t: "relpath"; optional?: true }
  /** A repository as GitHub spells it, `owner/name`. Spelling only, like a path. */
  | { t: "repo"; optional?: true }
  /** Text a person will read and may edit before it goes anywhere: a commit
   *  message, a comment. Bounded, one line when `line`, and free of what hides:
   *  no control character but a newline and a tab, no bidirectional or
   *  zero-width character, no HTML comment (GitHub does not draw one, so it
   *  would be text the sender sees and the person does not). */
  | { t: "text"; max: number; line?: true; optional?: true }
  /** Whether another argument's absolute path is a folder: said by the caller
   *  as "file" or "dir", else read from the spelling (a trailing slash). A
   *  validated command carries it already, so the window's second look over a
   *  normalized path, which has lost its slash, reads the same answer. */
  | { t: "pathKind"; of: string }
  /** One string, number or boolean and nothing nested: the value of a setting.
   *  Which values a given setting takes is its definition's business (the
   *  window's settings registry validates against it); this only keeps an
   *  object, an array or a megabyte of text from travelling as one. */
  | { t: "scalar"; optional?: true };

export type UiActionDef = LevelKind & UiActionBody;
interface UiActionBody {
  args: Readonly<Record<string, ArgSpec>>;
  /** One line for a person reading the list: what opens. */
  surface: string;
  /** The old `{cmd, ...}` body that spells this entry. `pin` fixes fields that
   *  tell two entries with one `cmd` apart; every other field of the old body
   *  is the argument of the same name. */
  legacy?: { cmd: string; pin?: Readonly<Record<string, string>> };
  /** The door closes or repaints what is already on screen and moves the
   *  person to nothing (Escape, a palette, zoom), so a quiet caller gets it at
   *  once: there is no view or dialog to queue behind a chip. */
  inPlace?: true;
  /** Cross-field rules a per-argument spec cannot say. Null refuses. */
  refine?: (a: Record<string, unknown>) => Record<string, unknown> | null;
  /** App chords (keybindings.ts AppChordId) this entry is the agent's door for. */
  chords?: readonly string[];
  /** The dialogs and popovers this entry opens, as component files under
   *  web/src/components. web/test/ui-registry-guard.test.ts holds every
   *  component that draws through a Portal against these, so a new dialog is a
   *  door or a decided exception. */
  modals?: readonly string[];
}

const def = <const D extends UiActionDef>(d: D): D => d;

// A pull request's number: a whole number from 1. `int` starts at 0, so the
// entries that take one refuse 0 in `refine`.
const PR_NUMBER = { t: "int", max: 999_999_999 } as const;
const prNumberOk = (a: Record<string, unknown>): Record<string, unknown> | null => ((a.number as number) >= 1 ? a : null);

export const UI_ACTIONS = {
  "view.open": def({ level: 1, kind: "open", surface: "a workspace view", legacy: { cmd: "view" }, args: { to: { t: "enum", values: VIEW_IDS } } }),
  "workspace.toggle": def({
    level: 1, kind: "open", surface: "the workspace (last view that was not the dashboard)", legacy: { cmd: "workspace" },
    args: { open: { t: "bool", optional: true } },
  }),
  "esc.peel": def({ inPlace: true, level: 1, kind: "open", surface: "peels the top overlay, as Escape does", legacy: { cmd: "esc" }, args: {} }),
  "panel.open": def({ modals: ["CommandPalette.tsx", "HelpLegend.tsx", "SearchModal.tsx", "SkillsModal.tsx", "StatsModal.tsx"], level: 1, kind: "open", surface: "stats, skills, search, help or the command palette", legacy: { cmd: "open" }, args: { what: { t: "enum", values: PANEL_IDS } } }),
  "finder.open": def({ modals: ["FilePalette.tsx"],
    level: 1, kind: "open", surface: "the file finder on one absolute path", legacy: { cmd: "open", pin: { what: "finder" } }, chords: ["files.palette"],
    args: { path: { t: "abspath" }, kind: { t: "pathKind", of: "path" } },
  }),
  // One verb, not a free string: the ones that want to join it, compacting and
  // sending, reach into a real conversation.
  "chat.new": def({ level: 1, kind: "open", surface: "a new chat tab", legacy: { cmd: "chat", pin: { do: "new" } }, args: {} }),
  // A palette and a zoom persist (localStorage), which is the effect of a level 2
  // change, so both sit at level 2: refused at level 1 and under READONLY, and
  // counted by the same per-caller write limit. theme.set goes through the
  // appearance.theme setting, so it leaves the undo chip too; zoom has no
  // setting behind it and is undone by stepping the other way.
  "theme.set": def({
    inPlace: true, level: 2, kind: "change", surface: "pins a palette by name, or steps the list", legacy: { cmd: "theme" },
    args: { name: { t: "slug", max: 64, optional: true }, dir: { t: "num", values: [1, -1], optional: true } },
    // A name pins one palette and wins over a direction; neither is no command.
    refine: (a) => (a.name !== undefined ? { name: a.name } : a.dir !== undefined ? { dir: a.dir } : null),
  }),
  "zoom.step": def({ inPlace: true, level: 2, kind: "change", surface: "window zoom in, out or reset", legacy: { cmd: "zoom" }, args: { dir: { t: "num", values: [1, -1, 0] } } }),
  "settings.open": def({ modals: ["SettingsModal.tsx", "plugins/Market.tsx"],
    level: 1, kind: "open", surface: "Settings on one page, optionally scrolled to one row (the plugin market is inside page plugins)",
    args: { page: { t: "enum", values: SETTINGS_PAGE_IDS }, row: { t: "slug", max: 80, optional: true } },
  }),
  "settings.get": def({
    level: 1, kind: "read", surface: "the current value of one exposed setting (a secret answers only whether it is set)",
    args: { id: { t: "slug", max: 80 } },
  }),
  "settings.list": def({ level: 1, kind: "read", surface: "the settings an agent may read and write, with their levels", args: {} }),
  "settings.set": def({
    level: 2, kind: "change", surface: "one exposed setting, through the same setter its Settings row calls",
    args: { id: { t: "slug", max: 80 }, value: { t: "scalar" } },
  }),
  "machine.open": def({ modals: ["MachinePanel.tsx"], level: 1, kind: "open", surface: "the machine panel on ports, resources or locks", args: { tab: { t: "enum", values: MACHINE_TABS } } }),
  "project.picker": def({ modals: ["ProjectPicker.tsx"], level: 1, kind: "open", surface: "the project picker", args: {} }),
  "windows.switcher": def({ modals: ["terminal/WindowSwitcher.tsx"], level: 1, kind: "open", surface: "the window switcher", chords: ["windows.switcher"], args: {} }),
  "bench.toggle": def({ modals: ["bench/FloatingBench.tsx"], level: 1, kind: "open", surface: "the floating bench, shown or hidden", chords: ["bench.toggle"], args: {} }),
  "bench.file": def({ level: 1, kind: "open", surface: "a file on the bench, read-write as the bench always is", args: { root: { t: "abspath" }, path: { t: "relpath" } } }),
  "bench.board": def({ level: 1, kind: "open", surface: "a board (pull requests, tasks, files) as a bench tab", args: { root: { t: "abspath" }, kind: { t: "enum", values: BOARD_KINDS } } }),
  "peek.file": def({ modals: ["PeekFile.tsx"], level: 1, kind: "open", surface: "the file viewer, reading", args: { root: { t: "abspath" }, path: { t: "relpath" } } }),
  "git.modal": def({ modals: ["InsightsModal.tsx", "BisectModal.tsx", "GitPalette.tsx", "GitPanel.tsx"], level: 1, kind: "open", surface: "Insights, Bisect or the git command palette over the checkout the Git view is on", args: { which: { t: "enum", values: GIT_MODALS } } }),
  "git.compare": def({ modals: ["CompareModal.tsx"], level: 1, kind: "open", surface: "the Compare modal against one ref", args: { base: { t: "ref" } } }),
  "git.blame": def({ modals: ["BlameModal.tsx"], level: 1, kind: "open", surface: "the Blame modal on one file of the checkout", args: { path: { t: "relpath" } } }),
  // Opening shows a plan and moves nothing: the rebase starts only when the owner
  // presses Start rebase in the modal, and the server re-validates the plan then.
  "git.rebase": def({ modals: ["RebaseModal.tsx"],
    level: 1, kind: "open", surface: "the interactive-rebase editor from one commit (shows the plan; nothing moves until the owner presses Start)",
    args: { base: { t: "ref" } },
  }),
  // Looked up in the window's feed, then the server's recent events (the list
  // the dashboard starts from). An id in neither is an answer, not a guess.
  "event.open": def({ modals: ["EventModal.tsx"], level: 1, kind: "open", surface: "the event modal for one recent event", args: { id: { t: "int", max: Number.MAX_SAFE_INTEGER } } }),
  "session.open": def({ modals: ["SessionModal.tsx"],
    level: 1, kind: "open", surface: "the session modal for one session id",
    args: { id: { t: "slug", max: 128 }, app: { t: "slug", max: 128, optional: true } },
  }),
  "whatsnew.open": def({ modals: ["ReleaseNotesModal.tsx"], level: 1, kind: "open", surface: "the release notes of the running version, without marking them seen", args: {} }),
  // The dialog creates a schedule only when the owner submits it.
  "lantern.schedule": def({ modals: ["LanternSchedule.tsx"], level: 1, kind: "open", surface: "the Lantern schedule dialog (empty; a schedule exists only once the owner submits it)", args: {} }),
  "terminal.resume": def({ modals: ["ResumeSessions.tsx"], level: 1, kind: "open", surface: "the Resume sessions list of the Terminal view (resuming is the owner's click)", args: {} }),
  "settings.plugin": def({
    level: 1, kind: "open", surface: "Settings on one plugin's own page (a plugin that is not installed answers with its page saying so)",
    args: { name: { t: "slug", max: 64 } },
  }),
  "pane.open": def({
    level: 1, kind: "open", surface: "the git, diff, pull request or card view of the focused terminal pane's branch (the pane chords)",
    chords: ["pane.git", "pane.diff", "pane.pr", "pane.card"], args: { which: { t: "enum", values: PANE_DOORS } },
  }),
  // Reads. They answer and show nothing: no view changes, no window rises, no
  // focus moves. The answer is `{state, untrusted}` (see UiSnapshot below).
  "ui.state": def({ level: 1, kind: "read", surface: "what is open in the window now, and which panels ui.read can describe", args: {} }),
  "ui.read": def({ level: 1, kind: "read", surface: "one panel's state, read from the stores and pref modules (never from the DOM)", args: { panel: { t: "enum", values: READ_PANELS } } }),
  // Level 3, stage only. Each one opens the dialog the UI itself opens, filled in,
  // on one pull request, and does nothing else: the merge, the comment, the review
  // and the card's new status happen when the person presses the dialog's own
  // button, never from here. The window shows what arrived as written by the
  // caller (its `as` name) and editable, and holds the confirm button back for a
  // moment so a reflex keystroke cannot complete what nobody read.
  "pr.merge.stage": def({
    modals: ["MergeDialog.tsx", "ConfirmDialog.tsx"], level: 3, kind: "stage",
    surface: "the merge dialog of one pull request, with the method and the commit message filled in (nothing merges until the person presses Merge)",
    args: {
      repo: { t: "repo" }, number: PR_NUMBER, method: { t: "enum", values: STAGE_MERGE_METHODS },
      subject: { t: "text", max: STAGE_SUBJECT_MAX, line: true, optional: true }, body: { t: "text", max: STAGE_BODY_MAX, optional: true },
    },
    refine: prNumberOk,
  }),
  "pr.comment.stage": def({
    level: 3, kind: "stage", surface: "the comment box of one pull request, with the text filled in (nothing is posted until the person presses Comment)",
    args: { repo: { t: "repo" }, number: PR_NUMBER, body: { t: "text", max: STAGE_BODY_MAX } },
    refine: prNumberOk,
  }),
  "pr.review.stage": def({
    level: 3, kind: "stage", surface: "the review form of one pull request, with the verdict and the text filled in (nothing is submitted until the person presses Submit)",
    args: { repo: { t: "repo" }, number: PR_NUMBER, verdict: { t: "enum", values: STAGE_REVIEW_VERDICTS }, body: { t: "text", max: STAGE_BODY_MAX, optional: true } },
    // GitHub takes a bare approval; a request for changes or a comment says why.
    refine: (a) => (prNumberOk(a) && (a.verdict === "approve" || a.body !== undefined) ? a : null),
  }),
  "card.move.stage": def({
    modals: ["ConfirmDialog.tsx"], level: 3, kind: "stage",
    surface: "the move dialog for the card of one pull request, with the new status filled in (nothing moves until the person presses Move)",
    args: { repo: { t: "repo" }, number: PR_NUMBER, status: { t: "text", max: 80, line: true } },
    refine: prNumberOk,
  }),
} as const satisfies Record<string, UiActionDef>;

export type UiActionId = keyof typeof UI_ACTIONS;
export const UI_ACTION_IDS = Object.keys(UI_ACTIONS) as UiActionId[];
/** The entries that answer with state. They need a reply, so /control waits for
 *  one whether or not the caller sent an `id`. */
export type UiReadId = { [K in UiActionId]: (typeof UI_ACTIONS)[K]["kind"] extends "read" ? K : never }[UiActionId];
export const UI_READ_IDS = UI_ACTION_IDS.filter((id): id is UiReadId => (UI_ACTIONS[id] as UiActionDef).kind === "read");
export const isReadAction = (id: string): boolean => (UI_READ_IDS as readonly string[]).includes(id);

/**
 * Settings panes (and views) `ui.read` does NOT describe, with the reason. Said
 * in the answer of `ui.state`, so an agent learns the edge from the app and not
 * from a failed call.
 */
export const UI_READ_NOT_COVERED: Readonly<Record<string, string>> = {
  "settings.connections": "credential pane: values are never read through this channel (settings.privacy says only whether ClickUp is set)",
  "settings.remote": "credential pane: values are never read through this channel (settings.privacy says only how many devices are paired)",
  "settings.clickup": "credential pane: values are never read through this channel (settings.privacy says only whether it is set)",
  "settings.onboarding": "not a setting",
};

/**
 * What a read answers with. Two buckets and the line between them is the point:
 *
 *  - `state` holds only what the app minted or the owner chose from a closed
 *    set: booleans, numbers, enum words, ids. It is safe to act on.
 *  - `untrusted` holds every string that came from outside (a chat message, a
 *    tab title, a file path, a pull request title, text a page produced), bounded
 *    to UNTRUSTED_MAX_BYTES. An agent reads it as data and never obeys it.
 *
 * Secrets and credential-class fields are not in either: they are replaced by
 * `{set: boolean}` where the provider is built (web/src/lib/uiSnapshots.ts).
 */
export interface UiSnapshot {
  state: Record<string, unknown>;
  untrusted: Record<string, unknown>;
  /** The server-held routes that carry the rest, so a snapshot adds only what
   *  the renderer alone knows. */
  see?: string[];
}
export const UNTRUSTED_MAX_BYTES = 16 * 1024;

/** What a window says it did with a command that carried a request id. */
export interface UiReply {
  ok: boolean; applied: boolean; value?: unknown; error?: string;
  /** A quiet open the window held behind a chip instead of running (the person
   *  was typing). `ok` is true and `applied` is false: it was taken, not shown. */
  queued?: true;
}

/**
 * How an open reaches the person's screen. `now` runs at once, as it always did
 * for a Stream Deck button. `quiet` never raises the OS window and never takes
 * the keyboard, and when the person is typing the window holds the open behind
 * a chip they can click (web/src/lib/quietPresent.ts decides).
 */
export type UiPresent = "quiet" | "now";

/**
 * The mode a /control body asks for: `undefined`/`null` on the wire means "the
 * default", which is quiet for a caller that stamped `as` (the CLI and the MCP
 * server always do) and now for one that did not. A caller can always omit `as`
 * and get `now`; that is an annoyance and not a privilege, so declaring
 * yourself is the safe direction. An explicit value that is neither word is
 * refused (null) rather than guessed at, because the guess decides whether a
 * dialog lands on somebody who is typing. A `stage` is quiet even for an unnamed
 * caller: it puts a filled-in dialog in front of the person, and the one thing
 * worse than a late dialog is one that arrives under their hands.
 */
export function presentOf(raw: unknown, as: string | null, kind?: UiKind): UiPresent | null {
  // A stage is never shown by default over somebody who may be typing, named caller or not.
  if (raw === undefined || raw === null) return as || kind === "stage" ? "quiet" : "now";
  return raw === "quiet" || raw === "now" ? raw : null;
}
/** The most a reply may weigh on the wire; larger is refused by the server. */
export const UI_REPLY_MAX_BYTES = 64 * 1024;

type Val<S> =
  S extends { t: "enum"; values: readonly (infer V)[] } ? V
  : S extends { t: "num"; values: readonly (infer V)[] } ? V
  : S extends { t: "bool" } ? boolean
  : S extends { t: "pathKind" } ? "file" | "dir"
  : S extends { t: "scalar" } ? string | number | boolean
  : S extends { t: "int" } ? number
  : string;
type Args<A> =
  { [K in keyof A as A[K] extends { optional: true } ? never : K]: Val<A[K]> } &
  { [K in keyof A as A[K] extends { optional: true } ? K : never]?: Val<A[K]> };
/** The validated arguments of one registry entry, typed from its spec. */
export type UiArgs<Id extends UiActionId> = Args<(typeof UI_ACTIONS)[Id]["args"]>;

/** A validated command as it travels: the `ui` wire shape. */
export type UiCmd = { [Id in UiActionId]: { cmd: "ui"; do: Id; args: UiArgs<Id> } }[UiActionId];

/**
 * The registry as a caller reads it: every entry at or below `maxLevel`, with
 * its argument specs, and nothing a function does (`refine`, `legacy`, `chords`
 * are the server's and the window's business). It is served at
 * GET /control/actions and is what the agent CLI and the MCP server list from,
 * so what an agent is told it may call is the registry itself, not a copy that
 * can fall behind it. An entry above the level the server accepts is left out:
 * listing a door the server would refuse is a promise it breaks.
 */
export function describeUiActions(
  registry: Readonly<Record<string, UiActionDef>> = UI_ACTIONS, maxLevel: UiLevel = 3,
): { id: string; level: number; kind: UiKind; surface: string; args: Record<string, ArgSpec> }[] {
  return Object.entries(registry)
    // The same test the parser runs, level AND kind: a door listed here is a door
    // the server will run, never one it lists and then refuses.
    .filter(([, d]) => levelAllows(d, maxLevel))
    .map(([id, d]) => ({ id, level: d.level, kind: d.kind, surface: d.surface, args: { ...d.args } }));
}

// ── levels ──────────────────────────────────────────────────────────────────

/**
 * Whether a server holding `maxLevel` may run this entry. Deny by default, in
 * three ways at once: `!(<=)` rather than `>`, so an entry with no level (a
 * cast, a plugin, a typo) compares false and counts as level 3; level 3 admits
 * a `stage` entry and nothing else, so an entry that claims level 3 and some
 * other kind is refused whatever the switch says; and a level below 3 admits
 * only the kinds KINDS_AT_LEVEL lists, so a `change` filed under level 1 cannot
 * ride in on the default.
 */
export function levelAllows(d: { level?: unknown; kind?: unknown }, maxLevel: UiLevel): boolean {
  const lv = d.level === 1 || d.level === 2 || d.level === 3 ? d.level : 3;
  if (!(lv <= maxLevel)) return false;
  return (KINDS_AT_LEVEL[lv] as readonly unknown[]).includes(d.kind);
}

/** Whether a kind alters something: the ones the write rate limit and the
 *  window's undo chip are about. Reads and opens do not. */
export const isWriteKind = (kind: unknown): boolean => kind === "change" || kind === "stage";

const LEVEL_WORDS: Record<UiLevel, string> = {
  1: "looks or opens",
  2: "changes a local setting",
  3: "prepares something with an effect outside the app, which only the person's own click completes",
};

/**
 * The sentence a caller is told when the entry exists and this server will not
 * run it: which door, which level it is, which level the server holds, and
 * whose decision that is. It does NOT say how to raise the level: the limit is
 * the owner's, and a sentence an agent with a shell reads as a recipe is how a
 * limit gets walked around. `readonly` is AGENTGLASS_CONTROL_READONLY, said as
 * "read-only" without the name. An entry with no level is reported as level 3,
 * which is how it is treated.
 */
export function levelRefusal(id: string, d: { level?: unknown; kind?: unknown }, maxLevel: UiLevel, readonly = false): string {
  const lv: UiLevel = d.level === 1 || d.level === 2 || d.level === 3 ? d.level : 3;
  const what = d.level === lv ? `a level ${lv} door (it ${LEVEL_WORDS[lv]})` : "a door with no level, which counts as level 3";
  if (d.level === 3 && d.kind !== "stage") return `${id} is a level 3 door that is not a stage: no setting allows it, because level 3 only prepares and the person's click is the effect.`;
  const held = readonly ? "the owner has made this server read-only (opens and reads only)" : `this server allows up to level ${maxLevel}`;
  return `${id} is ${what}, and ${held}. That limit is the owner's setting, made when the server starts; ask the person who runs agentglass if you need it, and do not try to change it.`;
}

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

/** Longest string a setting's value may be: a font id or a palette name, not text. */
const MAX_SCALAR = 200;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// owner/name the way GitHub spells it: neither half is empty, `.` or `..`.
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
/*
 * What `text` refuses, as a whole: the C0 controls (a newline and a tab stay), DEL
 * and the C1 range, line and paragraph separators, and every character Unicode
 * calls default-ignorable, format, private-use, unassigned or a lone surrogate.
 * Those are the ones that make a string say one thing on screen and another to
 * whatever reads it: bidirectional controls reorder what is drawn, zero-width,
 * soft-hyphen and filler characters draw nothing, variation selectors and the
 * tag block can carry a whole message in nothing visible, and a blank braille
 * cell is a space nobody can count. A staged text is read by a person before they
 * press anything; this keeps the reading honest. The denylist this replaced
 * missed variation selectors, Hangul fillers and braille blank, so this is the
 * categories and not a list of examples.
 *
 * Two characters emoji need are let through, a variation selector-16 and a zero
 * width joiner, but only right after a non-ASCII character and at most
 * MAX_EMOJI_GLUE of them: enough for a heart or a family, sixteen bits for
 * anything smuggled.
 */
const HIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u2800\ufffc]|[\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
const EMOJI_GLUE = /(?<=[^\x00-\x7f])[\ufe0f\u200d]/gu;
const MAX_EMOJI_GLUE = 16;
/*
 * What the field would hide or GitHub would not draw. `<!--` opens a comment;
 * a link reference definition (`[x]: # (note)`) renders nothing; `<details>`
 * collapses what is inside it; three newlines in a row push text below the
 * four rows the box shows, where GitHub collapses the gap and draws it under
 * the person's name.
 */
const HIDDEN_MARKUP = /<!--|<details\b|^[ \t]*\[[^\]\n]*\]:[ \t]/mi;

/** `owner/name`, or null. */
export function repoName(raw: unknown): string | null {
  return typeof raw === "string" && raw.length <= 201 && REPO.test(raw) ? raw : null;
}

/** A staged text: non-empty once trimmed, within `max`, one line when asked, nothing hidden. */
export function plainText(raw: unknown, max: number, line = false): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max) return null;
  const glue = raw.match(EMOJI_GLUE)?.length ?? 0;
  if (glue > MAX_EMOJI_GLUE || HIDDEN_TEXT.test(raw.replace(EMOJI_GLUE, ""))) return null;
  if (!raw.isWellFormed() || HIDDEN_MARKUP.test(raw) || /\n[ \t]*\n[ \t]*\n/.test(raw)) return null;
  if (line && (/[\n\t]/.test(raw) || /  /.test(raw))) return null;
  return raw;
}
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
    case "int": return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= spec.max ? v : undefined;
    case "abspath": return absPath(v)?.path;
    case "relpath": return relPath(v) ?? undefined;
    case "repo": return repoName(v) ?? undefined;
    case "text": return plainText(v, spec.max, spec.line === true) ?? undefined;
    case "scalar":
      return typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= MAX_SCALAR && !CONTROL_CHARS.test(v)) ? v : undefined;
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

/** What one argument takes, as a sentence fragment: the part of a refusal that
 *  lets the caller correct itself instead of guessing. */
export function specAccepts(spec: ArgSpec): string {
  switch (spec.t) {
    case "enum": return `one of ${spec.values.join(", ")}`;
    case "num": return `one of ${spec.values.join(", ")}`;
    case "bool": return "true or false";
    case "slug": return `a name of letters, digits and . _ : - (at most ${spec.max})`;
    case "ref": return "a git ref";
    case "int": return `a whole number from 0 to ${spec.max}`;
    case "abspath": return "an absolute path without . or .. segments";
    case "relpath": return "a relative path without . or .. segments";
    case "repo": return "a repository as owner/name";
    case "text": return `${spec.line ? "one line of" : "plain"} text (at most ${spec.max} characters, not empty, no hidden or control characters, no HTML comment)`;
    case "pathKind": return "file or dir";
    case "scalar": return "a string, number or boolean";
  }
}

/**
 * Why `parseArgs` said no, in a sentence: the first argument that is missing or
 * wrong, and what it takes. Measured: the bare "unknown control command" for a
 * door that exists (`panel.open` with `what: "stat"`) gave the caller nothing to
 * correct. Only ever called for a door the server would run, so it lists nothing
 * above the level. Null when the arguments are fine (a `refine` refusal is then
 * the cause, and says so).
 */
export function argsRefusal(id: string, d: UiActionDef, raw: unknown): string | null {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return `${id} takes its arguments as an object`;
  const b = (raw ?? {}) as Record<string, unknown>;
  for (const [k, spec] of Object.entries(d.args)) {
    if (spec.t === "pathKind") continue;
    const optional = "optional" in spec && spec.optional;
    if (b[k] === undefined) {
      if (!optional) return `${id} needs "${k}": ${specAccepts(spec)}`;
      continue;
    }
    if (one(spec, b[k]) === undefined) return `${id} does not take that "${k}"; accepted: ${specAccepts(spec)}`;
  }
  return parseArgs(d, raw) ? null : `${id} refused that combination of arguments`;
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
  if (!levelAllows(d, maxLevel)) return null;
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
    if (!levelAllows(d, maxLevel)) return null;
    const args = parseArgs(d, b);
    return args ? { id, args } : null;
  }
  return null;
}

/**
 * The registry entry an untrusted /control body names, in either spelling, with
 * no regard for level or arguments: what the refusal sentence needs to say which
 * door was asked for. Null when the body names none.
 */
export function entryOfBody(b: Record<string, unknown>): { id: string; def: UiActionDef } | null {
  if (b.cmd === "ui") {
    return typeof b.do === "string" && Object.prototype.hasOwnProperty.call(UI_ACTIONS, b.do)
      ? { id: b.do, def: UI_ACTIONS[b.do as UiActionId] as UiActionDef } : null;
  }
  for (const [id, d] of LEGACY) {
    const l = d.legacy!;
    if (b.cmd === l.cmd && (!l.pin || Object.entries(l.pin).every(([k, v]) => b[k] === v))) return { id, def: d };
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
