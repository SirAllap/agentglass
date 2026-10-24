/*
 * The settings door through a booted server: an agent with the machine token
 * against the person's own window, on the routes the Settings pages use and on
 * the door itself.
 *
 * The server runs with a machine token and no desk key, so "the person" is a
 * request from the app's origin (the stated limit for a hand-started server,
 * SECURITY.md) and "an agent" is the same token with no Origin, or with an
 * agent's name on the request. Every assertion that something was NOT applied
 * reads the setting back from its own GET.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { Policy } from "../../shared/orchestration.ts";
import { NEEDS_APPROVAL } from "../../shared/settingClass.ts";

const TOKEN = "tok-settings-door-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };
/** An agent that adds the app's Origin but names itself, as a policy worker's CLI does. */
const namedAgent = () => ({ ...fromApp(), "X-Agentglass-Agent": "builder-orbit-1" });

const get = async <T,>(path: string): Promise<T> => (await fetch(base + path, { headers: auth })).json() as Promise<T>;
const post = async (path: string, body: unknown, headers: Record<string, string>) => {
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
type Req = { id: string; setting: string; who: string; diff: string[]; expires: number };
const requests = async () => (await get<{ requests: Req[] }>("/settings/requests")).requests;
const policy = async () => (await get<{ policy: Policy }>("/orchestration")).policy;
const launch = () => get<{ mode: string; deny: string[] }>("/launch-permissions");
const decide = (id: string, approve: boolean, headers: Record<string, string>) => post("/settings/requests/decide", { id, approve }, headers);

const rule = (id: string) => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "always" }],
  workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] },
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-settings-door-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("an escalation from an agent", () => {
  test("the orchestration policy becomes a request with the server's diff, and nothing is written", async () => {
    const before = await policy();
    const r = await post("/orchestration", { policy: { ...before, rules: [rule("nights")] }, as: "chair-orbit" }, fromAgent);
    expect(r.status).toBe(202);
    expect((await policy()).rules).toEqual([]);
    const [q] = await requests();
    expect(q!.setting).toBe("orchestration.policy");
    expect(q!.who).toBe('an agent calling itself "chair-orbit"');
    expect(q!.diff[0]).toBe("Orchestration policy");
    expect(q!.diff.some((l) => l.startsWith("rules[0].id: (unset) -> \"nights\""))).toBe(true);
  });

  test("an agent cannot approve it: without an Origin, nor with one and its own name", async () => {
    const [q] = await requests();
    expect((await decide(q!.id, true, fromAgent)).status).toBe(403);
    expect((await decide(q!.id, true, namedAgent())).status).toBe(403);
    expect((await decide(q!.id, false, fromAgent)).status).toBe(403);
    expect((await requests()).map((x) => x.id)).toEqual([q!.id]);
    expect((await policy()).rules).toEqual([]);
  });

  test("the person approves it and exactly that policy is stored", async () => {
    const [q] = await requests();
    const r = await decide(q!.id, true, fromApp());
    expect(r.status).toBe(200);
    expect((await policy()).rules.map((x) => x.id)).toEqual(["nights"]);
    expect(await requests()).toEqual([]);
  });

  test("a looser launch mode waits; declined, the mode stays", async () => {
    const r = await post("/launch-permissions", { mode: "bypassPermissions" }, fromAgent);
    expect(r.status).toBe(202);
    expect((await launch()).mode).toBe("default");
    const [q] = await requests();
    expect(q!.diff).toEqual(["Permission mode agents launch in", 'value: "default" -> "bypassPermissions"']);
    expect((await decide(q!.id, false, fromApp())).status).toBe(200);
    expect((await launch()).mode).toBe("default");
    expect(await requests()).toEqual([]);
  });

  test("a worker naming itself is an agent here too, Origin or not", async () => {
    const r = await post("/launch-permissions", { mode: "auto" }, namedAgent());
    expect(r.status).toBe(202);
    expect((await launch()).mode).toBe("default");
    for (const q of await requests()) await decide(q.id, false, fromApp());
  });
});

describe("a narrowing from an agent applies at once", () => {
  test("a stricter launch mode and a longer deny list", async () => {
    expect((await post("/launch-permissions", { mode: "acceptEdits" }, fromApp())).status).toBe(200);
    const r = await post("/launch-permissions", { mode: "default" }, fromAgent);
    expect(r.status).toBe(200);
    expect((await launch()).mode).toBe("default");
    const deny = (await launch()).deny;
    expect((await post("/settings/door", { id: "launch.deny", value: [...deny, "Bash(curl:*)"] }, fromAgent)).status).toBe(200);
    expect((await launch()).deny).toContain("Bash(curl:*)");
    expect(await requests()).toEqual([]);
  });

  test("a low setting applies at once through the door", async () => {
    const r = await post("/settings/door", { id: "lantern.cacheTtlMinutes", value: 60 }, fromAgent);
    expect(r).toMatchObject({ status: 200, body: { ok: true, applied: true, value: 60 } });
  });

  test("alerts on paired phones: on to begin with, an agent turns it off and on at once, and a string is refused", async () => {
    expect(await get("/settings/door?id=phone.alerts")).toMatchObject({ ok: true, id: "phone.alerts", value: true });
    expect(await post("/settings/door", { id: "phone.alerts", value: false }, fromAgent)).toMatchObject({ status: 200, body: { ok: true, applied: true, value: false } });
    expect(await get("/settings/door?id=phone.alerts")).toMatchObject({ value: false });
    expect((await post("/settings/door", { id: "phone.alerts", value: "no" }, fromAgent)).status).toBe(400);
    expect(await post("/settings/door", { id: "phone.alerts", value: true }, fromApp())).toMatchObject({ status: 200, body: { applied: true, value: true } });
    expect(await get("/settings/door?id=phone.alerts")).toMatchObject({ value: true });
  });
});

describe("the Settings pages' own routes hold an agent to the same classes", () => {
  test("the gate off, a bigger budget, plugins on, a dearer role, a shorter wake: each waits, nothing changes", async () => {
    const before = await requests();
    expect((await post("/hooks/gate", { on: false }, fromAgent)).status).toBe(200); // already off here: unchanged
    // A first ceiling narrows (it applies); raising it waits.
    expect((await post("/budgets/set", { budgets: [{ root: "", model: "", limit: 100, period: "day" }] }, fromAgent)).status).toBe(200);
    expect((await post("/budgets/set", { budgets: [{ root: "", model: "", limit: 500, period: "day" }] }, fromAgent)).status).toBe(202);
    expect((await get<{ budgets: { limit: number }[] }>("/budgets")).budgets.map((x) => x.limit)).toEqual([100]);
    // Off narrows (applies), back on waits: on the plugins' own route as through the door.
    expect((await post("/plugins/master", { enabled: false }, fromAgent)).status).toBe(200);
    expect((await post("/plugins/master", { enabled: true }, fromAgent)).status).toBe(202);
    expect((await post("/plugins/master", { enabled: true }, namedAgent())).status).toBe(202);
    expect((await get<{ master: boolean }>("/plugins")).master).toBe(false);
    // A plugin the server does not have is no setting at all, and nothing is enabled.
    expect((await post("/plugins/enable", { name: "acme-notes" }, fromAgent)).status).toBe(404);
    expect((await post("/plugins/allow-unboxed", { name: "acme-notes", allow: true }, fromAgent)).status).toBe(404);
    expect((await post("/lantern/settings", { watch: false }, fromAgent)).status).toBe(200);
    expect((await post("/lantern/settings", { watch: true }, fromAgent)).status).toBe(202);
    expect((await post("/seat/wake", { hours: 1 }, fromAgent)).status).toBe(202);
    expect((await get<{ hours: number }>("/seat/wake")).hours).toBe(4);
    expect((await post("/jira/writes", { on: true }, fromAgent)).status).toBe(202);
    expect((await post("/clickup/writes", { on: true }, fromAgent)).status).toBe(202);
    expect((await requests()).length).toBe(before.length + 6); // the second master ask replaced the first: same asker
    for (const q of await requests()) await decide(q.id, false, fromApp());
  });

  test("the same routes from the person apply as they always did", async () => {
    expect((await post("/seat/wake", { hours: 6 }, fromApp())).status).toBe(200);
    expect((await get<{ hours: number }>("/seat/wake")).hours).toBe(6);
    // And a longer wake from an agent narrows: it applies.
    expect((await post("/seat/wake", { hours: 8 }, fromAgent)).status).toBe(200);
    expect((await get<{ hours: number }>("/seat/wake")).hours).toBe(8);
  });
});

describe("the person's switch: let my agents change settings without asking", () => {
  test("an agent cannot turn it on, and no request is made for it", async () => {
    const r = await post("/settings/door", { id: "agents.changeWithoutAsking", value: true }, fromAgent);
    expect(r.status).toBe(403);
    expect((await post("/settings/door", { id: "agents.changeWithoutAsking", value: true }, namedAgent())).status).toBe(403);
    expect(await requests()).toEqual([]);
    expect((await get<{ trusted: boolean }>("/settings/door")).trusted).toBe(false);
  });

  test("the person turns it on; an agent's escalation then applies; the agent may turn it off", async () => {
    expect((await post("/settings/door", { id: "agents.changeWithoutAsking", value: true }, fromApp())).status).toBe(200);
    expect((await get<{ trusted: boolean }>("/settings/door")).trusted).toBe(true);
    expect((await post("/settings/door", { id: "launch.mode", value: "auto" }, fromAgent)).status).toBe(200);
    expect((await launch()).mode).toBe("auto");
    expect((await post("/settings/door", { id: "agents.changeWithoutAsking", value: false }, fromAgent)).status).toBe(200);
    expect((await get<{ trusted: boolean }>("/settings/door")).trusted).toBe(false);
    expect((await post("/settings/door", { id: "launch.mode", value: "bypassPermissions" }, fromAgent)).status).toBe(202);
    for (const q of await requests()) await decide(q.id, false, fromApp());
    expect((await launch()).mode).toBe("auto");
  });
});

describe("a window setting of the escalation class, through /control", () => {
  test("the window's NEEDS_APPROVAL becomes a request; approved, the server sends it back granted, exactly", async () => {
    const frames: { data: any; grant?: true; expect?: unknown }[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/stream?token=${TOKEN}`);
    ws.addEventListener("message", async (ev) => {
      let f: any;
      try { f = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
      if (f.type !== "control" || !f.rid) return;
      frames.push({ data: f.data, ...(f.grant ? { grant: f.grant, expect: f.expect } : {}) });
      // The window's own rule (settingsRegistry.ts): an escalation without a grant waits.
      const answer = f.data.do === "settings.get" ? { ok: true, applied: true, value: { ok: true, id: f.data.args.id, value: "acme/orbit" } }
        : f.grant ? { ok: true, applied: true } : { ok: false, applied: false, error: NEEDS_APPROVAL };
      await fetch(base + "/control/result", { method: "POST", headers: fromApp(), body: JSON.stringify({ rid: f.rid, ...answer }) });
    });
    await new Promise((r) => ws.addEventListener("open", r));
    ws.send(JSON.stringify({ type: "hello", clientId: "win-settings-door", browser: true }));
    await Bun.sleep(100);
    try {
      // A body that tries to carry the grant itself: the server builds the frame, so it never arrives.
      const body = { cmd: "ui", do: "settings.set", args: { id: "plugins.sessionReads.repos", value: "acme/orbit,acme/helm" }, as: "chair-orbit", grant: true };
      const r = await post("/control", body, fromAgent);
      expect(r.status).toBe(202);
      // The set the window refused, then the read for the card's "from" side.
      expect(frames).toEqual([
        { data: { cmd: "ui", do: "settings.set", args: { id: "plugins.sessionReads.repos", value: "acme/orbit,acme/helm" } } },
        { data: { cmd: "ui", do: "settings.get", args: { id: "plugins.sessionReads.repos" } } },
      ]);
      const [q] = await requests();
      expect(q).toMatchObject({ setting: "plugins.sessionReads.repos", diff: ["plugins.sessionReads.repos", 'value: "acme/orbit" -> "acme/orbit,acme/helm"'] });
      expect((await decide(q!.id, true, fromAgent)).status).toBe(403);
      expect(frames).toHaveLength(2);
      expect((await decide(q!.id, true, fromApp())).status).toBe(200);
      expect(frames.at(-1)).toEqual({ data: { cmd: "ui", do: "settings.set", args: { id: "plugins.sessionReads.repos", value: "acme/orbit,acme/helm" } }, grant: true, expect: "acme/orbit" });
    } finally {
      ws.close();
    }
  });
});

describe("what the door lists and refuses", () => {
  test("every setting with its class; a secret with no value", async () => {
    const l = (await get<{ settings: { id: string; class: string; value?: unknown }[] }>("/settings/door")).settings;
    const by = (id: string) => l.find((x) => x.id === id);
    expect(by("orchestration.policy")?.class).toBe("escalation");
    expect(by("lantern.cacheTtlMinutes")?.class).toBe("low");
    expect(by("agents.changeWithoutAsking")?.class).toBe("personOnly");
    expect(by("jira.token")).toMatchObject({ class: "secret" });
    expect(by("jira.token")).not.toHaveProperty("value");
  });

  test("the session-read repos sent as a comma string wait for the person, like the array does", async () => {
    const before = (await get<{ repos: string[] }>("/plugins/session-reads")).repos;
    const r = await post("/plugins/session-reads", { repos: "acme/orbit,acme/helm" }, fromAgent);
    expect(r.status).not.toBe(200);
    expect((await get<{ repos: string[] }>("/plugins/session-reads")).repos).toEqual(before);
  });

  test("a secret is refused on read and on write", async () => {
    expect((await post("/settings/door", { id: "jira.token", value: "tok-example" }, fromAgent)).status).toBe(403);
    expect((await fetch(`${base}/settings/door?id=jira.token`, { headers: auth })).status).toBe(404);
  });

  test("the changes are in the action log", async () => {
    const { actions } = await get<{ actions: { action: string; ok: boolean }[] }>("/actions?limit=100");
    expect(actions.some((a) => a.action === "/settings/door" && a.ok)).toBe(true);
    expect(actions.some((a) => a.action === "/settings/requests/decide" && !a.ok)).toBe(true);
  });
});
