/*
 * A plugin that keeps the accounts of a provider, end to end against a real
 * server: it posts its list over its own token, the window reads it, a press of
 * a chip reaches the plugin as an event, and nobody but the person in the
 * desktop window can make that press.
 *
 * The plugin is a real separate process with a `full` scope on purpose: a
 * manifest may ask for the widest scope, and the switch must still be refused
 * to it. The two accounts are invented (acme-a, acme-b); the second carries a
 * reading, which the window must never be given.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { story } from "./story.ts";
import { issueDevice, __resetDevices } from "../src/devices.ts";
import * as Accounts from "../src/accounts.ts";
import { accountsList, forgetAccounts, manageRefusal, personMayPress, setAccounts, switchRefusal } from "../src/accounts.ts";

const INDEX_SRC = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

let dir: string, src: string, base: string, port: number, proc: ReturnType<typeof Bun.spawn> | null = null;
const MACHINE = "machine-test-token";
const DESKTOP = "agentglass://app";
const DESK = "x-agentglass-desk";
const KEY = "k".repeat(48);
let claim: AbortController | null = null;
const savedConfig = process.env.XDG_CONFIG_HOME;

const MANIFEST = {
  name: "acme-keeper",
  publisher: "acme",
  description: "Keeps the list of accounts for one provider.",
  entrypoint: "bun run plugin.js agx-accounts-marker",
  scope: "full",
  contributes: { accounts: ["anthropic"] },
};

const WINDOWS = [{ label: "5h", minutes: 300, usedPercent: 41, resetsAt: null }];
const acct = (id: string, label: string, active: boolean, extra: Record<string, unknown> = {}) =>
  ({ id, label, plan: "max", colour: id === "acme-a" ? "blue" : "violet", active, storage: "keyring", ...extra });

const PLUGIN = `
const base = process.env.AGENTGLASS_URL, token = process.env.AGENTGLASS_READ_TOKEN;
const h = { "Content-Type": "application/json", Authorization: "Bearer " + token };
const post = (p, b, extra = {}) => fetch(base + p, { method: "POST", headers: { ...h, ...extra }, body: JSON.stringify(b) });
const list = (accounts, more = {}) => ({ provider: "anthropic", accounts, ...more });
const a = { id: "acme-a", label: "Acme A", plan: "max", colour: "blue", active: true, storage: "keyring", token: "dropped" };
const b = { id: "acme-b", label: "Acme B", plan: "pro", colour: "violet", active: false, storage: "keyring", reading: { windows: ${JSON.stringify(WINDOWS)} } };
const refused = {
  token: (await post("/plugin/self/accounts", list([{ ...a, label: "sk-" + "a".repeat(20) }, b]))).status,
  undeclared: (await post("/plugin/self/accounts", { ...list([a, b]), provider: "codex" })).status,
  twoActive: (await post("/plugin/self/accounts", list([a, { ...b, active: true }]))).status,
  // Its own token with the desktop's Origin written by hand: the kind is what refuses it.
  switch: (await post("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, { Origin: "${DESKTOP}" })).status,
  manage: (await post("/usage/accounts/manage", { provider: "anthropic" }, { Origin: "${DESKTOP}" })).status,
  // The other doors of the same batch, crossed with the same forgery: the keyring
  // switch and the disk clean are the person's, and the plugin is not.
  keyringOn: (await post("/keyring/toggle", { enabled: true }, { Origin: "${DESKTOP}" })).status,
  keyringOff: (await post("/keyring/toggle", { enabled: false }, { Origin: "${DESKTOP}" })).status,
  rehydrate: (await post("/keyring/rehydrate", {}, { Origin: "${DESKTOP}" })).status,
  diskRun: (await post("/machine/disk-clean/run", { ids: [] }, { Origin: "${DESKTOP}" })).status,
  diskDry: (await post("/machine/disk-clean/run", { ids: [], dryRun: true }, { Origin: "${DESKTOP}" })).status,
};
require("fs").writeFileSync("refused.json", JSON.stringify(refused));
const ok = await post("/plugin/self/accounts", list([a, b]));
require("fs").writeFileSync("posted.json", JSON.stringify({ status: ok.status }));
const mine = await (await fetch(base + "/usage/accounts", { headers: h })).json();
require("fs").writeFileSync("selfread.json", JSON.stringify(mine.providers.map((p) => p.plugin)));
for (;;) {
  const res = await fetch(base + "/plugin/self/events?wait=5000", { headers: h }).catch(() => null);
  if (res && (res.status === 401 || res.status === 403)) process.exit(0);
  if (!res) { await Bun.sleep(300); continue; }
  const r = await res.json().catch(() => null);
  if (!r?.ok) { await Bun.sleep(500); continue; }
  for (const ev of r.events) require("fs").appendFileSync("events.jsonl", JSON.stringify(ev) + "\\n");
}
`;

async function boot(): Promise<void> {
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      // Nothing here may reach the real home or its credentials: a request to
      // /usage/providers would read the token and call the real endpoint.
      HOME: dir,
      CLAUDE_CREDENTIALS: join(dir, "credentials.json"),
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: MACHINE,
      AGENTGLASS_CONTROL_LEVEL: "3",
      NODE_ENV: "test",
      AGENTGLASS_BWRAP: "/nonexistent/bwrap",
      AGENTGLASS_PLUGINS_UNBOXED: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

/** The desktop app adopting the server: it holds the desk, and a press needs its key. Only after the plugin is on, which is a desk-gated step too. */
async function claimDesk(): Promise<void> {
  claim = new AbortController();
  const res = await fetch(base + "/desk/claim", { method: "POST", headers: { authorization: `Bearer ${MACHINE}`, [DESK]: KEY }, signal: claim.signal });
  if (res.status !== 200) throw new Error("the desk claim was refused: " + res.status);
}

async function stop(): Promise<void> {
  const p = proc;
  proc = null;
  try { claim?.abort(); } catch { /* gone */ }
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
}

type Json = Record<string, any>;
const auth = (token: string, origin?: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) });
const get = async (p: string, token = MACHINE): Promise<Response> => fetch(base + p, { headers: auth(token) });
/** `key`: the desktop app's own window carries the desk key; everything else does not. */
const press = (path: string, body: unknown, token: string, origin?: string, key = false): Promise<Response> =>
  fetch(base + path, { method: "POST", headers: { ...auth(token, origin), ...(key ? { [DESK]: KEY } : {}) }, body: JSON.stringify(body) });

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 100) { await Bun.sleep(100); v = await read(); }
  return v;
}
const pluginFile = (name: string) => join(dir, "agentglass", "plugins", MANIFEST.name, name);
const readJson = (name: string): Json | null => (existsSync(pluginFile(name)) ? JSON.parse(readFileSync(pluginFile(name), "utf8")) : null);
const events = (): Json[] => (existsSync(pluginFile("events.jsonl")) ? readFileSync(pluginFile("events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const accounts = async (): Promise<Json> => (await get("/usage/accounts")).json() as Promise<Json>;

let phone: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-plugin-accounts-"));
  src = join(dir, "src-plugin");
  mkdirSync(src);
  writeFileSync(join(src, "plugin.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(src, "plugin.js"), PLUGIN);
  // A paired device with every scope there is: the phone does not switch accounts whatever it may do.
  process.env.XDG_CONFIG_HOME = dir;
  __resetDevices();
  phone = issueDevice("Orbit phone", "full").token;
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  const inst = (await (await fetch(base + "/plugins/install", { method: "POST", headers: auth(MACHINE, base), body: JSON.stringify({ source: src }) })).json()) as Json;
  if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
  const en = (await (await fetch(base + "/plugins/enable", { method: "POST", headers: auth(MACHINE, base), body: JSON.stringify({ name: MANIFEST.name }) })).json()) as Json;
  if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));
  await claimDesk();
}, SERVER_BOOT_MS);

afterAll(async () => {
  try { await fetch(base + "/plugins/disable", { method: "POST", headers: auth(MACHINE, base), body: JSON.stringify({ name: MANIFEST.name }) }); } catch { /* server gone */ }
  await stop();
  const left = Bun.spawnSync(["pgrep", "-f", "plugin.js agx-accounts-marker"]).stdout.toString().trim();
  if (left) { Bun.spawnSync(["kill", ...left.split("\n")]); throw new Error(`plugin processes outlived the server: ${left}`); }
  if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
  __resetDevices();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const step = story();

describe("the plugin's list", () => {
  step("a list with a key in it, an undeclared provider and two active accounts is refused whole", async () => {
    const refused = await until(() => readJson("refused.json"), (r) => r !== null);
    expect(refused).toMatchObject({ token: 400, undeclared: 400, twoActive: 400 });
  });

  step("what it posted is what the window reads: no reading, no stray field, under the plugin's name", async () => {
    expect((await until(() => readJson("posted.json"), (r) => r !== null))).toEqual({ status: 200 });
    const r = await accounts();
    expect(r.providers).toEqual([{
      provider: "anthropic", plugin: "acme-keeper",
      accounts: [acct("acme-a", "Acme A", true), { ...acct("acme-b", "Acme B", false), plan: "pro" }],
    }]);
    expect(JSON.stringify(r)).not.toContain("reading");
  });

  step("the cockpit tool for agents reads the same list, labels and all, and never a reading", async () => {
    if (!Bun.which("python3")) return;
    const MCP = new URL("../../bin/agentglass-cockpit-mcp", import.meta.url).pathname;
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cockpit_accounts", arguments: {} } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = Bun.spawnSync(["python3", MCP], { env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_TOKEN: MACHINE }, stdin: Buffer.from(lines) });
    const answers = r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l) as Json);
    const text = answers[1]!.result.content[0].text as string;
    const got = JSON.parse(text) as Json;
    expect(got.providers[0]).toMatchObject({ provider: "anthropic", plugin: "acme-keeper" });
    expect((got.providers[0].accounts as Json[]).map((a) => [a.id, a.active])).toEqual([["acme-a", true], ["acme-b", false]]);
    expect(text).not.toContain("reading");
  });

  step("a read-only phone may read it, as labels, plans and the active flag, with no id, colour, storage or plugin name", async () => {
    const got = ((await (await get("/usage/accounts", phone)).json()) as Json).providers as Json[];
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!).sort()).toEqual(["accounts", "provider"]);
    expect(got[0]!.accounts.map((a: Json) => Object.keys(a).sort())).toEqual([["active", "label", "plan"], ["active", "label", "plan"]]);
    expect(got[0]!.accounts.map((a: Json) => a.label)).toEqual(["Acme A", "Acme B"]);
  });

  step("a plugin reads its own list and nobody else's", async () => {
    expect(readJson("selfread.json")).toEqual([MANIFEST.name]);
  });
});

describe("a press of a chip", () => {
  step("from the desktop window reaches the plugin as an event, and only that", async () => {
    const r = await press("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, MACHINE, DESKTOP, true);
    expect(r.status).toBe(200);
    const got = await until(events, (e) => e.length >= 1);
    expect(got[0]).toMatchObject({ type: "account.switch", provider: "anthropic", id: "acme-b" });
    // The list is still the plugin's: nothing changed until it posts again.
    expect(((await accounts()).providers[0].accounts as Json[]).find((a) => a.active)?.id).toBe("acme-a");
  });

  step("manage reaches the plugin too", async () => {
    expect((await press("/usage/accounts/manage", { provider: "anthropic" }, MACHINE, DESKTOP, true)).status).toBe(200);
    const got = await until(events, (e) => e.length >= 2);
    expect(got[1]).toMatchObject({ type: "account.manage", provider: "anthropic" });
  });

  step("is refused to a plugin, even with the desktop's Origin and the widest scope", async () => {
    const refused = readJson("refused.json")!;
    expect(refused.switch).toBe(403);
    expect(refused.manage).toBe(403);
  });

  step("the keyring switch and the disk clean are not the plugin's either: on waits for the person, nothing else acts", async () => {
    const refused = readJson("refused.json")!;
    expect(refused.keyringOn).toBe(202);
    // Already off, so the door answers "unchanged"; off from on is refused (keyring.test.ts).
    expect(refused.keyringOff).toBe(200);
    expect(refused.rehydrate).toBe(403);
    expect(refused.diskRun).toBe(403);
    expect(refused.diskDry).toBe(403);
    expect(((await (await get("/keyring")).json()) as Json).enabled).toBe(false);
  });

  step("is refused to a paired device, even a full one with the desktop's Origin", async () => {
    expect((await press("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, phone, DESKTOP)).status).toBe(403);
    expect((await press("/usage/accounts/manage", { provider: "anthropic" }, phone, DESKTOP)).status).toBe(403);
  });

  step("is refused to the desktop's Origin without the desk key: an Origin is a header anybody can write", async () => {
    const before = events().length;
    expect((await press("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, MACHINE, DESKTOP)).status).toBe(403);
    expect((await press("/usage/accounts/manage", { provider: "anthropic" }, MACHINE, DESKTOP)).status).toBe(403);
    await Bun.sleep(300);
    expect(events().length).toBe(before);
  });

  step("is refused without the desktop's Origin: no Origin, or a web page's", async () => {
    expect((await press("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, MACHINE)).status).toBe(403);
    expect((await press("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, MACHINE, base)).status).toBe(403);
  });

  step("an account that is already active, unknown, or of an unknown provider is a 409, and nothing reaches the plugin", async () => {
    const before = events().length;
    for (const body of [{ provider: "anthropic", id: "acme-a" }, { provider: "anthropic", id: "acme-z" }, { provider: "codex", id: "acme-a" }, { provider: "nope", id: "acme-a" }, { provider: "anthropic" }]) {
      expect((await press("/usage/accounts/switch", body, MACHINE, DESKTOP, true)).status, JSON.stringify(body)).toBe(409);
    }
    expect((await press("/usage/accounts/manage", { provider: "codex" }, MACHINE, DESKTOP, true)).status).toBe(409);
    await Bun.sleep(300);
    expect(events().length).toBe(before);
  });

  step("an agent's proposal is checked against the list before any window sees it", async () => {
    const stage = async (args: unknown) => (await press("/control", { cmd: "ui", do: "usage.account.stage", args, as: "tester" }, MACHINE, base)).status;
    expect(await stage({ provider: "anthropic", id: "acme-a" })).toBe(409); // already active
    expect(await stage({ provider: "anthropic", id: "acme-z" })).toBe(409); // not in the list
    expect(await stage({ provider: "codex", id: "acme-b" })).toBe(409); // nobody keeps codex
    // A real account passes the check; with no window open it stops at "no window", which is after it.
    expect(await stage({ provider: "anthropic", id: "acme-b" })).toBe(503);
  });

  step("a stopped plugin leaves no chips behind", async () => {
    await fetch(base + "/plugins/disable", { method: "POST", headers: auth(MACHINE, base), body: JSON.stringify({ name: MANIFEST.name }) });
    expect((await until(accounts, (r) => r.providers.length === 0)).providers).toEqual([]);
  });
});

describe("who may press, as a decision", () => {
  test("the person's window, which holds the desk and carries its key, may", () => {
    expect(personMayPress({ kind: "machine" }, true, true, true)).toBe(true);
    expect(personMayPress(null, true, true, true)).toBe(true);
  });
  test("an Origin alone never does: no key held, no key sent, or no desktop Origin", () => {
    expect(personMayPress(null, true, false, false)).toBe(false);
    expect(personMayPress({ kind: "machine" }, true, false, true)).toBe(false);
    expect(personMayPress(null, true, true, false)).toBe(false);
    expect(personMayPress({ kind: "machine" }, false, true, true)).toBe(false);
  });
  test("a plugin, a device, a seat and an understudy never do, whatever they carry", () => {
    for (const c of [{ kind: "plugin" }, { kind: "device" }, { kind: "machine", principal: "seat" }, { kind: "machine", principal: "understudy" }]) {
      expect(personMayPress(c, true, true, true), JSON.stringify(c)).toBe(false);
    }
  });
});

describe("the store", () => {
  const declared = { accounts: ["anthropic" as const] };

  test("a plugin is shown its own lists only, a device the labels only, the person all of it", () => {
    setAccounts("p", declared, { provider: "anthropic", accounts: [acct("acme-a", "Acme A", true)] });
    expect(accountsList({ plugin: "q" })).toEqual([]);
    expect(accountsList({ plugin: "p" })).toHaveLength(1);
    expect(accountsList("device")).toEqual([{ provider: "anthropic", accounts: [{ label: "Acme A", plan: "max", active: true }] }]);
    expect(accountsList()[0]).toMatchObject({ plugin: "p", accounts: [{ id: "acme-a", colour: "blue", storage: "keyring" }] });
    forgetAccounts("p");
  });
  const list = (managedBy?: string) => ({ provider: "anthropic", ...(managedBy ? { managedBy } : {}), accounts: [acct("acme-a", "Acme A", true), acct("acme-b", "Acme B", false)] });

  /* /usage/providers puts each login's label, plan and reading on a row of its own. A plugin reading it was given
     the logins another plugin listed, which /usage/accounts refuses it. */
  test("the usage rows show a plugin its own logins only, the person and a device every one", () => {
    expect(typeof (Accounts as Record<string, unknown>).accountsFor).toBe("function");
    const { accountsFor } = Accounts as unknown as { accountsFor: (v: unknown) => (p: string) => { accounts: unknown[] } | undefined };
    setAccounts("p", declared, list());
    expect(accountsFor({ plugin: "q" })("anthropic")).toBeUndefined();
    expect(accountsFor({ plugin: "p" })("anthropic")?.accounts).toHaveLength(2);
    expect(accountsFor("person")("anthropic")?.accounts).toHaveLength(2);
    expect(accountsFor("device")("anthropic")?.accounts).toHaveLength(2);
    forgetAccounts("p");
    const route = INDEX_SRC.slice(INDEX_SRC.indexOf('if (pathname === "/usage/providers")'));
    expect(route.slice(0, route.indexOf("\n"))).toContain("accountsFor(");
  });

  test("a second post replaces the whole list for the provider", () => {
    expect(setAccounts("p", declared, list()).ok).toBe(true);
    expect(setAccounts("p", declared, { provider: "anthropic", accounts: [acct("acme-b", "Acme B", true)] }).ok).toBe(true);
    expect(switchRefusal("anthropic", "acme-a")).toBe("unknown account");
    forgetAccounts("p");
    expect(switchRefusal("anthropic", "acme-b")).toContain("no plugin keeps");
  });

  test("a list kept by the plugin the app knows as swapkin cannot be switched or managed from here", () => {
    setAccounts("swapkin", declared, list());
    expect(accountsList("device")[0]?.managedBy).toBe("swapkin");
    expect(switchRefusal("anthropic", "acme-b")).toContain("managed by swapkin");
    expect(manageRefusal("anthropic")).toContain("managed by swapkin");
    forgetAccounts("swapkin");
  });

  test("any other plugin claiming managedBy in its body is not managed: the claim is not read", () => {
    setAccounts("p", declared, list("swapkin"));
    expect(accountsList()[0]?.managedBy).toBeUndefined();
    expect(accountsList("device")[0]).not.toHaveProperty("managedBy");
    expect(switchRefusal("anthropic", "acme-b")).toBeNull();
    forgetAccounts("p");
  });

  describe("deferTo swapkin: the app checks for Swapkin itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-defer-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const body = (over: Record<string, unknown> = {}) => ({ ...list(), deferTo: "swapkin", ...over });
    // A server environment with no Swapkin on PATH and no data dir for it.
    const bare = (extra: Record<string, string> = {}) => ({ PATH: join(dir, "no-bin"), HOME: join(dir, "home"), ...extra });
    const withDataDir = () => {
      const d = mkdtempSync(join(dir, "data-"));
      mkdirSync(join(d, "swapkin"));
      return d;
    };

    test("a plugin not named swapkin that defers while Swapkin is absent is not managed, and its chips press", () => {
      setAccounts("accounts", declared, body(), bare());
      expect(accountsList()[0]?.managedBy).toBeUndefined();
      expect(accountsList("device")[0]).not.toHaveProperty("managedBy");
      expect(switchRefusal("anthropic", "acme-b")).toBeNull();
      expect(manageRefusal("anthropic")).toBeNull();
      forgetAccounts("accounts");
    });

    test("with the SWAPKIN_DIR folder present the same body is managed by swapkin, and a switch is refused", () => {
      const d = withDataDir();
      setAccounts("accounts", declared, body(), bare({ SWAPKIN_DIR: join(d, "swapkin") }));
      expect(accountsList()[0]).toMatchObject({ plugin: "accounts", managedBy: "swapkin" });
      expect(accountsList("device")[0]?.managedBy).toBe("swapkin");
      expect(switchRefusal("anthropic", "acme-b")).toContain("managed by swapkin");
      expect(manageRefusal("anthropic")).toContain("managed by swapkin");
      forgetAccounts("accounts");
    });

    test("the default folder is under XDG_DATA_HOME, then HOME/.local/share", () => {
      const d = withDataDir();
      setAccounts("accounts", declared, body(), bare({ XDG_DATA_HOME: d }));
      expect(accountsList()[0]?.managedBy).toBe("swapkin");
      forgetAccounts("accounts");
      mkdirSync(join(dir, "home", ".local", "share", "swapkin"), { recursive: true });
      setAccounts("accounts", declared, body(), bare());
      expect(accountsList()[0]?.managedBy).toBe("swapkin");
      forgetAccounts("accounts");
      rmSync(join(dir, "home"), { recursive: true, force: true });
    });

    test("a swapkin executable on the server PATH counts too", () => {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "swapkin"), "#!/bin/sh\n", { mode: 0o755 });
      setAccounts("accounts", declared, body(), bare({ PATH: bin }));
      expect(accountsList()[0]?.managedBy).toBe("swapkin");
      forgetAccounts("accounts");
    });

    test("deferring does not lift the credential checks: a token-shaped label still refuses the whole list", () => {
      const d = withDataDir();
      const env = bare({ SWAPKIN_DIR: join(d, "swapkin") });
      const bad = (label: string) => body({ accounts: [{ ...acct("acme-a", "Acme A", true), label }] });
      for (const label of ["sk-" + "a".repeat(24), "me@example.com"]) {
        const r = setAccounts("accounts", declared, bad(label), env);
        expect(r.ok, label).toBe(false);
      }
      expect(accountsList()).toEqual([]);
    });

    test("a plugin named swapkin is managed whether or not it defers", () => {
      setAccounts("swapkin", declared, list(), bare());
      expect(accountsList()[0]?.managedBy).toBe("swapkin");
      forgetAccounts("swapkin");
    });
  });

  test("an undeclared provider is refused and keeps nothing", () => {
    expect(setAccounts("p", { accounts: ["codex"] }, list()).ok).toBe(false);
    expect(setAccounts("p", {}, list()).ok).toBe(false);
    expect(switchRefusal("anthropic", "acme-b")).toContain("no plugin keeps");
  });
});

describe("a server whose desk nobody holds", () => {
  test("refuses a press even from the desktop's Origin, which anybody on this machine can write", async () => {
    claim?.abort();
    const refused = await until(
      async () => (await press("/usage/accounts/switch", { provider: "anthropic", id: "acme-b" }, MACHINE, DESKTOP, true)).status,
      (status) => status === 403,
    );
    expect(refused).toBe(403);
    expect((await press("/usage/accounts/manage", { provider: "anthropic" }, MACHINE, DESKTOP, true)).status).toBe(403);
  });
});
