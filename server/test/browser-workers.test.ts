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

import { revokeWorkerTokens, workerTokenOf } from "../src/auth.ts";
import { browserWorkersNow, flowRolesOf, flowRolesVisibleTo, knownFlowRoles, mintBrowserCredential, saveBrowserWorkers, withBrowserLine } from "../src/browseraccess.ts";
import { writeBrowserWorkers, writeStoredFlow } from "../src/config.ts";
import { makeDoor } from "../src/settingsDoor.ts";
import { serverSettingDefs } from "../src/serverSettings.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import {
  browserWorkerAllowed, browserWorkersNarrow, browserOffReason, cleanBrowserWorkers, defaultBrowserWorkers,
  flowRoleKey, SEAT_ROW_LABEL, CARD_TABS_ROW_LABEL, type BrowserWorkers, type FlowRoleRow,
} from "../../shared/browserWorkers.ts";

const narrowed = (set: BrowserWorkers, kind: "engines" | "roles", id: string): BrowserWorkers =>
  ({ ...set, [kind]: set[kind].filter((x) => x !== id) });

beforeEach(() => {
  expect(saveBrowserWorkers(defaultBrowserWorkers()).ok).toBe(true);
  // "orbit-builder" is a fixture name other test files mint real tokens for
  // too, and the token store is one process-wide map: a token left live by
  // another file's test would leak into this file's "gets no credential"
  // check and fail it for a reason that has nothing to do with this file.
  revokeWorkerTokens("orbit-builder");
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

  test("an engine Settings ▸ Browser cannot name does not lift a role that is off", () => {
    /* `gemini` is not a row of the engine list (it cannot run a worker turn),
       and the exemption for such an engine came before the role check: with
       Builder off in Settings, a gemini builder still got a credential and a
       claude one did not. Only a tab with NO role may use that exemption — a
       chair, a named agent, a restored pane. */
    const all = browserWorkersNow();
    expect(saveBrowserWorkers(narrowed(all, "roles", "builder")).ok).toBe(true);
    const env: Record<string, string> = {};
    expect(mintBrowserCredential(env, "orbit-builder", "gemini", "builder")).toBeNull();
    expect(env.AGENTGLASS_TOKEN).toBeUndefined();
    expect(env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(withBrowserLine("Make the change in ORBIT-1042.", "gemini", "builder")).toContain("cannot run a worker turn");
    /* And the tab that has no role is still decided by the engine alone, which
       is what keeps a chair sat on one of those engines holding its own. */
    expect(saveBrowserWorkers(all).ok).toBe(true);
    expect(browserOffReason(browserWorkersNow(), "gemini", "")).toBeNull();
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
    /* On, the task text is the task: the `browser: ok` line is the seat's
       brief, not a sentence in every worker's prompt. */
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

  test("dropping a flow-role key the person turned off is a loosening, not a narrowing", () => {
    const off: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: { "/code/orbit": { reviewer: false } } };
    const dropped: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: {} };
    expect(browserWorkersNarrow(off, dropped)).toBe(false);
  });

  test("dropping a flow-role key that was on is still a narrowing", () => {
    const on: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: { "/code/orbit": { reviewer: true } } };
    const dropped: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: {} };
    expect(browserWorkersNarrow(on, dropped)).toBe(true);
  });

  test("an agent dropping a flow-role key the person turned off ends pending, not applied", async () => {
    const r = rig();
    const off: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: { "/code/orbit": { reviewer: false } } };
    expect(await r.door.change("browser.workers", off, r.person)).toMatchObject({ ok: true, applied: true });

    const dropped: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: {} };
    const a = await r.door.change("browser.workers", dropped, r.agent);
    expect(a.ok && !a.applied).toBe(true);
    expect(r.store.flowRoles).toEqual({ "/code/orbit": { reviewer: false } });
  });
});

/*
 * The three rows added after it was measured that a card tab and the
 * project's own seat were both refused a credential with `engines`/`roles`
 * fully on (livecred2): each now has a row of its own, on by default, and the
 * refusal for each names that row's exact label.
 */
describe("the three rows added for a tab with no built-in role", () => {
  test("a seat gets a credential with its row on (the default), and names the row when off", () => {
    const on = defaultBrowserWorkers();
    expect(browserOffReason(on, "claude", "", { seat: true })).toBeNull();

    const off = { ...on, seat: false };
    const why = browserOffReason(off, "claude", "", { seat: true });
    expect(why).toContain(SEAT_ROW_LABEL);
    expect(why).toContain("Settings ▸ Browser");
  });

  test("a card tab gets a credential with its row on (the default), and names the row when off", () => {
    const on = defaultBrowserWorkers();
    expect(browserOffReason(on, "claude", "", { cardTab: true })).toBeNull();

    const off = { ...on, cardTabs: false };
    const why = browserOffReason(off, "claude", "", { cardTab: true });
    expect(why).toContain(CARD_TABS_ROW_LABEL);
    expect(why).toContain("Settings ▸ Browser");
  });

  test("the engine still gates a seat or a card tab, even with its own row on", () => {
    const narrow = narrowed(defaultBrowserWorkers(), "engines", "claude");
    expect(browserOffReason(narrow, "claude", "", { seat: true })).toContain("Claude Code workers are off");
    expect(browserOffReason(narrow, "claude", "", { cardTab: true })).toContain("Claude Code workers are off");
  });

  test("a flow role falls back to its base built-in role's value with no override, and names itself when off", () => {
    const flowRole = { root: "/home/a/code/orbit", id: "planner", title: "Planner", base: "builder" };
    const baseOn = defaultBrowserWorkers();
    expect(browserOffReason(baseOn, "claude", "planner", { flowRole })).toBeNull();

    const baseOff = narrowed(baseOn, "roles", "builder");
    const why = browserOffReason(baseOff, "claude", "planner", { flowRole });
    expect(why).toContain("Planner");
    expect(why).toContain("Settings ▸ Browser");
  });

  test("a flow role's own override wins over its base role", () => {
    const flowRole = { root: "/home/a/code/orbit", id: "planner", title: "Planner", base: "builder" };
    // The base role (builder) is on, but this project turned the row off.
    const set: BrowserWorkers = { ...defaultBrowserWorkers(), flowRoles: { "/home/a/code/orbit": { planner: false } } };
    expect(browserOffReason(set, "claude", "planner", { flowRole })).toContain("Planner");

    // And the reverse: base off, this project's own row on.
    const set2: BrowserWorkers = { ...narrowed(defaultBrowserWorkers(), "roles", "builder"), flowRoles: { "/home/a/code/orbit": { planner: true } } };
    expect(browserOffReason(set2, "claude", "planner", { flowRole })).toBeNull();
  });

  test("seat.ts's own two-argument call is unchanged: an empty role with no ctx reads as before", () => {
    // The pinned call in seat.ts (`browserHealthLine(kind, "")`) never names a
    // ctx, so it must keep answering exactly as it did before these three rows
    // existed — the seat row must not silently apply to it.
    const off = { ...defaultBrowserWorkers(), seat: false };
    expect(browserOffReason(off, "claude", "")).toBeNull();
  });
});

describe("a flow role, which DOORS_FOR_ROLE no longer decides", () => {
  const general: FlowRoleRow = { id: "general", policyRole: "builder" };
  const planner: FlowRoleRow = { id: "planner", policyRole: "scout" };

  test("a flow role this app has never seen is refused by name, same as before", () => {
    const why = browserOffReason(browserWorkersNow(), "claude", "general");
    expect(why).toContain('the "general" step is not one of the roles Settings ▸ Browser can turn on');
  });

  test("with no row of its own, a flow role is read from its base role's row — and only its own base, not any other role's", () => {
    const all = browserWorkersNow();
    expect(browserWorkerAllowed(all, "claude", "general", [general])).toBe(true); // builder is on
    expect(saveBrowserWorkers(narrowed(all, "roles", "builder")).ok).toBe(true);
    expect(browserWorkerAllowed(browserWorkersNow(), "claude", "general", [general])).toBe(false);
    expect(browserWorkerAllowed(browserWorkersNow(), "claude", "reviewer", [general])).toBe(true); // untouched
  });

  test("turning the flow role itself on gives its turn the door, and no other role's", () => {
    const all = browserWorkersNow();
    expect(saveBrowserWorkers(narrowed(all, "roles", "builder")).ok).toBe(true); // base off
    const withRow = cleanBrowserWorkers({ ...browserWorkersNow(), roles: [...browserWorkersNow().roles, "general"] }, [general]);
    expect("value" in withRow).toBe(true);
    const set = "value" in withRow ? withRow.value : all;
    expect(browserWorkerAllowed(set, "claude", "general", [general])).toBe(true);
    expect(browserWorkerAllowed(set, "claude", "builder", [general])).toBe(false); // base stayed off
  });

  test("a flow role that runs as scout never inherits scout's row", () => {
    const all = browserWorkersNow();
    expect(all.roles).toContain("scout"); // scout defaults on in this setting
    expect(browserWorkerAllowed(all, "claude", "planner", [planner])).toBe(false);
    expect(browserOffReason(all, "claude", "planner", {}, [planner])).toContain("the planner role is off in Settings ▸ Browser");
  });

  test("an unknown name is still refused when a flow role of that id exists elsewhere", () => {
    const bad = cleanBrowserWorkers({ engines: ["claude"], roles: ["general"] }, [planner]); // "general" not among the known flow roles passed in
    expect("error" in bad && bad.error).toContain("unknown role");
  });
});

describe("knownFlowRoles, the real projects a saved flow has", () => {
  const root = "/tmp/agx-browser-workers-project";

  afterAll(() => { writeStoredFlow(root, null); });

  test("a project's custom roster role is seen, a built-in id in it is not", () => {
    expect(writeStoredFlow(root, templateFlow()).ok).toBe(true);
    const ids = knownFlowRoles().map((r) => r.id);
    expect(ids).toContain("general");
    expect(ids).toContain("planner");
    expect(ids).not.toContain("builder"); // a built-in, never a flow row

    const why = browserOffReason(browserWorkersNow(), "claude", "general", {}, knownFlowRoles());
    expect(why).toBeNull(); // builder (general's base) is on by default
  });
});

describe("flow roles are read from the asking worker's own project", () => {
  const a = "/tmp/agx-browser-workers-project-a";
  const b = "/tmp/agx-browser-workers-project-b";
  const flowWith = (policyRole: string) => {
    const f = templateFlow();
    return { ...f, roster: [...f.roster, { ...f.roster[0]!, id: "ops", policyRole }] } as typeof f;
  };

  afterAll(() => { writeStoredFlow(a, null); writeStoredFlow(b, null); });

  test("the same role id with a different base gets each project's own answer", () => {
    expect(writeStoredFlow(a, flowWith("builder")).ok).toBe(true); // builder is on by default
    expect(writeStoredFlow(b, flowWith("scout")).ok).toBe(true); // scout is on too, so turn it off below
    const set = { engines: ["claude"], roles: ["builder"], seat: true, cardTabs: true, flowRoles: {} };
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(a))).toBeNull();
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(b))).toContain("off in Settings ▸ Browser");
    // a worker that names no project borrows nobody's row
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(undefined))).toContain("not one of the roles");
    expect(knownFlowRoles(a).find((r) => r.id === "ops")?.policyRole).toBe("builder");
    expect(knownFlowRoles(b).find((r) => r.id === "ops")?.policyRole).toBe("scout");
  });

  test("ticking project A's ops does not tick project B's ops", () => {
    expect(writeStoredFlow(a, flowWith("builder")).ok).toBe(true);
    expect(writeStoredFlow(b, flowWith("scout")).ok).toBe(true);
    const rowA = flowRoleKey({ id: "ops", root: a });
    const rowB = flowRoleKey({ id: "ops", root: b });
    expect(rowA).not.toBe(rowB);
    const set = { engines: ["claude"], roles: [rowA], seat: true, cardTabs: true, flowRoles: {} }; // no built-in row: only A's ops is ticked
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(a))).toBeNull();
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(b))).toContain("off in Settings ▸ Browser");
    // the bare id names nothing a flow role answers to, and the setting only accepts the keyed row
    expect(browserOffReason({ engines: ["claude"], roles: ["ops"], seat: true, cardTabs: true, flowRoles: {} }, "claude", "ops", {}, flowRolesOf(a))).toContain("off in Settings");
    expect("error" in cleanBrowserWorkers({ engines: ["claude"], roles: ["ops"] }, knownFlowRoles())).toBe(true);
    expect("error" in cleanBrowserWorkers({ engines: ["claude"], roles: [rowA, rowB] }, knownFlowRoles())).toBe(false);
  });
  test("a flow role without a row of its own still falls back to its own base row", () => {
    const set = { engines: ["claude"], roles: ["builder"], seat: true, cardTabs: true, flowRoles: {} };
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(a))).toBeNull(); // A's ops is a builder
    expect(browserOffReason(set, "claude", "ops", {}, flowRolesOf(b))).not.toBeNull(); // B's is a scout
  });
});

describe("what the settings door shows of other projects' flow roles", () => {
  const a = "/tmp/agx-visible-project-a";
  const b = "/tmp/agx-visible-project-b";
  const withRole = (id: string) => {
    const f = templateFlow();
    return { ...f, roster: [...f.roster, { ...f.roster[0]!, id, policyRole: "builder" as const }] } as typeof f;
  };
  afterAll(() => { writeStoredFlow(a, null); writeStoredFlow(b, null); });

  test("the person sees both projects, a seat only its own, a worker none", () => {
    expect(writeStoredFlow(a, withRole("ops-a")).ok).toBe(true);
    expect(writeStoredFlow(b, withRole("ops-b")).ok).toBe(true);
    const person = JSON.stringify(flowRolesVisibleTo(undefined));
    expect(person).toContain(a);
    expect(person).toContain(b);
    const seatB = JSON.stringify(flowRolesVisibleTo({ principal: "seat", seat: { root: b } }));
    expect(seatB).toContain("ops-b");
    expect(seatB).not.toContain("ops-a");
    expect(seatB).not.toContain(a);
    expect(flowRolesVisibleTo({ principal: "seat", seat: {} })).toEqual([]);
    expect(flowRolesVisibleTo({ principal: "worker" })).toEqual([]);
    expect(flowRolesVisibleTo({ principal: "seat-browser" })).toEqual([]);
  });
  test("the door's route answers through that filter, never the union", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
    expect(src).toContain('one === "browser.workers" ? { flowRoles: flowRolesVisibleTo(caller) }');
    expect(src).not.toContain("flowRoles: knownFlowRoles()");
  });
});

describe("a ticket-started bench tab reads its custom flow role from its own project", () => {
  test("terminal.ts hands agentWindowEnv the project root with the role", async () => {
    const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url).pathname).text();
    const at = src.indexOf("const windowCred = d.bench && agentRun.length");
    const call = src.slice(at, src.indexOf("replace: false,", at));
    expect(call).toContain("role: ticket?.role");
    expect(call).toContain("root: projectRootOf(startIn) ?? startIn");
  });
});
