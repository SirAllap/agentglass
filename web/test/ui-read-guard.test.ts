/*
 * The rules of a read, held against the source, because a read is the one door
 * that hands the app's own state to a process that is not the owner.
 *
 *  - Every registry entry of kind "read" has a handler that answers from the
 *    providers and calls none of the seams an open does; every panel `ui.read`
 *    names has exactly one provider and every provider has a panel. (tsc already
 *    refuses a missing key; this refuses the shapes tsc cannot see.)
 *  - Every provider is wrapped in `finish`, which is where outside text is kept
 *    out of `state` and credential-named fields are blanked. A provider that
 *    names such a field anyway is a defect to be told about, not a loophole to
 *    rely on, so the source is read for the names.
 *  - Providers read stores and pref modules, not components, and nothing here
 *    polls or opens a socket: a read is answered when it is asked.
 *
 * Break each on purpose before trusting it: drop a `finish(`, add `apiKey:` to a
 * provider, import a component, add a `setInterval`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ACTIONS, UI_READ_IDS, READ_PANELS, READ_PANELS_NOW, READ_PANELS_LATE, isReadAction, type UiActionDef } from "../../shared/uiActions.ts";
import { PROVIDERS, LATE_PROVIDERS, isSecretName } from "../src/lib/uiSnapshots.ts";
import { globalStubs } from "./stubGlobal.ts";

// uiActions reaches the settings registry, which reaches pref modules that read
// localStorage when they load: this file starts from a stub, like the registry's own tests.
const stubGlobal = globalStubs();
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
const { UI_HANDLERS } = await import("../src/lib/uiActions.ts");

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments and string literals blanked, so a word in prose is not code. */
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\/\/[^\n"'`]*$/gm, "");

const snapshots = read("web/src/lib/uiSnapshots.ts");
const sources = read("web/src/lib/uiSnapshotSources.ts");
const answer = read("web/src/lib/controlAnswer.ts");
const handlers = read("web/src/lib/uiActions.ts");
const control = read("server/src/control.ts");
const index = read("server/src/index.ts");

describe("the registry's reads", () => {
  it("are level 1, closed, and exactly ui.state, ui.read and the two settings reads", () => {
    expect([...UI_READ_IDS].sort()).toEqual(["settings.get", "settings.list", "ui.read", "ui.state"]);
    for (const id of UI_READ_IDS) expect((UI_ACTIONS[id] as UiActionDef).level, id).toBe(1);
    expect(Object.keys((UI_ACTIONS["ui.read"] as UiActionDef).args)).toEqual(["panel"]);
    expect(Object.keys((UI_ACTIONS["ui.state"] as UiActionDef).args)).toEqual([]);
    expect(isReadAction("ui.read")).toBe(true);
    expect(isReadAction("settings.open")).toBe(false);
  });

  it("each has a handler that answers from the providers and calls no opener", () => {
    for (const id of UI_READ_IDS) {
      expect(typeof (UI_HANDLERS as Record<string, unknown>)[id], id).toBe("function");
      const at = handlers.indexOf(`"${id}": (`);
      expect(at, `${id} has no handler line`).toBeGreaterThan(-1);
      const line = handlers.slice(at, handlers.indexOf("\n", at));
      // The settings reads answer from the settings registry (the same defs the
      // rows call), not from the snapshot providers; neither opens anything.
      expect(line, id).toMatch(id.startsWith("settings.") ? /\bsettings\.(get|list)\(/ : /sourcesOf\(/);
      expect(line, id).not.toMatch(/\bc\.(goView|workspace|peel|panel|setTheme|zoom|setMachine|setProjectOpen|setWindowsOpen)\b|openSettings|openFinderAt|latch\w+|toggleBench|showFile|showBoard|openPeek/);
    }
  });

  it("no open entry's handler returns a store's contents (an open answers applied, not state)", () => {
    for (const [id, d] of Object.entries(UI_ACTIONS as Record<string, UiActionDef>)) {
      if (d.kind === "read") continue;
      const at = handlers.indexOf(`"${id}": (`);
      const line = handlers.slice(at, handlers.indexOf("\n", at));
      expect(line, id).not.toMatch(/PROVIDERS|uiState|sourcesOf/);
    }
  });

  it("the server holds a read open for its answer", () => {
    const route = index.slice(index.indexOf('pathname === "/control" && req.method === "POST"'), index.indexOf('pathname === "/control/result"'));
    expect(route).toMatch(/isReadAction\(cmd\.do\)/);
    expect(route).toMatch(/awaitControl\(/);
  });
});

describe("providers", () => {
  it("are keyed by READ_PANELS, one each, now or later", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...READ_PANELS_NOW].sort());
    expect(Object.keys(LATE_PROVIDERS).sort()).toEqual([...READ_PANELS_LATE].sort());
    expect([...READ_PANELS].sort()).toEqual([...READ_PANELS_NOW, ...READ_PANELS_LATE].sort());
  });

  it("every provider goes through finish, the one place the rules are applied", () => {
    const table = snapshots.slice(snapshots.indexOf("export const PROVIDERS"), snapshots.indexOf("/** `ui.state`"));
    const entries = [...table.matchAll(/^\s+(?:"[a-z.-]+"|[a-z]+): (.*),$/gm)];
    // Two tables, told apart by the shape of their right-hand side: a pane the
    // window holds is `finish(provider(s))`, a pane the server holds is the
    // route's answer handed to `finish`.
    const now = entries.filter((e) => /^\(s\) => finish\(\w+\(s\)\)$/.test(e[1]!));
    const late = entries.filter((e) => /^\(s\) => s\.later\.\w+\(\)\.then\(\(d\) => finish\(\w+\(d\)\)\)$/.test(e[1]!));
    expect(now.length, "a pane the window holds does not go through finish").toBe(READ_PANELS_NOW.length);
    expect(late.length, "a pane the server holds does not go through finish").toBe(READ_PANELS_LATE.length);
    expect(entries.length).toBe(READ_PANELS.length);
    expect(snapshots.slice(snapshots.indexOf("export function uiState"))).toMatch(/return finish\(/);
  });

  it("name no field like a credential (token, key, secret, password, credential)", () => {
    const body = code(snapshots);
    const named = [...body.matchAll(/(?:^|[\s{,(])["']?([A-Za-z_][\w]*)["']?\s*:/gm)].map((m) => m[1]!).filter((n) => isSecretName(n));
    expect(named, "a provider field is named like a credential; finish would blank it, so drop it from the provider").toEqual([]);
  });

  it("the redaction rule itself still names all five", () => {
    for (const n of ["token", "key", "secret", "password", "credential"]) expect(isSecretName(n), n).toBe(true);
  });

  it("read stores and pref modules, never a component, a hook or the DOM", () => {
    for (const [name, src] of [["uiSnapshots", snapshots], ["uiSnapshotSources", sources]] as const) {
      const c = code(src);
      expect(c, name).not.toMatch(/components\//);
      expect(c, name).not.toMatch(/\b(useState|useEffect|useRef|useSyncExternalStore|useMemo|useCallback)\b/);
      expect(c, name).not.toMatch(/\b(document|window)\.|querySelector|getElementById|innerText|textContent/);
    }
    // The pure providers load no store at runtime: every import of one is a type.
    for (const line of code(snapshots).split("\n").filter((l) => /^import /.test(l))) {
      if (/from "\.\/\w+(Store)?\.ts"/.test(line)) expect(line, "uiSnapshots must stay free of runtime store imports").toMatch(/^import type /);
    }
  });
});

describe("the pane readers (paneState.ts)", () => {
  const panes = code(read("web/src/lib/paneState.ts"));

  // Every route a read may call, by the name `api` gives it. Each one is a GET
  // that the pane itself makes on open. A new name here is a new request an
  // agent can cause by asking, which is a decision to make with eyes open.
  const READ_ROUTES = [
    "hooksStatus", "lanternSettings", "seatWake", "budgets", "recipes", "prPrompts", "savedReplies", "tmuxStatus", "privacy",
    "plugins", "actions", "updateStatus", "logDigest",
  ];

  it("calls only read routes", () => {
    const used = [...new Set([...panes.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]!))].sort();
    expect(used).toEqual([...READ_ROUTES].sort());
  });

  it("touches no component but the rail's list of views, no hook, no DOM, no timer, no subscription", () => {
    const imports = [...panes.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]!).filter((p) => p.includes("components/"));
    expect(imports).toEqual(["../components/workspace/views.ts"]);
    expect(panes).not.toMatch(/\b(useState|useEffect|useRef|useSyncExternalStore|useMemo|useCallback)\b/);
    expect(panes).not.toMatch(/\b(document|window)\.|querySelector|getElementById|setInterval|setTimeout|new WebSocket|EventSource|\bfetch\(|\bsubscribe\w*\(/);
  });

  it("never passes a result on whole: no spread of an api answer", () => {
    // `...x` over a result would carry every field the server adds. The shapes
    // choose by name; these are the spreads that copy a local list or getter.
    const allowed = ["VIEW_IDS", "bindings", "p.workDays"];
    for (const m of panes.matchAll(/\.\.\.([\w.]+)/g)) expect(allowed, `spread of ${m[1]}`).toContain(m[1]!);
  });
});

describe("a read is answered when asked", () => {
  it("nothing new polls or opens a socket", () => {
    for (const [name, src] of [["uiSnapshots", snapshots], ["uiSnapshotSources", sources], ["controlAnswer", answer]] as const) {
      expect(code(src), name).not.toMatch(/setInterval|requestAnimationFrame|new WebSocket|EventSource|\bfetch\(|\bsubscribe\w*\(/);
    }
    expect(code(control)).not.toMatch(/setInterval/);
  });

  it("the only timer is the one-shot hidden-window delay and the server's wait", () => {
    expect((code(answer).match(/setTimeout\(/g) ?? []).length).toBe(1);
    expect((code(control).match(/setTimeout\(/g) ?? []).length).toBe(1);
  });
});
