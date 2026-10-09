/*
 * The wall around a plugin's key, end to end: a real server, two real plugin
 * processes, each holding a key of its own and each asking everything it can
 * with its own token.
 *
 *   the window and any other reader get null;
 *   plugin A's token never returns B's key, however it asks;
 *   a plugin that runs outside its box is told, in the list, which keys it
 *   could read.
 *
 * Both run unboxed here (AGENTGLASS_PLUGINS_UNBOXED) so the red line has
 * something to say; the box itself is pinned in plugin-secrets-split.test.ts
 * (a box is never given the config folder).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, base: string, port: number, proc: ReturnType<typeof Bun.spawn> | null = null;

const KEY_A = "sk-orbit-test-0000";
const KEY_B = "sk-orbit-test-1111";
const MARK = "agx-secrets-wall-marker";

const manifestOf = (name: string, other: string) => ({
  name, publisher: "acme", description: "Holds a key.", entrypoint: `bun run plugin.js ${MARK} ${other}`, scope: "read",
  contributes: { settings: [{ key: "apiKey", type: "secret", label: "Key" }] },
});

// Writes down everything its own token could get: its self, the other
// plugin's settings, and the plugin list.
const PLUGIN = `
const fs = require("fs");
const base = process.env.AGENTGLASS_URL, token = process.env.AGENTGLASS_READ_TOKEN;
const h = { Authorization: "Bearer " + token };
const other = process.argv[3];
const self = await (await fetch(base + "/plugin/self", { headers: h })).json();
const o = await fetch(base + "/plugins/settings?name=" + other, { headers: h });
const l = await fetch(base + "/plugins", { headers: h });
fs.writeFileSync("saw.json", JSON.stringify({ self: self.settings.apiKey, otherStatus: o.status, other: await o.text(), list: await l.text() }));
await new Promise(() => {});
`;

type Json = Record<string, any>;
const get = (p: string): Promise<Response> => fetch(base + p);
const post = (p: string, b: unknown): Promise<Response> =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const installed = (name: string) => join(dir, "agentglass", "plugins", name);

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 100) { await Bun.sleep(100); v = await read(); }
  return v;
}
const saw = async (name: string): Promise<Json> => {
  const f = join(installed(name), "saw.json");
  await until(() => existsSync(f), (x) => x);
  return JSON.parse(readFileSync(f, "utf8"));
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-secrets-wall-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      NODE_ENV: "test",
      AGENTGLASS_BWRAP: "/nonexistent/bwrap",
      AGENTGLASS_PLUGINS_UNBOXED: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    if (i > 150) throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
    await Bun.sleep(100);
  }
  // Both are installed and holding a key before either starts, so what each
  // looks at when it starts is real: with the first running before the second
  // existed, "cannot get the other's key" passed with nothing to leak.
  const pair = [["orbit-scorer", "orbit-peer", KEY_A], ["orbit-peer", "orbit-scorer", KEY_B]] as const;
  for (const [name, other, key] of pair) {
    const src = join(dir, `src-${name}`);
    mkdirSync(src);
    writeFileSync(join(src, "plugin.json"), JSON.stringify(manifestOf(name, other)));
    writeFileSync(join(src, "plugin.js"), PLUGIN);
    chmodSync(join(src, "plugin.js"), 0o755);
    const inst = (await (await post("/plugins/install", { source: src })).json()) as Json;
    if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
    await post("/plugins/settings", { name, values: { apiKey: key } });
  }
  for (const [name] of pair) {
    const held = (await (await get(`/plugins/settings?name=${name}`)).json()) as Json;
    if (held.set?.[0] !== "apiKey") throw new Error(`${name} holds no key, so the wall test would have nothing to protect: ` + JSON.stringify(held.set));
  }
  for (const [name] of pair) {
    const en = (await (await post("/plugins/enable", { name })).json()) as Json;
    if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));
  }
}, SERVER_BOOT_MS);

afterAll(async () => {
  for (const name of ["orbit-scorer", "orbit-peer"]) { try { await post("/plugins/disable", { name }); } catch { /* server gone */ } }
  const p = proc;
  proc = null;
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
  const left = Bun.spawnSync(["pgrep", "-f", MARK]).stdout.toString().trim();
  if (left) { Bun.spawnSync(["kill", ...left.split("\n")]); throw new Error(`plugin processes outlived the server: ${left}`); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("the window and every other reader", () => {
  test("get null and a name, on every route that serves settings or plugins", async () => {
    for (const path of ["/plugins/settings?name=orbit-scorer", "/plugins/settings?name=orbit-peer", "/plugins", "/plugins/panels"]) {
      const text = await (await get(path)).text();
      expect(text, `${path} leaked a key`).not.toContain(KEY_A);
      expect(text, `${path} leaked a key`).not.toContain(KEY_B);
    }
    const r = (await (await get("/plugins/settings?name=orbit-scorer")).json()) as Json;
    expect(r.values.apiKey).toBeNull();
    expect(r.set).toEqual(["apiKey"]);
  });
});

describe("a plugin with its own token", () => {
  test("is handed its own key, and only that one", async () => {
    expect((await saw("orbit-scorer")).self).toBe(KEY_A);
    expect((await saw("orbit-peer")).self).toBe(KEY_B);
  });

  test("cannot get the other's key by asking for its settings or for the list", async () => {
    for (const [who, theirs] of [["orbit-scorer", KEY_B], ["orbit-peer", KEY_A]] as const) {
      const s = await saw(who);
      expect(s.otherStatus, `${who} was answered when it asked for the other's settings`).toBe(403);
      expect(JSON.stringify(s), `${who} saw the other's key`).not.toContain(theirs);
    }
  });

  test("is not told in the list whose keys it could read: that is for the window", async () => {
    for (const who of ["orbit-scorer", "orbit-peer"]) {
      const list = JSON.parse((await saw(who)).list) as Json;
      const mine = list.plugins.find((p: Json) => p.name === who);
      expect(mine.boxState.kind, "it was not outside its box when it looked, so the red line had something to say").toBe("unboxed");
      expect(JSON.stringify(list).includes("canReadKeysOf"), `${who} was handed a map of who holds a key`).toBe(false);
    }
  });
});

describe("the red line", () => {
  test("a plugin outside its box is told whose key it could read; the list says it and nothing else does", async () => {
    const r = (await (await get("/plugins")).json()) as Json;
    const by = (n: string) => r.plugins.find((p: Json) => p.name === n);
    expect(by("orbit-scorer").boxState.kind).toBe("unboxed");
    expect(by("orbit-scorer").canReadKeysOf).toEqual(["orbit-peer"]);
    expect(by("orbit-peer").canReadKeysOf).toEqual(["orbit-scorer"]);
  });

  test("a plugin that holds the only key has no neighbour to be told about", async () => {
    await post("/plugins/settings", { name: "orbit-peer", values: { apiKey: "" } });
    try {
      const r = (await (await get("/plugins")).json()) as Json;
      const by = (n: string) => r.plugins.find((p: Json) => p.name === n);
      expect(by("orbit-scorer").canReadKeysOf, "it holds the only key, so it has no other's to read").toBeUndefined();
      expect(by("orbit-peer").canReadKeysOf).toEqual(["orbit-scorer"]);
    } finally { await post("/plugins/settings", { name: "orbit-peer", values: { apiKey: KEY_B } }); }
  });

  test("a key left in the file by a plugin that is not installed is nobody's to be told about", async () => {
    const f = join(dir, "agentglass", "secrets.json");
    const before = readFileSync(f, "utf8");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(before), "orbit-gone": { apiKey: "sk-orbit-test-2222" } }), { mode: 0o600 });
    try {
      const r = (await (await get("/plugins")).json()) as Json;
      expect(r.plugins.find((p: Json) => p.name === "orbit-scorer").canReadKeysOf).toEqual(["orbit-peer"]);
    } finally { writeFileSync(f, before, { mode: 0o600 }); }
  });
});
