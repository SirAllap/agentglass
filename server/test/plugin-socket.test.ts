/*
 * Slice 3: the plugin socket's own gate, proven against a real server with a
 * real boxed plugin behind it — not a stand-in fetch handler, so a regression
 * in `handleServerRequest` itself (index.ts) would show up here too.
 *
 * Only runs the parts that need `sandboxProbe().ok`: the plugin declares
 * `network: "agentglass"`, so the socket this file talks to is only ever
 * opened once that plugin actually boxes. A host without a working `bwrap`
 * still runs the plugin (unboxed, per plugin-sandbox.test.ts's own coverage
 * of that path), but then there is no socket to test, and this file says so
 * rather than failing silently.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, src: string, base: string, port: number, sockPath: string, pluginToken: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;
const MACHINE_TOKEN = "fixture-machine-token-not-a-real-secret";

const MANIFEST = {
  name: "orbit-agentglass-net",
  publisher: "acme",
  description: "Writes its own token to disk so the test can read it, then idles.",
  entrypoint: `echo "$AGENTGLASS_READ_TOKEN" > "$AGENTGLASS_PLUGIN_DATA/token"; sleep 60`,
  scope: "read",
  sandbox: { network: "agentglass", read: [], write: [], programs: [] },
};

async function boot(): Promise<void> {
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
      AGENTGLASS_TOKEN: MACHINE_TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 100) { await Bun.sleep(100); v = await read(); }
  return v;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-plugin-socket-"));
  src = join(dir, "src-plugin");
  mkdirSync(src);
  writeFileSync(join(src, "plugin.json"), JSON.stringify(MANIFEST));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  const auth = { Authorization: `Bearer ${MACHINE_TOKEN}` };
  const inst = await (await fetch(`${base}/plugins/install`, {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ source: src }),
  })).json() as any;
  if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
  const en = await (await fetch(`${base}/plugins/enable`, {
    // The app's window: an agent's enable is a request the person approves (the settings door).
    method: "POST", headers: { "content-type": "application/json", ...auth, origin: base }, body: JSON.stringify({ name: MANIFEST.name }),
  })).json() as any;
  if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));

  const probe = await (await fetch(`${base}/plugins`, { headers: auth })).json() as any;
  const rec = probe.plugins?.find((p: any) => p.name === MANIFEST.name);
  if (!rec?.sandboxProbe?.ok) {
    console.warn(`plugin socket tests skipped: this host cannot build a box (${rec?.sandboxProbe?.reason}: ${rec?.sandboxProbe?.detail})`);
    return;
  }

  const tokenFile = join(dir, "agentglass", "plugin-data", MANIFEST.name, "token");
  await until(() => existsSync(tokenFile), (x) => x);
  pluginToken = readFileSync(tokenFile, "utf8").trim();
  sockPath = join(dir, "agentglass", "plugin-runtime", "plugin.sock");
  await until(() => existsSync(sockPath), (x) => x, 5000);
}, SERVER_BOOT_MS);

afterAll(async () => {
  try {
    await fetch(`${base}/plugins/disable`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${MACHINE_TOKEN}` }, body: JSON.stringify({ name: MANIFEST.name }),
    });
  } catch { /* server gone */ }
  const p = proc;
  proc = null;
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

function haveSocket(): boolean {
  return !!sockPath && existsSync(sockPath);
}

describe("the plugin socket's own gate", () => {
  test("a plugin's own token reaches /plugin/self over the socket", async () => {
    if (!haveSocket()) return;
    const r = await fetch(`${base}/plugin/self`, { unix: sockPath, headers: { authorization: `Bearer ${pluginToken}` } } as any);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.name).toBe(MANIFEST.name);
  });

  test("no token at all is 401", async () => {
    if (!haveSocket()) return;
    const r = await fetch(`${base}/plugin/self`, { unix: sockPath } as any);
    expect(r.status).toBe(401);
  });

  test("the machine token is a real credential, but the wrong kind for this socket — refused with 403", async () => {
    if (!haveSocket()) return;
    const r = await fetch(`${base}/plugin/self`, { unix: sockPath, headers: { authorization: `Bearer ${MACHINE_TOKEN}` } } as any);
    expect(r.status).toBe(403);
  });

  test("a tokenless sink that loopback accepts is refused over the socket", async () => {
    if (!haveSocket()) return;
    const r = await fetch(`${base}/ingest`, {
      unix: sockPath, method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    } as any);
    expect(r.status).toBe(401);
  });

  test("X-Forwarded-For: 127.0.0.1 does not make a tokenless request local", async () => {
    if (!haveSocket()) return;
    const r = await fetch(`${base}/ingest`, {
      unix: sockPath, method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" }, body: "{}",
    } as any);
    expect(r.status).toBe(401);
  });

  test("no WebSocket upgrade over the plugin socket", async () => {
    if (!haveSocket()) return;
    const r = await fetch(`${base}/stream`, {
      unix: sockPath, headers: { authorization: `Bearer ${pluginToken}`, upgrade: "websocket", connection: "upgrade" },
    } as any);
    expect(r.status).toBe(400);
  });

  test("a long-poll past 10 s still answers — Bun's default idle timeout does not cut it", async () => {
    if (!haveSocket()) return;
    // /plugin/self/events holds the request open for `wait` ms with no
    // events to return. Bun's own default idle timeout on a listener is
    // 10 s; this asks for 15, past that default on purpose, so a
    // regression that drops the `idleTimeout: 255` option off the
    // `Bun.serve` call in `ensurePluginSocketServer` shows up as a closed
    // connection here rather than as a slow test elsewhere.
    const started = Date.now();
    const r = await fetch(`${base}/plugin/self/events?wait=15000`, {
      unix: sockPath, headers: { authorization: `Bearer ${pluginToken}` },
    } as any);
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(14000);
    const b = await r.json() as any;
    expect(b.ok).toBe(true);
  }, 20000);
});
