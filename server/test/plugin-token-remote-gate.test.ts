/*
 * The zero-config gate's plugin-token exemption, against a real server.
 *
 * index.ts's zero-config gate ("this server has no token configured and only
 * answers local callers") used to exempt ANY request carrying a valid plugin
 * token, regardless of how it arrived. A plugin token travels as `?token=`
 * too, and behind `tailscale serve` a request carrying one — leaked, or
 * fished out of a log — reached this route from anywhere on the tailnet on
 * the real TCP port, where an anonymous remote caller got 401. The exemption
 * is for plugin-socket.ts's own socket, which is loopback-only and 0600
 * under a 0700 dir; it was never meant to cover the public port.
 *
 * `viaPluginSocket` (plugin-socket.ts) narrows the exemption to the exact
 * request object `socketFetch` built for a call over that socket. This file
 * proves both ends of that: the same plugin token is still exempt over the
 * socket, and no longer exempt over the real port — even when the request is
 * made to look like it came from off-box, through the same trusted-proxy
 * stand-in serve-proxy.test.ts uses for the tailscale-serve case.
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
let proxy: ReturnType<typeof Bun.serve> | null = null;
let via: string;

const MANIFEST = {
  name: "orbit-zero-config-net",
  publisher: "acme",
  description: "Writes its own token to disk so the test can read it, then idles.",
  entrypoint: `echo "$AGENTGLASS_READ_TOKEN" > "$AGENTGLASS_PLUGIN_DATA/token"; sleep 60`,
  scope: "read",
  sandbox: { network: "agentglass", read: [], write: [], programs: [] },
};

/** Same stand-in tailscaled shape as serve-proxy.test.ts: dials the server
 *  from loopback and says it is speaking for an address that is not this
 *  machine. Not imported from there because that file's own `startProxy`
 *  is not exported and this suite needs the server preloaded with the seam
 *  in `fixtures/trust-test-proxy.ts` to trust it, matching that same file's
 *  reasoning for why the seam is safe (reachable only via a CLI flag). */
function startProxy(target: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const h = new Headers(req.headers);
      h.set("x-forwarded-for", "100.101.102.103");
      h.set("x-forwarded-proto", "https");
      h.set("tailscale-headers-info", "https://tailscale.com/s/serve-headers");
      h.set("tailscale-user-login", "owner@example.com");
      h.delete("host");
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(target + u.pathname + u.search, { method: req.method, headers: h, body });
    },
  });
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 100) { await Bun.sleep(100); v = await read(); }
  return v;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-zero-config-net-"));
  src = join(dir, "src-plugin");
  mkdirSync(src);
  writeFileSync(join(src, "plugin.json"), JSON.stringify(MANIFEST));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const preload = new URL("./fixtures/trust-test-proxy.ts", import.meta.url).pathname;
  proc = Bun.spawn(["bun", "run", "--preload", preload, new URL("../src/index.ts", import.meta.url).pathname], {
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
      // No AGENTGLASS_TOKEN: this whole file is about the zero-config gate.
      // A host with no working bwrap (CI's docker replica: no usable
      // userns) refuses to start a `sandbox`-declaring plugin at ALL
      // without this — R1's own consent gate (plugins.ts) — so the
      // entrypoint never runs, the token file this suite waits for never
      // appears, and `beforeAll` times out on an ENOENT that has nothing to
      // do with the zero-config gate this file exists to test. The TCP-401
      // assertions only need the token to exist, not a working box (only
      // the one test still gated by `haveSocket()` needs the box itself),
      // so consenting to run unboxed keeps every other test meaningful
      // instead of skipping the whole file.
      AGENTGLASS_PLUGINS_UNBOXED: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  proxy = startProxy(base);
  via = `http://127.0.0.1:${proxy.port}`;

  // Install and enable directly against the file system + a loopback call
  // that needs no token (zero-config, from here, is exempt on its own).
  const inst = await (await fetch(`${base}/plugins/install`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: src }),
  })).json() as any;
  if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
  const en = await (await fetch(`${base}/plugins/enable`, {
    // The app's window: an agent's enable is a request the person approves (the settings door).
    method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: MANIFEST.name }),
  })).json() as any;
  if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));

  const tokenFile = join(dir, "agentglass", "plugin-data", MANIFEST.name, "token");
  await until(() => existsSync(tokenFile), (x) => x);
  pluginToken = readFileSync(tokenFile, "utf8").trim();
  sockPath = join(dir, "agentglass", "plugin-runtime", "plugin.sock");
  await until(() => existsSync(sockPath), (x) => x, 5000).catch(() => {});
}, SERVER_BOOT_MS);

afterAll(async () => {
  try {
    await fetch(`${base}/plugins/disable`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: MANIFEST.name }),
    });
  } catch { /* server gone */ }
  proxy?.stop(true);
  const p = proc;
  proc = null;
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

function haveSocket(): boolean {
  return !!sockPath && existsSync(sockPath);
}

describe("the zero-config gate's plugin-token exemption is socket-only", () => {
  test("a plugin token through the proxy (looks remote, real TCP port) is 401 — not exempt just for holding a token", async () => {
    const r = await fetch(`${via}/plugin/self`, { headers: { authorization: `Bearer ${pluginToken}` } });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ ok: false });
  });

  test("the same token as ?token= through the proxy is also 401 — a leaked token travels this way too", async () => {
    const r = await fetch(`${via}/plugin/self?token=${encodeURIComponent(pluginToken)}`);
    expect(r.status).toBe(401);
  });

  test("straight from loopback, no token at all still works — the zero-config gate itself is unchanged", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
  });

  test("the plugin's own token still works over the plugin socket it was minted for", async () => {
    if (!haveSocket()) return; // no bwrap on this host: covered by plugin-socket.test.ts's own skip note
    const r = await fetch(`${base}/plugin/self`, { unix: sockPath, headers: { authorization: `Bearer ${pluginToken}` } } as any);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.name).toBe(MANIFEST.name);
  });
});
