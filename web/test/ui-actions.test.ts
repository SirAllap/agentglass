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
import type { UiCtx } from "../src/lib/uiActions.ts";
import { onOpenSettings } from "../src/lib/openSettings.ts";
import { onFinderAt, type FinderTarget } from "../src/lib/finderTarget.ts";
import { peekChatIntent, takeChatIntent } from "../src/lib/chatIntent.ts";
import { takeGitModal, latchGitModal, GIT_MODAL_TTL_MS } from "../src/lib/gitModalIntent.ts";
import { benchState, __resetBench } from "../src/lib/benchStore.ts";
import { clearPeek, peekRequest } from "../src/lib/openPeek.ts";
import { peekViewModal, takeViewModal, latchViewModal, subscribeViewModal, VIEW_MODAL_TTL_MS } from "../src/lib/viewModalIntent.ts";
import { onShowWhatsNew } from "../src/lib/whatsNew.ts";

const stubGlobal = globalStubs();
// A window is only an event target here: the finder's channel is an event on it.
stubGlobal("window", new EventTarget());
stubGlobal("CustomEvent", class<T> extends Event { detail: T; constructor(t: string, i: { detail: T }) { super(t); this.detail = i.detail; } });
// uiActions reaches the settings registry and so pref modules that read localStorage when they load.
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
const attrs = new Map<string, string>([["data-theme", "graphite"]]);
stubGlobal("document", { documentElement: { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
const { runControl, controlReply, controlReplyLater, nextThemeId, UI_HANDLERS } = await import("../src/lib/uiActions.ts");

/** A ctx that records what it was asked, in order. */
function ctx() {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  const c: UiCtx = {
    goView: rec("goView"), workspace: rec("workspace"), peel: rec("peel"), panel: rec("panel"),
    zoom: rec("zoom"), setMachine: rec("setMachine"), setProjectOpen: rec("setProjectOpen"), setWindowsOpen: rec("setWindowsOpen"),
    openEvent: (id) => { calls.push(["openEvent", id]); return id !== 404; },
    openSession: rec("openSession"),
    paneDoor: (which) => { calls.push(["paneDoor", which]); return which !== "card"; },
  };
  return { c, calls };
}
const ui = (id: string, args: Record<string, unknown> = {}) => ({ cmd: "ui", do: id, args }) as unknown as ControlCmd;

beforeEach(() => { __resetBench(); clearPeek(); takeChatIntent(); takeGitModal(); takeViewModal("lantern.schedule"); takeViewModal("terminal.resume"); });
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
    expect(k.calls).toEqual([["panel", "stats"], ["peel"], ["workspace"], ["zoom", -1]]);
  });

  it("theme.set goes through the appearance.theme setting, so it answers with what it replaced and an undo", () => {
    const k = ctx();
    const r = controlReply({ cmd: "theme", name: "porcelain" }, k.c);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(r.value).toMatchObject({ ok: true, id: "appearance.theme", value: "porcelain" });
    expect(typeof (r.value as { undo: string }).undo).toBe("string");
    // An unknown name leaves the palette where it was, as it always did.
    expect(controlReply({ cmd: "theme", name: "mauve" }, k.c).ok).toBe(true);
  });

  it("settings.list says what is writable HERE: nothing when the server holds level 1, the usual set at 2 or when it does not say", () => {
    const writable = (serverLevel?: 1 | 2 | 3) => {
      const k = ctx();
      const r = controlReply(ui("settings.list"), { ...k.c, serverLevel });
      return (r.value as { writable: boolean }[]).filter((x) => x.writable).length;
    };
    expect(writable(1)).toBe(0);
    expect(writable(2)).toBeGreaterThan(20);
    expect(writable(3)).toBe(writable(2));
    expect(writable(undefined)).toBe(writable(2));
  });

  it("a chat command latches the intent and then opens the view", () => {
    const k = ctx();
    runControl({ cmd: "chat", do: "new" }, k.c);
    expect(peekChatIntent()).toBe("new");
    expect(k.calls).toEqual([["goView", "chat"]]);
  });

  it("a frame that names no door, or an unknown one, runs nothing", () => {
    const k = ctx();
    for (const f of [{ cmd: "nope" }, ui("settings.nope", { id: "x" }), ui("__proto__"), ui("toString"), ui("constructor")]) {
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

describe("the doors of the second batch", () => {
  it("the rebase editor and the git palette latch for the Git view", () => {
    const k = ctx();
    runControl(ui("git.rebase", { base: "origin/main" }), k.c);
    expect(takeGitModal()).toEqual({ which: "rebase", base: "origin/main" });
    runControl(ui("git.modal", { which: "palette" }), k.c);
    expect(takeGitModal()).toEqual({ which: "palette" });
    expect(k.calls).toEqual([["goView", "git"], ["goView", "git"]]);
  });

  it("an event opens only if a feed has it, and the agent hears when none does", async () => {
    const k = ctx();
    expect(await controlReplyLater(ui("event.open", { id: 7 }), k.c)).toEqual({ ok: true, applied: true });
    expect(k.calls).toEqual([["openEvent", 7]]);
    const miss = await controlReplyLater(ui("event.open", { id: 404 }), k.c);
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain("no recent event");
    // The second place to look may answer later.
    k.c.openEvent = async (id) => id === 9;
    expect(await controlReplyLater(ui("event.open", { id: 9 }), k.c)).toEqual({ ok: true, applied: true });
  });

  it("a session opens with or without its app name", () => {
    const k = ctx();
    runControl(ui("session.open", { id: "5f2c0a9e-1111", app: "orbit" }), k.c);
    runControl(ui("session.open", { id: "5f2c0a9e-1111" }), k.c);
    expect(k.calls).toEqual([["openSession", "5f2c0a9e-1111", "orbit"], ["openSession", "5f2c0a9e-1111", undefined]]);
  });

  it("the pane chords' door is asked, and a pane with nothing to open is an answer", () => {
    const k = ctx();
    expect(controlReply(ui("pane.open", { which: "pr" }), k.c).applied).toBe(true);
    const miss = controlReply(ui("pane.open", { which: "card" }), k.c);
    expect(miss).toMatchObject({ ok: false, applied: false });
    expect(miss.error).toContain("card");
    expect(controlReply(ui("pane.open", { which: "terminal" }), k.c).ok).toBe(false);
  });

  it("a plugin's page opens through the same bus as every settings link", () => {
    const seen: unknown[][] = [];
    onOpenSettings((...a) => { seen.push(a); });
    runControl(ui("settings.plugin", { name: "orbit-notes" }), ctx().c);
    expect(seen).toEqual([["plugin:orbit-notes"]]);
  });

  it("release notes on demand ask the component that owns the modal", () => {
    let asked = 0;
    const off = onShowWhatsNew(() => { asked += 1; });
    runControl(ui("whatsnew.open"), ctx().c);
    off();
    runControl(ui("whatsnew.open"), ctx().c);
    expect(asked).toBe(1);
  });

  it("the schedule dialog and the resume list latch for their view and bring it up", () => {
    const k = ctx();
    runControl(ui("lantern.schedule"), k.c);
    expect(takeViewModal("lantern.schedule")).toBe(true);
    runControl(ui("terminal.resume"), k.c);
    expect(takeViewModal("terminal.resume")).toBe(true);
    expect(k.calls).toEqual([["goView", "lantern"], ["goView", "term"]]);
  });
});

describe("the view modal mailbox", () => {
  it("is one slot, read once, and leaves a request for the other dialog alone", () => {
    latchViewModal("terminal.resume");
    expect(takeViewModal("lantern.schedule")).toBe(false);
    expect(peekViewModal("terminal.resume")).toBe(true);
    expect(takeViewModal("terminal.resume")).toBe(true);
    expect(takeViewModal("terminal.resume")).toBe(false);
  });

  it("a request nobody was there for lapses", () => {
    latchViewModal("lantern.schedule");
    expect(takeViewModal("lantern.schedule", Date.now() + VIEW_MODAL_TTL_MS + 1000)).toBe(false);
  });

  it("tells a listener, and a throwing listener does not stop the next", () => {
    const heard: string[] = [];
    const a = subscribeViewModal(() => { throw new Error("bad listener"); });
    const b = subscribeViewModal(() => heard.push("b"));
    latchViewModal("terminal.resume");
    a(); b();
    takeViewModal("terminal.resume");
    expect(heard).toEqual(["b"]);
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
  prefs: () => ({ scale: 1, clock24: false, splash: true }),
  rail: () => ({ work: ["dash"], utility: [], hidden: [], customised: false }),
  keys: () => ({ bindings: {}, chords: {}, appChords: {}, customised: { bindings: false, chords: false, appChords: false }, customChord: [], customAppChord: [] }),
  tasks: () => ({ landing: "last", order: ["github"], shown: { github: true }, last: null }),
  appearance: () => ({ mode: "dark", accent: "", desktopPalette: null }),
  understudy: () => null,
  later: {
    hooks: async () => ({ installed: false, bundled: false, gate: false, gateBundled: false, python: "python3", settingsPath: "", engine: "default" }),
    lantern: async () => ({ nudge: false, minutes: 20, watch: false, watchMinutes: 10, cacheTtlMinutes: 5, wakeHours: null }),
    budgets: async () => ({ rows: [], models: 0, pace: { spread: "working", workDays: [], workStart: 9, workEnd: 18, rollover: true, burnWindowHours: 3, alertAt: 90, timeZone: "UTC" }, usageRefresh: false }),
    recipes: async () => [], reviewPrompts: async () => [], savedReplies: async () => [],
    tmux: async () => ({ source: "auto", binAvailable: true, binVersion: "3.4", capability: true, confMode: "append", overrideActive: false, broken: false, restoreEnabled: true, resumeMode: "lazy", prefix: "", terminal: "engine", lastCaptureAt: null, reasons: { bin: "", capability: "", broken: "", override: "" } }),
    privacy: async () => ({ retentionDays: 0, pairedDevices: 0, clickupSet: false, db: "", config: "" }),
    plugins: async () => ({ master: true, plugins: [] }),
    log: async () => ({ rows: [] }),
    about: async () => ({ version: "0.0.0", commit: "", stamp: "", builtAt: "", baseTag: "", distance: 0, dirty: false, dirtyCount: 0, branch: "", behind: 0, ahead: 0, available: false, blocked: "", incoming: [], digest: null, origin: "" }),
  },
};

describe("a pane the server holds answers later, and says so when it cannot", () => {
  it("the sync reply refuses a promise instead of answering with one", () => {
    const k = ctx();
    k.c.sources = fixture;
    expect(controlReply(ui("ui.read", { panel: "settings.lantern" }), k.c)).toEqual({ ok: false, applied: false, error: "that door answers later" });
  });

  it("the later reply waits for the route and carries the snapshot", async () => {
    const k = ctx();
    k.c.sources = fixture;
    const r = await controlReplyLater(ui("ui.read", { panel: "settings.lantern" }), k.c);
    expect(r).toMatchObject({ ok: true, applied: true, value: { state: { minutes: 20 } } });
  });

  it("a route that fails is a sentence, and one that never answers is cut short", async () => {
    const k = ctx();
    k.c.sources = { ...fixture, later: { ...fixture.later, tmux: () => Promise.reject(new Error("503 from /terminal/tmux-status")), log: () => new Promise(() => {}) } };
    expect(await controlReplyLater(ui("ui.read", { panel: "settings.tmux" }), k.c)).toEqual({ ok: false, applied: false, error: "503 from /terminal/tmux-status" });
    const slow = await controlReplyLater(ui("ui.read", { panel: "settings.log" }), k.c, 20);
    expect(slow.ok).toBe(false);
    expect(slow.error).toContain("did not answer");
  });

  it("an open still answers at once through the later path", async () => {
    expect(await controlReplyLater(ui("view.open", { to: "git" }), ctx().c)).toEqual({ ok: true, applied: true });
  });
});

describe("controlReply — what the window answers", () => {
  it("ui.state and every ui.read panel answer a snapshot, and call nothing App owns", async () => {
    const k = ctx();
    k.c.sources = fixture;
    for (const cmd of [ui("ui.state"), ...READ_PANELS.map((panel) => ui("ui.read", { panel }))]) {
      const r = await controlReplyLater(cmd, k.c);
      expect(r.ok, JSON.stringify(cmd)).toBe(true);
      expect(r.applied).toBe(true);
      expect(Object.keys((r.value ?? {}) as object)).toEqual(expect.arrayContaining(["state", "untrusted"]));
    }
    expect(k.calls).toEqual([]);
  });

  it("a read raises nothing: no setting is opened, no view changes, no chat or git intent is latched, the bench stays shut", async () => {
    const k = ctx();
    k.c.sources = fixture;
    let opened = 0;
    onOpenSettings(() => { opened++; });
    for (const panel of READ_PANELS) await controlReplyLater(ui("ui.read", { panel }), k.c);
    await controlReplyLater(ui("ui.state"), k.c);
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
