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
import { UI_ACTIONS, parseArgs, uiOf, type UiActionId, type UiArgs, type UiReply } from "../../../shared/uiActions.ts";
import type { ControlCmd, ViewId } from "../../../shared/types.ts";
import { openSettings } from "./openSettings.ts";
import { openFinderAt } from "./finderTarget.ts";
import { latchChatIntent } from "./chatIntent.ts";
import { latchGitModal } from "./gitModalIntent.ts";
import { toggleBench, showFile, showBoard } from "./benchStore.ts";
import { openPeek } from "./openPeek.ts";
import { THEMES } from "./themes.ts";
import type { MachineTab } from "../components/MachinePanel.tsx";
import { PROVIDERS, uiState, type Sources } from "./uiSnapshots.ts";

export interface UiCtx {
  goView(v: ViewId): void;
  /** The last view that was not the dashboard (the old `workspace` command). */
  workspace(): void;
  /** The peel Escape does, minus the focus guards. */
  peel(): void;
  panel(what: UiArgs<"panel.open">["what"]): void;
  setTheme(next: (cur: string) => string): void;
  zoom(dir: 1 | -1 | 0): void;
  setMachine(tab: MachineTab): void;
  setProjectOpen(open: boolean): void;
  setWindowsOpen(open: boolean): void;
  /** Where the reads gather their data (uiSnapshotSources.ts in the window; a
   *  fixture in a test). Absent in a window that cannot describe itself. */
  sources?: Sources;
}

/** A handler of an `open` entry returns nothing; a handler of a `read` entry
 *  returns the snapshot it read, which is what the window answers with. */
type Handler<Id extends UiActionId> = (a: UiArgs<Id>, ctx: UiCtx) => unknown;

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

export const UI_HANDLERS: { [Id in UiActionId]: Handler<Id> } = {
  "view.open": (a, c) => c.goView(a.to),
  "workspace.toggle": (_a, c) => c.workspace(),
  "esc.peel": (_a, c) => c.peel(),
  "panel.open": (a, c) => c.panel(a.what),
  "finder.open": (a) => openFinderAt(a.path, a.kind),
  // Latch before opening: the panel drains the mailbox on mount, so this works
  // whether or not the chat view is already up.
  "chat.new": (_a, c) => { latchChatIntent("new"); c.goView("chat"); },
  "theme.set": (a, c) => c.setTheme((cur) => nextThemeId(cur, a, THEMES.map((t) => t.id))),
  "zoom.step": (a, c) => c.zoom(a.dir),
  "settings.open": (a) => openSettings(a.page, a.row),
  "machine.open": (a, c) => c.setMachine(a.tab),
  "project.picker": (_a, c) => c.setProjectOpen(true),
  "windows.switcher": (_a, c) => c.setWindowsOpen(true),
  "bench.toggle": () => toggleBench(),
  "bench.file": (a) => { showFile(a.root, `${a.root}/${a.path}`, { title: baseName(a.path) }); },
  "bench.board": (a) => { showBoard(a.root, a.kind); },
  "peek.file": (a) => openPeek({ root: a.root, path: `${a.root}/${a.path}`, label: a.path }),
  "git.modal": (a, c) => { latchGitModal({ which: a.which }); c.goView("git"); },
  "git.compare": (a, c) => { latchGitModal({ which: "compare", base: a.base }); c.goView("git"); },
  "git.blame": (a, c) => { latchGitModal({ which: "blame", path: a.path }); c.goView("git"); },
  // Reads: stores and pref modules only, nothing is shown, raised or focused.
  "ui.state": (_a, c) => uiState(sourcesOf(c)),
  "ui.read": (a, c) => PROVIDERS[a.panel](sourcesOf(c)),
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

/**
 * The answer to POST /control/result for one command: what this window did.
 * `applied` means the handler ran without throwing; a seam with nothing
 * listening is a no-op by design (see above), so it cannot say more than that.
 */
export function controlReply(cmd: ControlCmd, ctx: UiCtx): UiReply {
  try {
    const r = execControl(cmd, ctx);
    if (!r) return { ok: false, applied: false, error: "this window does not know that door" };
    return { ok: true, applied: true, ...(r.value === undefined ? {} : { value: r.value }) };
  } catch (e) {
    return { ok: false, applied: false, error: e instanceof Error ? e.message : "the handler failed" };
  }
}
