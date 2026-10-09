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
import { UI_ACTIONS, UI_READ_IDS, READ_PANELS, isReadAction, type UiActionDef } from "../../shared/uiActions.ts";
import { PROVIDERS, isSecretName } from "../src/lib/uiSnapshots.ts";
import { UI_HANDLERS } from "../src/lib/uiActions.ts";

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
  it("are keyed by READ_PANELS, one each", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...READ_PANELS].sort());
  });

  it("every provider goes through finish, the one place the rules are applied", () => {
    const table = snapshots.slice(snapshots.indexOf("export const PROVIDERS"), snapshots.indexOf("/** `ui.state`"));
    const entries = [...table.matchAll(/^\s+(?:"[a-z.]+"|[a-z]+): (.*),$/gm)];
    expect(entries.length).toBe(READ_PANELS.length);
    for (const e of entries) expect(e[1], e[0]).toMatch(/=> finish\(\w+\(s\)\)$/);
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
