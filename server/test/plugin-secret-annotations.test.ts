/*
 * Two generic things a plugin can now ask the app for, end to end against a
 * real server and a real plugin process:
 *
 *   a `secret` settings field — typed into a masked box, kept in the 0600
 *   plugins file, handed back to the plugin that declared it and to nobody
 *   else, in any read;
 *
 *   `inboxAnnotations` — a badge and a number to order by on Inbox rows,
 *   which the app draws and sorts by without ever hiding a row.
 *
 * GitHub is a stub `gh` on PATH, so the inbox route is the real one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, base: string, port: number, proc: ReturnType<typeof Bun.spawn> | null = null;

const KEY = "tk-orbit-1042-not-a-real-key";

const MANIFEST = {
  name: "orbit-scorer",
  publisher: "acme",
  description: "Scores Inbox rows.",
  entrypoint: "bun run plugin.js agx-secret-marker",
  scope: "read",
  contributes: {
    inboxAnnotations: true,
    settings: [
      { key: "apiKey", type: "secret", label: "Key" },
      { key: "mode", type: "select", label: "Mode", options: ["off", "live"], default: "off" },
    ],
  },
};

// Posts three annotations, then writes down what it was told, what it is
// allowed to read of itself, and what the app said to a bad post.
const PLUGIN = `
const fs = require("fs");
const base = process.env.AGENTGLASS_URL, token = process.env.AGENTGLASS_READ_TOKEN;
const h = { "Content-Type": "application/json", Authorization: "Bearer " + token };
const post = (p, b) => fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(b) });
const at = Date.parse("2026-09-01T10:00:00Z");
const ok = await post("/plugin/self/inbox/annotations", { items: [
  { id: "11", updatedAt: at, score: 0.92, badge: { text: "needs you", tone: "warning" }, tip: "asks you to look" },
  { id: "12", updatedAt: at, score: 0.1 },
  { id: "13", updatedAt: at - 1, score: 0.99, badge: { text: "stale" } },
] });
const longBadge = await post("/plugin/self/inbox/annotations", { items: [{ id: "11", updatedAt: at, badge: { text: "x".repeat(40) } }] });
const hugeList = await post("/plugin/self/inbox/annotations", { items: Array.from({ length: 501 }, (_, i) => ({ id: String(i), updatedAt: at })) });
fs.writeFileSync("posted.json", JSON.stringify({ ok: ok.status, longBadge: longBadge.status, hugeList: hugeList.status }));
for (;;) {
  const res = await fetch(base + "/plugin/self/events?wait=5000", { headers: h }).catch(() => null);
  if (res && (res.status === 401 || res.status === 403)) process.exit(0);
  if (!res) { await Bun.sleep(300); continue; }
  const r = await res.json().catch(() => null);
  if (!r?.ok) { await Bun.sleep(500); continue; }
  for (const ev of r.events) {
    if (ev.type !== "settings") continue;
    const self = await (await fetch(base + "/plugin/self", { headers: h })).json();
    fs.writeFileSync("heard.json", JSON.stringify({ event: ev.settings.apiKey, self: self.settings.apiKey }));
  }
}
`;

// One thread per row, in the shape \`gh api -i /notifications\` prints.
const NOTES = [
  { id: "11", title: "Fix the retry path", reason: "review_requested" },
  { id: "12", title: "Bump lodash", reason: "subscribed" },
  { id: "13", title: "Docs typo", reason: "subscribed" },
  { id: "14", title: "Nothing said about this one", reason: "mention" },
].map((n) => ({
  id: n.id, unread: true, reason: n.reason, updated_at: "2026-09-01T10:00:00Z",
  repository: { full_name: "acme/orbit" },
  subject: { title: n.title, type: "PullRequest", url: `https://api.github.com/repos/acme/orbit/pulls/${n.id}` },
}));

async function boot(): Promise<void> {
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
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
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

type Json = Record<string, any>;
const get = async (p: string): Promise<Response> => fetch(base + p);
const post = async (p: string, b: unknown): Promise<Response> =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const pluginDir = () => join(dir, "agentglass", "plugins", MANIFEST.name);
const plugins = () => join(dir, "agentglass", "plugins.json");

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 100) { await Bun.sleep(100); v = await read(); }
  return v;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-secret-annot-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\nprintf 'HTTP/2 200\\r\\netag: "e1"\\r\\n\\r\\n%s' '${JSON.stringify(NOTES)}'\n`);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  const src = join(dir, "src-plugin");
  mkdirSync(src);
  writeFileSync(join(src, "plugin.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(src, "plugin.js"), PLUGIN);
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  const inst = (await (await post("/plugins/install", { source: src })).json()) as Json;
  if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
  const en = (await (await post("/plugins/enable", { name: MANIFEST.name })).json()) as Json;
  if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));
}, SERVER_BOOT_MS);

afterAll(async () => {
  try { await post("/plugins/disable", { name: MANIFEST.name }); } catch { /* server gone */ }
  const p = proc;
  proc = null;
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
  const left = Bun.spawnSync(["pgrep", "-f", "plugin.js agx-secret-marker"]).stdout.toString().trim();
  if (left) { Bun.spawnSync(["kill", ...left.split("\n")]); throw new Error(`plugin processes outlived the server: ${left}`); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("a secret settings field", () => {
  test("before a value is saved it reads as not set", async () => {
    const r = (await (await get("/plugins/settings?name=orbit-scorer")).json()) as Json;
    expect(r.values.apiKey).toBeNull();
    expect(r.set).toEqual([]);
  });

  test("saving one answers with which are set and never the value", async () => {
    const res = await post("/plugins/settings", { name: "orbit-scorer", values: { apiKey: KEY } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text, "the save echoed the key back").not.toContain(KEY);
    expect(JSON.parse(text).set).toEqual(["apiKey"]);
  });

  test("no read of the settings, the plugin list or the panels carries it", async () => {
    for (const path of ["/plugins/settings?name=orbit-scorer", "/plugins", "/plugins/panels"]) {
      const text = await (await get(path)).text();
      expect(text, `${path} leaked the key`).not.toContain(KEY);
    }
    const r = (await (await get("/plugins/settings?name=orbit-scorer")).json()) as Json;
    expect(r.values.apiKey).toBeNull();
    expect(r.set).toEqual(["apiKey"]);
  });

  test("it is kept in the plugins file, which only its owner can read", () => {
    expect(readFileSync(plugins(), "utf8")).toContain(KEY);
    expect(statSync(plugins()).mode & 0o777).toBe(0o600);
  });

  test("the plugin hears it in its settings event and reads it from its own self", async () => {
    const file = join(pluginDir(), "heard.json");
    await until(async () => existsSync(file), (x) => x);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ event: KEY, self: KEY });
  });

  test("saving another field leaves it alone; an empty string clears it", async () => {
    await post("/plugins/settings", { name: "orbit-scorer", values: { mode: "live" } });
    expect(((await (await get("/plugins/settings?name=orbit-scorer")).json()) as Json).set).toEqual(["apiKey"]);
    // The window sends null for a secret it never had the value of: no change.
    await post("/plugins/settings", { name: "orbit-scorer", values: { apiKey: null, mode: "live" } });
    expect(((await (await get("/plugins/settings?name=orbit-scorer")).json()) as Json).set).toEqual(["apiKey"]);
    await post("/plugins/settings", { name: "orbit-scorer", values: { apiKey: "" } });
    expect(((await (await get("/plugins/settings?name=orbit-scorer")).json()) as Json).set).toEqual([]);
  });
});

describe("inbox annotations", () => {
  test("a good post is kept; a long badge and a post of 501 are refused", async () => {
    const file = join(pluginDir(), "posted.json");
    await until(async () => existsSync(file), (x) => x);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: 200, longBadge: 400, hugeList: 400 });
  });

  test("the inbox carries them on the rows they are about, and every row is still there", async () => {
    const r = (await (await get("/prs/inbox?force=1")).json()) as Json;
    expect(r.ok).toBe(true);
    expect(r.items.map((n: Json) => n.id).sort()).toEqual(["11", "12", "13", "14"]);
    const by = (id: string) => r.items.find((n: Json) => n.id === id);
    expect(by("11").annotations).toEqual([{ plugin: "orbit-scorer", score: 0.92, badge: { text: "needs you", tone: "warning" }, tip: "asks you to look" }]);
    expect(by("12").annotations).toEqual([{ plugin: "orbit-scorer", score: 0.1 }]);
    // Made for an older version of the row: a new comment is a new question.
    expect(by("13").annotations, "an annotation for a stale version was shown").toBeUndefined();
    expect(by("14").annotations).toBeUndefined();
  });

  test("only a running plugin can post them: the window and a stranger get no self", async () => {
    const res = await post("/plugin/self/inbox/annotations", { items: [] });
    expect(res.status).toBe(403);
  });
});
