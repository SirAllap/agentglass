/*
 * What a control frame does once it reaches a window, without a renderer.
 *
 * `runControl` is the decision (which door, with what, after a second look at the
 * arguments); the handlers call the seams the UI itself uses, so each test
 * observes the seam and not a fake of it. App only hands over the state it owns.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { UI_ACTIONS, READ_PANELS } from "../../shared/uiActions.ts";
import { DEFAULT_NOTIFY_PREFS } from "../../shared/notifyPrefs.ts";
import type { Sources, AppSlice } from "../src/lib/uiSnapshots.ts";
import type { ControlCmd } from "../../shared/types.ts";
import { runControl, controlReply, nextThemeId, UI_HANDLERS, type UiCtx } from "../src/lib/uiActions.ts";
import { onOpenSettings } from "../src/lib/openSettings.ts";
import { onFinderAt, type FinderTarget } from "../src/lib/finderTarget.ts";
import { peekChatIntent, takeChatIntent } from "../src/lib/chatIntent.ts";
import { takeGitModal, latchGitModal, GIT_MODAL_TTL_MS } from "../src/lib/gitModalIntent.ts";
import { benchState, __resetBench } from "../src/lib/benchStore.ts";
import { clearPeek, peekRequest } from "../src/lib/openPeek.ts";

const stubGlobal = globalStubs();
// A window is only an event target here: the finder's channel is an event on it.
stubGlobal("window", new EventTarget());
stubGlobal("CustomEvent", class<T> extends Event { detail: T; constructor(t: string, i: { detail: T }) { super(t); this.detail = i.detail; } });

/** A ctx that records what it was asked, in order. */
function ctx() {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  const c: UiCtx = {
    goView: rec("goView"), workspace: rec("workspace"), peel: rec("peel"), panel: rec("panel"),
    setTheme: (next) => calls.push(["setTheme", next("graphite")]),
    zoom: rec("zoom"), setMachine: rec("setMachine"), setProjectOpen: rec("setProjectOpen"), setWindowsOpen: rec("setWindowsOpen"),
  };
  return { c, calls };
}
const ui = (id: string, args: Record<string, unknown> = {}) => ({ cmd: "ui", do: id, args }) as unknown as ControlCmd;

beforeEach(() => { __resetBench(); clearPeek(); takeChatIntent(); takeGitModal(); });
afterEach(() => { onOpenSettings(null); });

describe("runControl — one handler for both spellings", () => {
  it("the old and the new spelling of a view run the same handler", () => {
    const a = ctx(), b = ctx();
    expect(runControl({ cmd: "view", to: "git" }, a.c)).toBe("view.open");
    expect(runControl(ui("view.open", { to: "git" }), b.c)).toBe("view.open");
    expect(a.calls).toEqual([["goView", "git"]]);
    expect(b.calls).toEqual(a.calls);
  });

  it("every old body still reaches the state App owns", () => {
    const k = ctx();
    runControl({ cmd: "open", what: "stats" }, k.c);
    runControl({ cmd: "esc" }, k.c);
    runControl({ cmd: "workspace" }, k.c);
    runControl({ cmd: "zoom", dir: -1 }, k.c);
    runControl({ cmd: "theme", name: "porcelain" }, k.c);
    expect(k.calls).toEqual([["panel", "stats"], ["peel"], ["workspace"], ["zoom", -1], ["setTheme", "porcelain"]]);
  });

  it("a chat command latches the intent and then opens the view", () => {
    const k = ctx();
    runControl({ cmd: "chat", do: "new" }, k.c);
    expect(peekChatIntent()).toBe("new");
    expect(k.calls).toEqual([["goView", "chat"]]);
  });

  it("a frame that names no door, or an unknown one, runs nothing", () => {
    const k = ctx();
    for (const f of [{ cmd: "nope" }, ui("settings.set", { id: "x" }), ui("__proto__"), ui("toString"), ui("constructor")]) {
      expect(runControl(f as unknown as ControlCmd, k.c)).toBeNull();
    }
    expect(k.calls).toEqual([]);
  });

  it("is a second look: arguments the server would have refused do not run", () => {
    const k = ctx();
    expect(runControl(ui("view.open", { to: "secrets" }), k.c)).toBeNull();
    expect(runControl(ui("machine.open", {}), k.c)).toBeNull();
    expect(k.calls).toEqual([]);
    const seen: FinderTarget[] = [];
    const off = onFinderAt((t) => seen.push(t));
    expect(runControl({ cmd: "open", what: "finder", path: "plan.md", kind: "file" } as ControlCmd, k.c)).toBeNull();
    expect(runControl({ cmd: "open", what: "finder", path: "/home/ana/../bob", kind: "file" } as ControlCmd, k.c)).toBeNull();
    expect(seen).toEqual([]);
    off();
  });
});

describe("the doors, each through its own seam", () => {
  it("finder: a file and a folder, as the old frame asked", () => {
    const seen: FinderTarget[] = [];
    const off = onFinderAt((t) => seen.push(t));
    runControl({ cmd: "open", what: "finder", path: "/home/ana/notes/plan.md", kind: "file" }, ctx().c);
    runControl(ui("finder.open", { path: "/home/ana/notes", kind: "dir" }), ctx().c);
    off();
    expect(seen.map((t) => [t.path, t.kind])).toEqual([["/home/ana/notes/plan.md", "file"], ["/home/ana/notes", "dir"]]);
  });

  it("settings.open lands on the page and the row, and only there", () => {
    const got: unknown[][] = [];
    onOpenSettings((p, r) => got.push([p, r]));
    runControl(ui("settings.open", { page: "appearance" }), ctx().c);
    runControl(ui("settings.open", { page: "diff", row: "wrap-long-lines" }), ctx().c);
    expect(got).toEqual([["appearance", undefined], ["diff", "wrap-long-lines"]]);
  });

  it("machine, project picker and window switcher go through App's setters", () => {
    const k = ctx();
    runControl(ui("machine.open", { tab: "locks" }), k.c);
    runControl(ui("project.picker"), k.c);
    runControl(ui("windows.switcher"), k.c);
    expect(k.calls).toEqual([["setMachine", "locks"], ["setProjectOpen", true], ["setWindowsOpen", true]]);
  });

  it("the bench toggles, opens a file under its root, and takes a board", () => {
    runControl(ui("bench.toggle"), ctx().c);
    expect(benchState().open).toBe(true);
    runControl(ui("bench.file", { root: "/home/ana/code/orbit", path: "docs/plan.md" }), ctx().c);
    const tabs = benchState().byRoot["/home/ana/code/orbit"]!.tabs;
    expect(tabs.map((t) => [t.kind, t.path, t.title])).toEqual([["file", "/home/ana/code/orbit/docs/plan.md", "plan.md"]]);
    runControl(ui("bench.board", { root: "/home/ana/code/orbit", kind: "pr" }), ctx().c);
    expect(benchState().byRoot["/home/ana/code/orbit"]!.tabs.map((t) => t.kind)).toEqual(["file", "pr"]);
  });

  it("peek.file opens the viewer for reading, never for editing", () => {
    runControl(ui("peek.file", { root: "/home/ana/code/orbit", path: "docs/plan.md" }), ctx().c);
    const p = peekRequest();
    expect(p).toMatchObject({ root: "/home/ana/code/orbit", path: "/home/ana/code/orbit/docs/plan.md", label: "docs/plan.md" });
    expect(p!.edit).toBeFalsy();
  });

  it("git modals latch for the Git view and bring it up", () => {
    const k = ctx();
    runControl(ui("git.modal", { which: "insights" }), k.c);
    expect(k.calls).toEqual([["goView", "git"]]);
    expect(takeGitModal()).toEqual({ which: "insights" });
    runControl(ui("git.compare", { base: "origin/main" }), k.c);
    expect(takeGitModal()).toEqual({ which: "compare", base: "origin/main" });
    runControl(ui("git.blame", { path: "src/a.ts" }), k.c);
    expect(takeGitModal()).toEqual({ which: "blame", path: "src/a.ts" });
  });
});

describe("the git modal mailbox", () => {
  it("is one slot, read once, and a request nobody was there for lapses", () => {
    latchGitModal({ which: "bisect" });
    latchGitModal({ which: "insights" });
    expect(takeGitModal()).toEqual({ which: "insights" });
    expect(takeGitModal()).toBeNull();
    latchGitModal({ which: "bisect" });
    expect(takeGitModal(Date.now() + GIT_MODAL_TTL_MS + 1000)).toBeNull();
  });
});

describe("nextThemeId", () => {
  const ids = ["graphite", "porcelain", "nord"];
  it("a name pins, an unknown name leaves the current one", () => {
    expect(nextThemeId("graphite", { name: "nord" }, ids)).toBe("nord");
    expect(nextThemeId("graphite", { name: "mauve" }, ids)).toBe("graphite");
  });
  it("a direction steps the list and wraps both ways", () => {
    expect(nextThemeId("graphite", { dir: 1 }, ids)).toBe("porcelain");
    expect(nextThemeId("nord", { dir: 1 }, ids)).toBe("graphite");
    expect(nextThemeId("graphite", { dir: -1 }, ids)).toBe("nord");
    expect(nextThemeId("unknown", { dir: 1 }, ids)).toBe("porcelain");
  });
});

describe("the table", () => {
  it("has a function for every door", () => {
    for (const id of Object.keys(UI_ACTIONS)) expect(typeof (UI_HANDLERS as Record<string, unknown>)[id], id).toBe("function");
  });
});

/* ── reads ───────────────────────────────────────────────────────────────── */

const slice: AppSlice = {
  view: "chat", theme: "graphite", scale: 1, workspace: null, windowMs: 1, filter: { app: "", type: "", provider: "" },
  modals: { settings: false, palette: false, help: false, stats: false, skills: false, search: false, finder: false, windows: false, projectPicker: false, machine: null },
  selectedEvent: null, session: null, peek: null, finderPath: null,
};
const fixture: Sources = {
  app: () => slice, chats: () => ({ list: [], activeId: "" }), bench: () => benchState(), gates: () => [],
  diff: () => ({ split: true, wrap: false, noWhitespace: false, theme: "auto" }),
  terminal: () => ({ font: "", size: 13, cursor: "block", lineHeight: 1, scrollback: 4000, wordSeparators: " ", copyOnSelect: true, noteEditor: "builtin" }),
  browser: () => ({ home: "https://duckduckgo.com", engine: "duckduckgo", zoomLevel: 0, importHistory: true, importBookmarks: true }),
  notify: () => DEFAULT_NOTIFY_PREFS,
};

describe("controlReply — what the window answers", () => {
  it("ui.state and every ui.read panel answer a snapshot, and call nothing App owns", () => {
    const k = ctx();
    k.c.sources = fixture;
    for (const cmd of [ui("ui.state"), ...READ_PANELS.map((panel) => ui("ui.read", { panel }))]) {
      const r = controlReply(cmd, k.c);
      expect(r.ok, JSON.stringify(cmd)).toBe(true);
      expect(r.applied).toBe(true);
      expect(Object.keys((r.value ?? {}) as object)).toEqual(expect.arrayContaining(["state", "untrusted"]));
    }
    expect(k.calls).toEqual([]);
  });

  it("a read raises nothing: no setting is opened, no view changes, no chat or git intent is latched, the bench stays shut", () => {
    const k = ctx();
    k.c.sources = fixture;
    let opened = 0;
    onOpenSettings(() => { opened++; });
    for (const panel of READ_PANELS) controlReply(ui("ui.read", { panel }), k.c);
    controlReply(ui("ui.state"), k.c);
    expect(opened).toBe(0);
    expect(k.calls).toEqual([]);
    expect(benchState().open).toBe(false);
    expect(takeChatIntent()).toBeNull();
    expect(takeGitModal()).toBeNull();
    expect(peekRequest()).toBeNull();
  });

  it("an open answers applied with no value", () => {
    const k = ctx();
    expect(controlReply(ui("machine.open", { tab: "ports" }), k.c)).toEqual({ ok: true, applied: true });
    expect(k.calls).toEqual([["setMachine", "ports"]]);
  });

  it("a frame that names no door, or fails the second look, answers not-applied with a reason", () => {
    const k = ctx();
    expect(controlReply({ cmd: "ui", do: "settings.set", args: {} } as unknown as ControlCmd, k.c)).toMatchObject({ ok: false, applied: false });
    expect(controlReply(ui("ui.read", { panel: "../x" }), k.c)).toMatchObject({ ok: false, applied: false });
  });

  it("a window that cannot describe itself says so, and a throwing handler is an error and not a crash", () => {
    const k = ctx();
    expect(controlReply(ui("ui.state"), k.c)).toEqual({ ok: false, applied: false, error: "this window cannot describe itself" });
    k.c.sources = { ...fixture, chats: () => { throw new Error("store exploded"); } };
    expect(controlReply(ui("ui.read", { panel: "chat" }), k.c)).toEqual({ ok: false, applied: false, error: "store exploded" });
  });

  it("the reply survives the wire: JSON in, the same JSON out", () => {
    const k = ctx();
    k.c.sources = fixture;
    const r = controlReply(ui("ui.state"), k.c);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});
