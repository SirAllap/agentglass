/*
 * Who may drive the built-in browser: the setting's default, the credential a
 * worker whose engine or role is off does NOT get, and what the settings door
 * does with a widening an agent asks for.
 *
 * The relay's own floor (a worker's container, never the person's) is tested in
 * browserdrive.test.ts; this file is about the two lists the person controls.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedCfg = process.env.XDG_CONFIG_HOME;
const configDir = mkdtempSync(join(tmpdir(), "agx-browser-workers-"));
process.env.XDG_CONFIG_HOME = configDir;

import { workerTokenOf } from "../src/auth.ts";
import { browserWorkersNow, mintBrowserCredential, saveBrowserWorkers, withBrowserLine } from "../src/browseraccess.ts";
import { writeBrowserWorkers } from "../src/config.ts";
import { makeDoor } from "../src/settingsDoor.ts";
import { serverSettingDefs } from "../src/serverSettings.ts";
import { browserWorkerAllowed, browserWorkersNarrow, cleanBrowserWorkers, defaultBrowserWorkers, type BrowserWorkers } from "../../shared/browserWorkers.ts";

const narrowed = (set: BrowserWorkers, kind: "engines" | "roles", id: string): BrowserWorkers =>
  ({ ...set, [kind]: set[kind].filter((x) => x !== id) });

beforeEach(() => {
  expect(saveBrowserWorkers(defaultBrowserWorkers()).ok).toBe(true);
});

afterAll(() => {
  if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedCfg;
  rmSync(configDir, { recursive: true, force: true });
});

describe("the default, and what a value may name", () => {
  test("every engine and every role is on with nothing stored", () => {
    const all = browserWorkersNow();
    expect(all.engines).toContain("claude");
    expect(all.engines).toContain("opencode");
    expect(all.roles).toEqual(["scout", "builder", "reviewer", "verifier"]);
  });

  test("an engine or role this app does not know is refused, not stored and ignored", () => {
    const bad = cleanBrowserWorkers({ engines: ["claude", "orbit-cli"], roles: ["builder"] });
    expect("error" in bad && bad.error).toContain("unknown engine");
    const badRole = cleanBrowserWorkers({ engines: ["claude"], roles: ["builder", "artist"] });
    expect("error" in badRole && badRole.error).toContain("unknown role");
  });

  test("a stored value naming an engine this app does not know keeps the known ones, never widens", () => {
    // What a hand-edited file, a newer build or a typo leaves behind. The
    // stored narrowing must survive: only claude and builder are on.
    expect(writeBrowserWorkers({ engines: ["claude", "orbit-cli"], roles: ["builder"] }).ok).toBe(true);
    const now = browserWorkersNow();
    expect(now.engines).toEqual(["claude"]);
    expect(now.roles).toEqual(["builder"]);
    expect(browserWorkerAllowed(now, "claude", "builder")).toBe(true);
    expect(browserWorkerAllowed(now, "codex", "builder")).toBe(false);
    expect(browserWorkerAllowed(now, "claude", "scout")).toBe(false);
  });

  test("a stored list with nothing this app knows reads as nothing on, not as everything", () => {
    expect(writeBrowserWorkers({ engines: ["claude"], roles: ["artist"] }).ok).toBe(true);
    const now = browserWorkersNow();
    expect(now.roles).toEqual([]);
    const env: Record<string, string> = {};
    expect(mintBrowserCredential(env, "orbit-builder", "claude", "builder")).toBeNull();
    expect(env.AGENTGLASS_TOKEN).toBeUndefined();
    expect(env.AGENTGLASS_BROWSER_OFF).toBe("1");
  });

  test("the same set in another order is the same value", () => {
    const a = cleanBrowserWorkers({ engines: ["opencode", "claude"], roles: ["reviewer", "builder"] });
    const b = cleanBrowserWorkers({ engines: ["claude", "opencode"], roles: ["builder", "reviewer"] });
    expect(a).toEqual(b);
  });
});

describe("an engine or role that is off", () => {
  test("gets no credential, and its brief says so", () => {
    const all = browserWorkersNow();
    expect(saveBrowserWorkers(narrowed(all, "engines", "opencode")).ok).toBe(true);

    const env: Record<string, string> = {};
    expect(mintBrowserCredential(env, "orbit-builder", "opencode", "builder")).toBeNull();
    expect(env.AGENTGLASS_TOKEN).toBeUndefined();
    expect(env.AGENTGLASS_WORKER_TOKEN).toBeUndefined();
    expect(env.AGENTGLASS_PROFILE).toBeUndefined();
    expect(env.AGENTGLASS_BROWSER_AS).toBeUndefined();
    expect(env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(workerTokenOf("orbit-builder")).toBeUndefined();

    const brief = withBrowserLine("Make the change in ORBIT-1042.", "opencode", "builder");
    expect(brief).toContain("OpenCode workers are off in Settings ▸ Browser");
    expect(brief).toContain("no credential for the built-in browser");
    expect(brief).toContain("Make the change in ORBIT-1042.");
  });

  test("gets no credential when the ROLE is the one turned off", () => {
    const all = browserWorkersNow();
    expect(saveBrowserWorkers(narrowed(all, "roles", "reviewer")).ok).toBe(true);

    const env: Record<string, string> = {};
    expect(mintBrowserCredential(env, "orbit-reviewer", "claude", "reviewer")).toBeNull();
    expect(workerTokenOf("orbit-reviewer")).toBeUndefined();
    expect(withBrowserLine("Read the change in ORBIT-1042.", "claude", "reviewer")).toContain("the Reviewer role is off");
  });

  test("an engine and role that are on still get one, in the worker's own name", () => {
    const env: Record<string, string> = {};
    const t = mintBrowserCredential(env, "orbit-builder", "claude", "builder");
    expect(t).toMatch(/^wk_/);
    expect(env.AGENTGLASS_TOKEN).toBe(t!);
    expect(env.AGENTGLASS_WORKER_TOKEN).toBe(t!);
    expect(env.AGENTGLASS_PROFILE).toBe("orbit-builder");
    expect(env.AGENTGLASS_BROWSER_AS).toBe("orbit-builder");
    expect(env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
    expect(workerTokenOf("orbit-builder")).toBe(t!);
    expect(withBrowserLine("Make the change in ORBIT-1042.", "claude", "builder")).toBe("Make the change in ORBIT-1042.");
  });
});

describe("the def the door holds for it", () => {
  const def = () => serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === "browser.workers")!;

  test("reads every engine and role, and refuses a name it does not know", () => {
    expect(def().read()).toEqual(defaultBrowserWorkers());
    expect("error" in def().validate({ engines: ["nope"], roles: ["builder"] })).toBe(true);
  });

  test("stores a narrowed value, which the launch path reads back", async () => {
    const r = await def().apply(narrowed(defaultBrowserWorkers(), "engines", "codex"));
    expect(r).toEqual({ ok: true });
    expect(browserWorkersNow().engines).not.toContain("codex");
  });
});

describe("the settings door", () => {  function rig() {
    let store = defaultBrowserWorkers();
    let trusted = false;
    const def = {
      id: "browser.workers", label: "Who may drive the built-in browser (engines and worker roles)", page: "browser",
      type: "json" as const,
      read: () => store,
      validate: (raw: unknown) => cleanBrowserWorkers(raw),
      apply: (v: unknown) => { const c = cleanBrowserWorkers(v); if ("error" in c) return { ok: false as const, error: c.error }; store = c.value; return { ok: true as const }; },
    };
    const door = makeDoor({
      defs: () => [def], trusted: () => trusted,
      applyWindow: async () => ({ ok: true }), changed: () => {}, later: () => {},
    });
    return {
      door, def,
      get store() { return store; },
      trust: (on: boolean) => { trusted = on; },
      agent: { person: false, who: "worker builder-1" },
      person: { person: true, who: "the person" },
    };
  }

  test("an agent reads the value it may narrow", () => {
    const r = rig();
    const v = r.door.value("browser.workers");
    expect("value" in v && (v.value as BrowserWorkers).engines).toContain("claude");
  });

  test("turning an engine or a role off applies at once", async () => {
    const r = rig();
    const a = await r.door.change("browser.workers", narrowed(r.store, "engines", "opencode"), r.agent);
    expect(a).toMatchObject({ ok: true, applied: true });
    expect(r.store.engines).not.toContain("opencode");

    const b = await r.door.change("browser.workers", narrowed(r.store, "roles", "reviewer"), r.agent);
    expect(b).toMatchObject({ ok: true, applied: true });
    expect(r.store.roles).not.toContain("reviewer");
    expect(r.door.pending()).toEqual([]);
  });

  test("a looser value from an agent waits, even when agents change settings without asking", async () => {
    const r = rig();
    const narrow = narrowed(defaultBrowserWorkers(), "engines", "opencode");
    expect(await r.door.change("browser.workers", narrow, r.agent)).toMatchObject({ ok: true, applied: true });
    r.trust(true);

    const wider = defaultBrowserWorkers();
    const a = await r.door.change("browser.workers", wider, r.agent);
    expect(a.ok && !a.applied).toBe(true);
    expect(r.store.engines).not.toContain("opencode");
    expect(r.door.pending()).toHaveLength(1);
    expect(r.door.pending()[0]!.diff.join("\n")).toContain("opencode");
  });

  test("the person's own widening applies at once", async () => {
    const r = rig();
    expect(await r.door.change("browser.workers", narrowed(defaultBrowserWorkers(), "roles", "scout"), r.person)).toMatchObject({ ok: true, applied: true });
    expect(await r.door.change("browser.workers", defaultBrowserWorkers(), r.person)).toMatchObject({ ok: true, applied: true });
    expect(r.store.roles).toContain("scout");
  });

  test("the table calls losing a member a narrowing, and adding one not", () => {
    const all = defaultBrowserWorkers();
    expect(browserWorkersNarrow(all, narrowed(all, "roles", "verifier"))).toBe(true);
    expect(browserWorkersNarrow(narrowed(all, "engines", "codex"), all)).toBe(false);
  });
});
