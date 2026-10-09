/*
 * What each Settings pane hands the agent's reads, before it becomes an answer.
 *
 * Two promises, tested the same way for every pane the server holds: the shape
 * is chosen by NAME (a field the server adds tomorrow, or a credential that
 * rides along in a result, does not travel), and the pane's own route is the
 * source (no second copy of the data). The local panes are checked against the
 * pref modules the Settings rows call.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
const attrs = new Map<string, string>();
stubGlobal("document", {
  documentElement: {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" },
  },
});
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());

const P = await import("../src/lib/paneState.ts");
const { api } = await import("../src/lib/api.ts");
const clockPref = await import("../src/lib/clockPref.ts");
const taskSources = await import("../src/lib/taskSources.ts");
const taskLanding = await import("../src/lib/taskLanding.ts");
const views = await import("../src/components/workspace/views.ts");
const keybindings = await import("../src/lib/keybindings.ts");

/** Something no shape names: it must not come out the other side. */
const LEAK = "LEAK-9f2c41";
const CRED = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const real: Record<string, unknown> = {};
const patch = (name: string, fn: (...a: never[]) => unknown) => {
  const a = api as unknown as Record<string, unknown>;
  if (!(name in real)) real[name] = a[name];
  a[name] = fn;
};
afterAll(() => { for (const [k, v] of Object.entries(real)) (api as unknown as Record<string, unknown>)[k] = v; });
beforeEach(() => { store.clear(); attrs.clear(); views.resetRail(); });

describe("the panes the window holds read the pref modules the rows call", () => {
  it("prefs follow the clock the row sets", () => {
    clockPref.setClock24(true);
    expect(P.readPrefs().clock24).toBe(true);
    clockPref.setClock24(false);
    expect(P.readPrefs().clock24).toBe(false);
  });

  it("the rail says which drawer holds each view, and whether it was moved", () => {
    expect(P.readRail().customised).toBe(false);
    views.moveView("docker", "hidden", 0);
    const r = P.readRail();
    expect(r.hidden).toContain("docker");
    expect(r.work).not.toContain("docker");
    expect(r.customised).toBe(true);
  });

  it("keys name every view and app chord, and flag only what was changed", () => {
    const k = P.readKeys();
    expect(Object.keys(k.chords).sort()).toEqual([...(["dash", "git", "diff", "pr", "tasks", "docker", "term", "chat", "browser", "files", "lantern", "seat", "plugins"])].sort());
    expect(Object.keys(k.appChords).length).toBeGreaterThanOrEqual(7);
    expect(k.customised).toEqual({ bindings: false, chords: false, appChords: false });
    keybindings.rebindChord("git", "mod+alt+g");
    const after = P.readKeys();
    expect(after.chords.git).toBe("mod+alt+g");
    expect(after.customChord).toEqual(["git"]);
    expect(after.customised.chords).toBe(true);
    keybindings.resetChords();
  });

  it("tasks report the landing, the order and which sources are shown", () => {
    taskLanding.setTaskLanding("github");
    taskSources.setTaskSourceShown("clickup", false);
    const t = P.readTasks();
    expect(t.landing).toBe("github");
    expect(t.shown).toMatchObject({ github: true, clickup: false });
    expect([...t.order].sort()).toEqual(["clickup", "github", "local"]);
  });

  it("appearance carries the mode and the accent and nothing else", () => {
    expect(Object.keys(P.readAppearance()).sort()).toEqual(["accent", "desktopPalette", "mode"]);
  });
});

describe("a pane the server holds is read from its own route, by name", () => {
  const sneak = <T extends object>(o: T): T => ({ ...o, sneaky: LEAK }) as T;

  it("hooks: the status and the engine, no more", async () => {
    patch("hooksStatus", async () => sneak({ installed: true, gate: true, gateBundled: true, bundled: true, settingsPath: "/home/ana/.claude/settings.json", python: "python3" }));
    const r = await P.readHooks();
    expect(Object.keys(r).sort()).toEqual(["bundled", "engine", "gate", "gateBundled", "installed", "python", "settingsPath"]);
    expect(JSON.stringify(r)).not.toContain(LEAK);
  });

  it("lantern: the cadence settings, and the orchestrator's wake floor when the route has one", async () => {
    patch("lanternSettings", async () => sneak({ ok: true, nudge: true, minutes: 20, watch: false, watchMinutes: 10, cacheTtlMinutes: 5, min: 1, max: 99 }));
    patch("seatWake", async () => ({ ok: true, hours: 4 }));
    expect(await P.readLantern()).toEqual({ nudge: true, minutes: 20, watch: false, watchMinutes: 10, cacheTtlMinutes: 5, wakeHours: 4 });
    patch("seatWake", async () => { throw new Error("down"); });
    expect((await P.readLantern()).wakeHours).toBeNull();
  });

  it("budgets: limits and status, with the pace the window holds", async () => {
    patch("budgets", async () => ({ budgets: [], models: ["a", "b"], status: [sneak({ budget: sneak({ root: "/home/ana/code/orbit", model: "", limit: 10, period: "day" }), fromDay: "x", toDay: "y", spent: 2, pct: 0.2, level: "ok" })] }));
    const r = await P.readBudgets();
    expect(r.rows).toEqual([{ root: "/home/ana/code/orbit", model: "", limit: 10, period: "day", spent: 2, pct: 0.2, level: "ok" }]);
    expect(r.models).toBe(2);
    expect(JSON.stringify(r)).not.toContain(LEAK);
  });

  it("recipes: counts of steps and params, never the steps themselves", async () => {
    patch("recipes", async () => ({ ok: true, recipes: [sneak({ id: "r1", name: "deploy", desc: "ship it", steps: [`echo ${CRED}`, "make"], scope: "repo", repo: "/home/ana/code/orbit", params: [{ key: "k" }], tmux: true, confirm: false })] }));
    const r = await P.readRecipes();
    expect(r).toEqual([{ id: "r1", name: "deploy", desc: "ship it", scope: "repo", repo: "/home/ana/code/orbit", steps: 2, params: 1, tmux: true, confirm: false }]);
    expect(JSON.stringify(r)).not.toContain(CRED);
  });

  it("review prompts: the title and the size of the prompt, not its text", async () => {
    patch("prPrompts", async () => ({ ok: true, recipes: [sneak({ id: "p1", title: "Resolve", body: `use ${CRED}`, skill: "/pr-resolve {number}", group: "review", when: "open", builtIn: true, hidden: false })] }));
    const r = await P.readReviewPrompts();
    expect(r).toEqual([{ id: "p1", title: "Resolve", group: "review", when: "open", builtIn: true, hidden: false, hasSkill: true, chars: 4 + CRED.length }]);
  });

  it("saved replies: the title and the length, not the reply", async () => {
    patch("savedReplies", async () => ({ ok: true, replies: [sneak({ id: "s1", title: "Thanks", text: `token ${CRED}` })] }));
    expect(await P.readSavedReplies()).toEqual([{ id: "s1", title: "Thanks", chars: 6 + CRED.length }]);
  });

  it("tmux: the status fields, with the typed conf and the reasons set apart", async () => {
    patch("tmuxStatus", async () => sneak({
      ok: true, bin: sneak({ available: true, source: "auto", path: "/usr/bin/tmux", version: "3.4", reason: "" }), capability: { available: true, reason: "" },
      confMode: "append", override: "set -g mouse on", overrideActive: true, broken: false, brokenReason: "", restoreEnabled: true, resumeMode: "lazy",
      prefix: "C-a", terminal: "engine", source: "auto", lastCaptureAt: 7,
    }));
    const r = await P.readTmux();
    expect(r.reasons.override).toBe("set -g mouse on");
    expect(r.binVersion).toBe("3.4");
    expect(JSON.stringify(r)).not.toContain(LEAK);
    expect(JSON.stringify(r)).not.toContain("/usr/bin/tmux");
  });

  it("privacy: the retention, the paired count and whether ClickUp is set; the credentials path is not read", async () => {
    patch("privacy", async () => ({ db: "/d.db", config: "/c", credentials: "/home/ana/.config/agentglass/token", retentionDays: 30, pairedDevices: 2, clickup: true }));
    const r = await P.readPrivacy();
    expect(r).toEqual({ retentionDays: 30, pairedDevices: 2, clickupSet: true, db: "/d.db", config: "/c" });
    expect(JSON.stringify(r)).not.toContain("token");
  });

  it("plugins: no plugin settings, install directory, hash or source URL", async () => {
    patch("plugins", async () => ({
      master: true,
      plugins: [sneak({
        name: "orbit-notes", publisher: "acme", description: "notes", entrypoint: "x", scope: "read",
        source: { kind: "git", url: `https://user:${CRED}@git.example/orbit-notes.git`, ref: null },
        installDir: "/home/ana/.local/share/agentglass/plugins/orbit-notes", manifestHash: "h2", contentHash: "c1", fingerprint: "f1",
        resolvedCommit: "abc", approvedHash: "h1", approvedFingerprint: "f0", enabled: true, installedAt: 1, hadApproval: true,
        contributes: {}, settings: { apiToken: CRED }, running: true, pid: 4242,
      })],
    }));
    const r = await P.readPlugins();
    expect(r.plugins).toEqual([{ name: "orbit-notes", publisher: "acme", description: "notes", enabled: true, running: true, scope: "read", sourceKind: "git", hadApproval: true, changedSinceApproval: true }]);
    const j = JSON.stringify(r);
    for (const bad of [CRED, "/home/ana", "h1", "c1", "4242", LEAK, "git.example"]) expect(j).not.toContain(bad);
  });

  it("log: the latest rows only", async () => {
    patch("actions", async () => ({ actions: Array.from({ length: 80 }, (_, i) => sneak({ id: i, at: i, actor: "local", action: "/git/discard", target: "x", ok: i % 2 === 0, detail: null })) }));
    const r = await P.readLog();
    expect(r.rows.length).toBe(P.LOG_ROWS);
    expect(JSON.stringify(r)).not.toContain(LEAK);
  });

  it("about: the version, the update state and the log digest's counts", async () => {
    patch("updateStatus", async () => sneak({
      ok: true, available: true,
      info: sneak({ version: "0.21.3", commit: "51068898", builtAt: "t", source: "s", origin: "https://git.example/orbit.git", baseTag: "v0.21.0", distance: 4, stamp: "st", tree: "t", dirty: true, dirtyCount: 2, dirtyFiles: ["secrets.env"] }),
      branch: "v0.22.0", behind: 2, ahead: 0, incoming: Array.from({ length: 30 }, (_, i) => ({ sha: `s${i}`, subject: `c${i}` })), blocked: "dirty tree",
      last: { at: "t", ok: true, tail: `log ${CRED}` },
    }));
    patch("logDigest", async () => ({ since: 0, total: 9, groups: [{}, {}], crashLoops: [], spikes: [{}], quiet: false }));
    const r = await P.readAbout();
    expect(r.incoming.length).toBe(P.ABOUT_INCOMING);
    expect(r.digest).toEqual({ total: 9, quiet: false, groups: 2, crashLoops: 0, spikes: 1 });
    const j = JSON.stringify(r);
    for (const bad of [CRED, "secrets.env", LEAK]) expect(j).not.toContain(bad);
  });

  it("about still answers when the digest route is down", async () => {
    patch("updateStatus", async () => ({ ok: true, available: false, info: { version: "0.21.3", commit: "", builtAt: "", source: "", origin: "", baseTag: "", distance: 0, stamp: "", tree: "", dirty: false, dirtyCount: 0, dirtyFiles: [] }, branch: "", behind: 0, ahead: 0, incoming: [] }));
    patch("logDigest", async () => { throw new Error("down"); });
    expect((await P.readAbout()).digest).toBeNull();
  });
});
