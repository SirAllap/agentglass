/*
 * What each door in shared/uiActions.ts does once it reaches this window.
 *
 * The table is keyed by the registry's own ids, so adding a door there without
 * a handler here is a type error, and so is a handler for a door that was
 * removed: `make check` is the guard, no test needs to remember. Every handler
 * calls the seam the UI itself uses (openSettings, toggleBench, openPeek…), so a
 * command and a click cannot mean different things.
 *
 * App owns the state of its own modals and views, so it hands them over as a
 * `UiCtx` of plain functions; everything else is a module-level seam imported
 * directly. A command may arrive at a window that was never meant to show it (a
 * phone, a tab with another project): every seam here is a no-op with nothing
 * listening, which is why none of these throws.
 */
import { UI_ACTIONS, canonView, parseArgs, uiOf, type UiActionId, type UiArgs, type UiReply } from "../../../shared/uiActions.ts";
import type { ControlCmd, ViewId } from "../../../shared/types.ts";
import { openSettings } from "./openSettings.ts";
import { openFinderAt } from "./finderTarget.ts";
import { latchGitModal } from "./gitModalIntent.ts";
import { latchViewModal } from "./viewModalIntent.ts";
import { latchStage } from "./stageIntent.ts";
import { requestPrJump } from "./prJump.ts";
import { latchUnstick } from "./unstickIntent.ts";
import { filterGet, filterSet, viewsDelete, viewsList, viewsSave } from "./prFilterDoor.ts";
import { showWhatsNew } from "./whatsNew.ts";
import { toggleBench, showFile, showBoard } from "./benchStore.ts";
import { openPeek } from "./openPeek.ts";
import { THEMES } from "./themes.ts";
import { settings } from "./settingsRegistry.ts";
import type { MachineTab } from "../components/MachinePanel.tsx";
import { readPanel, uiState, type Sources } from "./uiSnapshots.ts";

export interface UiCtx {
  goView(v: ViewId): void;
  /** The last view that was not the dashboard (the old `workspace` command). */
  workspace(): void;
  /** The peel Escape does, minus the focus guards. */
  peel(): void;
  panel(what: UiArgs<"panel.open">["what"]): void;
  zoom(dir: 1 | -1 | 0): void;
  setMachine(tab: MachineTab): void;
  setProjectOpen(open: boolean): void;
  setWindowsOpen(open: boolean): void;
  /** The event modal on an event from this window's feed, or the server's recent
   *  feed when the window has paused its own (a view covers the dashboard);
   *  false when neither has one by that id. */
  openEvent(id: number): boolean | Promise<boolean>;
  openSession(id: string, app?: string): void;
  /** The pane chords' own function: false when no focused pane has anything to open. */
  paneDoor(which: UiArgs<"pane.open">["which"]): boolean;
  /** The worktree of the focused terminal pane, or null when no terminal is up.
   *  A Git modal asked for from a terminal is about this checkout. */
  paneRoot?(): string | null;
  /** Where the reads gather their data (uiSnapshotSources.ts in the window; a
   *  fixture in a test). Absent in a window that cannot describe itself. */
  sources?: Sources;
  /** The level the server holds (it tells the window with each command), so
   *  `settings.list` says what is writable HERE. Absent: the window's own cap. */
  serverLevel?: 1 | 2 | 3;
  /** The name the caller stamped on the call (`--as`), so a setting change can
   *  say who made it on its chip. */
  as?: string;
  /** The server granted this change (the person approved it): an escalation-class
   *  setting is applied instead of answered NEEDS_APPROVAL. */
  grant?: boolean;
  /** With `grant`: the value the person's card was read against. */
  expect?: string | number | boolean;
}

/** A handler of an `open` entry returns nothing; a handler of a `read` entry
 *  returns the snapshot it read, which is what the window answers with. */
type Handler<Id extends UiActionId> = (a: UiArgs<Id>, ctx: UiCtx) => unknown;

/** The registry's answer if it is one, else its refusal as an Error. */
function answered<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

function sourcesOf(ctx: UiCtx): Sources {
  if (!ctx.sources) throw new Error("this window cannot describe itself");
  return ctx.sources;
}

/**
 * The next palette. A name pins one (an unknown name leaves the current one,
 * which is what a typo should do), a direction steps the list and wraps.
 */
export function nextThemeId(cur: string, a: { name?: string; dir?: 1 | -1 }, ids: readonly string[]): string {
  if (a.name !== undefined) return ids.includes(a.name) ? a.name : cur;
  const i = ids.indexOf(cur);
  const n = ids.length;
  return ids[((((i < 0 ? 0 : i) + (a.dir ?? 1)) % n) + n) % n]!;
}

const baseName = (p: string) => p.split("/").pop() || p;

/** The checkout a Git modal is about when the caller is in a terminal pane. */
const paneCheckout = (c: UiCtx): { root?: string } => {
  const root = c.paneRoot?.();
  return root ? { root } : {};
};

export const UI_HANDLERS: { [Id in UiActionId]: Handler<Id> } = {
  "view.open": (a, c) => c.goView(canonView(a.to) as ViewId),
  "workspace.toggle": (_a, c) => c.workspace(),
  "esc.peel": (_a, c) => c.peel(),
  "panel.open": (a, c) => c.panel(a.what),
  "finder.open": (a) => openFinderAt(a.path, a.kind),
  // Through the appearance.theme setting, as the Settings row does, so a palette
  // change from an agent is validated the same way, leaves the undo chip, and the
  // window repaints itself on the setting's own announcement.
  "theme.set": (a, c) => {
    const cur = answered(settings.get("appearance.theme")) as { value?: unknown };
    return answered(settings.set("appearance.theme", nextThemeId(String(cur.value ?? ""), a, THEMES.map((t) => t.id)), c.as));
  },
  "zoom.step": (a, c) => c.zoom(a.dir),
  "settings.open": (a) => openSettings(a.page, a.row),
  // Through the settings registry: the same defs the Settings rows call, so a
  // value is validated and stored exactly as a click would, and an agent's
  // write leaves an undo chip (AgentChangeChip).
  // A refusal throws, so controlReply answers {ok:false, applied:false, error}
  // instead of an ok whose value says it did not happen.
  "settings.get": (a) => answered(settings.get(a.id)),
  "settings.list": (_a, c) => settings.list(c.serverLevel),
  "settings.set": (a, c) => answered(settings.set(a.id, a.value, c.as, c.grant === true, c.expect)),
  "machine.open": (a, c) => c.setMachine(a.tab),
  "project.picker": (_a, c) => c.setProjectOpen(true),
  "windows.switcher": (_a, c) => c.setWindowsOpen(true),
  "bench.toggle": () => toggleBench(),
  "bench.file": (a) => { showFile(a.root, `${a.root}/${a.path}`, { title: baseName(a.path) }); },
  "bench.board": (a) => { showBoard(a.root, a.kind); },
  "peek.file": (a) => openPeek({ root: a.root, path: `${a.root}/${a.path}`, label: a.path }),
  // The Git modals draw over the current view (they are portals); the Git view
  // is mounted hidden for them, never switched to. See lib/gitModalIntent.ts.
  "git.modal": (a, c) => { latchGitModal({ which: a.which, ...paneCheckout(c) }); },
  "git.compare": (a, c) => { latchGitModal({ which: "compare", base: a.base, ...paneCheckout(c) }); },
  "git.blame": (a, c) => { latchGitModal({ which: "blame", path: a.path, ...paneCheckout(c) }); },
  "git.rebase": (a, c) => { latchGitModal({ which: "rebase", base: a.base, ...paneCheckout(c) }); },
  "event.open": async (a, c) => { if (!(await c.openEvent(a.id))) throw new Error("no recent event has that id"); },
  "session.open": (a, c) => c.openSession(a.id, a.app),
  "whatsnew.open": () => showWhatsNew(),
  "lantern.schedule": (_a, c) => { latchViewModal("lantern.schedule"); c.goView("agents"); },
  "agents.change": (_a, c) => { latchViewModal("agents.change"); c.goView("agents"); },
  "terminal.resume": (_a, c) => { latchViewModal("terminal.resume"); c.goView("term"); },
  "terminal.sessions": (_a, c) => { latchViewModal("terminal.sessions"); c.goView("term"); },
  "settings.plugin": (a) => openSettings(`plugin:${a.name}`),
  // The chords' own seam. The chord lets the key fall through when nothing
  // answers; an agent is told instead, since silence reads as success.
  "pane.open": (a, c) => { if (!c.paneDoor(a.which)) throw new Error("no focused terminal pane has a " + a.which + " to open"); },
  // Level 3, stage only. Each leaves the draft for the pull request panel and
  // opens the pull request view, as a notification does; the panel opens its own
  // dialog filled in once the pull request has loaded. Nothing here sends. Written
  // out in each handler rather than behind a helper, so the stage guard
  // (web/test/ui-level-guards.test.ts) reads the seams every one of them calls.
  "pr.merge.stage": (a, c) => { latchStage({ id: "pr.merge.stage", a }, c.as); requestPrJump(a.repo, a.number); c.goView("pr"); },
  "pr.comment.stage": (a, c) => { latchStage({ id: "pr.comment.stage", a }, c.as); requestPrJump(a.repo, a.number); c.goView("pr"); },
  "pr.review.stage": (a, c) => { latchStage({ id: "pr.review.stage", a }, c.as); requestPrJump(a.repo, a.number); c.goView("pr"); },
  "card.move.stage": (a, c) => { latchStage({ id: "card.move.stage", a }, c.as); requestPrJump(a.repo, a.number); c.goView("pr"); },
  // The Finder's own stage: the folder opens with the path chosen, and the
  // Finder draws the confirmation. A new folder is made in `path`, so that one
  // opens the folder itself; every other operation is on the thing at `path`.
  "finder.op.stage": (a, c) => { latchStage({ id: "finder.op.stage", a }, c.as); openFinderAt(a.path, a.op === "new-folder" ? "dir" : "file"); },
  // The machine panel's disk cleanup block draws the staged lines on mount (it
  // drains the mailbox like the Finder does), so the mailbox is filled first. Only
  // the person's press of the panel's Clean button removes anything.
  "diskclean.stage": (a, c) => { latchStage({ id: "diskclean.stage", a }, c.as); c.setMachine("resources"); },
  // The usage popover draws the confirmation for this one (accountStageOf in
  // lib/stageIntent.ts); only the person's press of its button switches anything.
  "usage.account.stage": (a, c) => { latchStage({ id: "usage.account.stage", a }, c.as); },
  // Stage: selects the pull request and opens the dialog. The dialog decides for
  // itself whether it qualifies and runs nothing until the owner confirms.
  "pr.unstick": (a, c) => { latchUnstick({ root: a.root, number: a.number }); c.goView("pr"); },
  // The board's filter and saved views. They go through the stores the panel
  // reads (lib/prFilterDoor.ts); nothing opens, so the panel need not be mounted.
  "pr.filter.get": (a) => filterGet(a.repo),
  "pr.filter.set": (a) => filterSet(a.repo, a),
  "pr.views.list": (a) => viewsList(a.repo),
  "pr.views.save": (a) => viewsSave(a.repo, a.name, a.filter),
  "pr.views.delete": (a) => viewsDelete(a.repo, a.name),
  // Reads: stores and pref modules only, nothing is shown, raised or focused.
  "ui.state": (_a, c) => uiState(sourcesOf(c)),
  "ui.read": (a, c) => readPanel(a.panel, sourcesOf(c)),
};

/**
 * Run one control frame in this window. Either spelling (`ui`, or the old
 * `view`/`open`/… bodies) lands on the same handler. Returns the id it ran and
 * what the handler returned, or null for a frame that names no door, so a caller
 * can tell a miss from a run.
 */
export function execControl(cmd: ControlCmd, ctx: UiCtx): { id: UiActionId; value: unknown } | null {
  const u = uiOf(cmd as { cmd: string } & Record<string, unknown>);
  if (!u) return null;
  // A frame is data off a socket, not something this window wrote: the server
  // has already vetted it, and this is the second look, by the same spec, at the
  // fields that become a path or a request. An older window handed an id it does
  // not know is refused by uiOf above rather than calling undefined.
  const args = parseArgs(UI_ACTIONS[u.do], u.args);
  if (!args) return null;
  return { id: u.do, value: (UI_HANDLERS[u.do] as (a: unknown, c: UiCtx) => unknown)(args, ctx) };
}

export const runControl = (cmd: ControlCmd, ctx: UiCtx): UiActionId | null => execControl(cmd, ctx)?.id ?? null;

/** The most a read of a server-held pane may wait for its route. The server
 *  gives up on the whole ask at five seconds (control.ts); answering first, with
 *  a sentence, beats being cut off with a bare timeout. */
export const LATE_READ_MS = 4000;

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown } | null)?.then === "function";

const fail = (e: unknown): UiReply => ({ ok: false, applied: false, error: e instanceof Error ? e.message : "the handler failed" });
const done = (value: unknown): UiReply => ({ ok: true, applied: true, ...(value === undefined ? {} : { value }) });

/**
 * The answer to POST /control/result for one command: what this window did.
 * `applied` means the handler ran without throwing; a seam with nothing
 * listening is a no-op by design (see above), so it cannot say more than that.
 * A handler that answers later (a pane the server holds) is `controlReplyLater`'s.
 */
export function controlReply(cmd: ControlCmd, ctx: UiCtx): UiReply {
  try {
    const r = execControl(cmd, ctx);
    if (!r) return { ok: false, applied: false, error: "this window does not know that door" };
    if (isThenable(r.value)) return { ok: false, applied: false, error: "that door answers later" };
    return done(r.value);
  } catch (e) {
    return fail(e);
  }
}

/** The same, waiting for a handler that returns a promise: a read of a pane the
 *  server holds asks that pane's own route. A route that fails or is slow is a
 *  sentence, not a hang. */
export async function controlReplyLater(cmd: ControlCmd, ctx: UiCtx, waitMs: number = LATE_READ_MS): Promise<UiReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = execControl(cmd, ctx);
    if (!r) return { ok: false, applied: false, error: "this window does not know that door" };
    const late = Promise.resolve(r.value);
    const value = await Promise.race([
      late,
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("the app's own server did not answer for that pane in time")), waitMs); }),
    ]);
    return done(value);
  } catch (e) {
    return fail(e);
  } finally {
    clearTimeout(timer);
  }
}
