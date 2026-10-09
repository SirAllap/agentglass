/*
 * A plugin that draws, end to end, against a real server: it is installed
 * and enabled the way a person does it, it draws the panel it declared, a
 * click in the window reaches it and it redraws, it writes notes on a pull
 * request, a note the person resolved stays resolved when the plugin sends
 * it again, and after a restart it comes back on its own.
 *
 * The plugin is a real separate process holding a real token. Nothing here
 * calls plugin-ui.ts directly, so what passes is what a plugin author gets.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { story } from "./story.ts";

let dir: string, src: string, base: string, port: number, proc: ReturnType<typeof Bun.spawn> | null = null;

const MANIFEST = {
  name: "orbit-reviewer",
  publisher: "acme",
  description: "Draws a panel and writes notes on pull requests.",
  // The argument only marks the process, so the test can look for it by name.
  entrypoint: "bun run plugin.js agx-draws-marker",
  scope: "read",
  icon: "icon.svg",
  color: "#8b5cf6",
  contributes: {
    panels: [{ id: "main", title: "Reviews", icon: "review" }],
    prNotes: true,
    prActions: [{ id: "review", label: "Local review" }, { id: "cancel", label: "Stop" }],
    settings: [{ key: "repos", type: "list", label: "Repositories" }],
  },
};

// The plugin itself: draws, writes two notes, then answers clicks by
// redrawing. Anything it was refused is written next to it for the test to read.
const PLUGIN = `
const base = process.env.AGENTGLASS_URL, token = process.env.AGENTGLASS_READ_TOKEN;
const h = { "Content-Type": "application/json", Authorization: "Bearer " + token };
const post = (p, b) => fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(b) });
const draw = (text) => post("/plugin/self/panel", { id: "main", tree: { type: "stack", children: [
  { type: "heading", text },
  { type: "button", label: "Ping", action: { id: "ping", payload: { n: 1 } } },
] } });
const me = await (await fetch(base + "/plugin/self", { headers: h })).json();
await draw("hello from " + me.name);
const refused = await post("/plugin/self/panel", { id: "undeclared", tree: { type: "divider" } });
const script = await post("/plugin/self/panel", { id: "main", tree: { type: "html", html: "<script>" } });
require("fs").writeFileSync("refused.json", JSON.stringify({ undeclared: refused.status, script: script.status }));
const note = (status, title = "Off by one") => ({ id: "n1", repo: "acme/orbit", number: 42, severity: "high", title, path: "src/a.ts", line: 3, ...(status ? { status } : {}) });
await post("/plugin/self/pr/run", { id: "r1", repo: "acme/orbit", number: 42, state: "done", title: "Review", sha: "abc1234" });
await post("/plugin/self/pr/notes", { notes: [note(), { id: "n2", repo: "acme/orbit", number: 42, severity: "idea", title: "Rename" }] });
for (;;) {
  const res = await fetch(base + "/plugin/self/events?wait=5000", { headers: h }).catch(() => null);
  // A revoked token means it was stopped: leave. An unreachable server is
  // retried, the way a real plugin rides out a restart — so the only thing
  // that can stop this process when the server goes down is the server.
  if (res && (res.status === 401 || res.status === 403)) process.exit(0);
  if (!res) { await Bun.sleep(300); continue; }
  const r = await res.json().catch(() => null);
  if (!r?.ok) { await Bun.sleep(500); continue; }
  for (const ev of r.events) {
    if (ev.type === "action" && ev.action.id === "ping") await draw("pinged " + ev.action.payload.n);
    // Re-sent as open, with a new title, so the test can see that it really
    // arrived and that the person's "resolved" still won.
    if (ev.type === "note-status") await post("/plugin/self/pr/notes", { notes: [note("open", "Off by one (seen again)")] });
    // The button in the pull request's own header. The queued run is posted
    // at once, which is what that button reads its state from.
    // A plugin filling in a settings field it declared: the box the person
    // is meant to edit has to arrive with something in it.
    if (ev.type === "settings" && ev.settings.repos?.[0] === "acme/prefill")
      await post("/plugin/self/settings", { values: { repos: ["acme/orbit", "acme/filled-by-the-plugin"] } });
    if (ev.type === "pr-action" && ev.id === "review")
      await post("/plugin/self/pr/run", { id: "r2", repo: ev.repo, number: ev.number, state: "queued", title: "Review · asked for" });
  }
}
`;

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
      // A plugin with no sandbox block runs in the default box now, and this
      // fixture writes and runs outside it; the stub bwrap fails the probe on
      // purpose, so this needs the unboxed consent (R1) to still start it, as
      // it did before boxes were the default.
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

async function stop(): Promise<void> {
  const p = proc;
  proc = null;
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
}

type Json = Record<string, any>;
const get = async (p: string): Promise<Json> => (await fetch(base + p)).json() as Promise<Json>;
const post = async (p: string, b: unknown): Promise<Response> =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 100) { await Bun.sleep(100); v = await read(); }
  return v;
}

const heading = async () => {
  const r = await get("/plugins/panels");
  return (r.panels?.[0]?.tree?.children?.[0]?.text as string | undefined) ?? null;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-plugin-draws-"));
  src = join(dir, "src-plugin");
  mkdirSync(src);
  writeFileSync(join(src, "plugin.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(src, "plugin.js"), PLUGIN);
  writeFileSync(join(src, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  const inst = (await (await post("/plugins/install", { source: src })).json()) as Json;
  if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
  const en = (await (await post("/plugins/enable", { name: MANIFEST.name })).json()) as Json;
  if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));
}, SERVER_BOOT_MS);

afterAll(async () => {
  // Disable first, so the plugin process is stopped by the server that
  // started it rather than orphaned when the server is killed.
  try { await post("/plugins/disable", { name: MANIFEST.name }); } catch { /* server gone */ }
  await stop();
  // And prove it: nothing may still be running the test plugin's script.
  const left = Bun.spawnSync(["pgrep", "-f", "plugin.js agx-draws-marker"]).stdout.toString().trim();
  if (left) { Bun.spawnSync(["kill", ...left.split("\n")]); throw new Error(`plugin processes outlived the server: ${left}`); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const step = story();

describe("a plugin draws in the app", () => {
  step("its declared panel shows what it drew, under its own name", async () => {
    expect(await until(heading, (h) => h !== null)).toBe("hello from orbit-reviewer");
    const p = (await get("/plugins/panels")).panels[0];
    expect(p.plugin).toBe("orbit-reviewer");
    expect(p.title).toBe("Reviews");
    expect(p.running).toBe(true);
  });

  step("a panel it did not declare, and a node the vocabulary does not have, are refused", async () => {
    const file = join(dir, "agentglass", "plugins", MANIFEST.name, "refused.json");
    await until(async () => existsSync(file), (x) => x);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ undeclared: 400, script: 400 });
  });

  step("a click in the window reaches the plugin, and it redraws", async () => {
    const r = await post("/plugins/action", { plugin: MANIFEST.name, panel: "main", action: { id: "ping", payload: { n: 1 } } });
    expect(r.status).toBe(200);
    expect(await until(heading, (h) => h === "pinged 1")).toBe("pinged 1");
  });

  step("without a plugin's own token there is no self to draw as", async () => {
    const r = await fetch(base + "/plugin/self/panel", { method: "POST", body: JSON.stringify({ id: "main", tree: { type: "divider" } }) });
    expect(r.status).toBe(403);
  });
});

describe("its icon", () => {
  step("is served as an image that cannot run anything", async () => {
    const r = await fetch(base + `/plugins/icon?name=${MANIFEST.name}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(await r.text()).toContain("<circle");
  });

  step("a link that leads out of the plugin's folder is not followed", async () => {
    const installed = join(dir, "agentglass", "plugins", MANIFEST.name, "icon.svg");
    const { rmSync: rm, symlinkSync } = await import("node:fs");
    rm(installed);
    symlinkSync("/etc/hostname", installed);
    expect((await fetch(base + `/plugins/icon?name=${MANIFEST.name}`)).status).toBe(404);
  });
});

describe("notes on a pull request", () => {
  step("the run and its notes are there for the PR view, and only for that PR", async () => {
    const r = await until(() => get("/plugins/pr-notes?repo=acme/orbit&number=42"), (x) => (x.notes?.length ?? 0) === 2);
    expect(r.runs.map((x: Json) => x.id)).toEqual(["r1"]);
    expect(r.notes.find((n: Json) => n.id === "n1")).toMatchObject({ plugin: MANIFEST.name, severity: "high", path: "src/a.ts", line: 3, status: "open" });
    expect((await get("/plugins/pr-notes?repo=acme/orbit&number=43")).notes).toEqual([]);
  });

  step("resolved by the person stays resolved when the plugin sends the note again", async () => {
    const r = await post("/plugins/pr-notes/status", { plugin: MANIFEST.name, id: "n1", status: "resolved" });
    expect(r.status).toBe(200);
    // The plugin answers a status change by re-sending n1 as open, retitled.
    const n1 = await until(
      async () => (await get("/plugins/pr-notes?repo=acme/orbit&number=42")).notes.find((n: Json) => n.id === "n1"),
      (n: Json) => n?.title === "Off by one (seen again)");
    expect(n1.title).toBe("Off by one (seen again)");
    expect(n1.status).toBe("resolved");
    expect(n1.statusBy).toBe("person");
  });
});

describe("a button the plugin put in a pull request", () => {
  step("carries which pull request to the plugin, which answers with a queued run", async () => {
    const r = await post("/plugins/pr-action", { plugin: MANIFEST.name, id: "review", repo: "acme/orbit", number: 44 });
    expect(r.status).toBe(200);
    const notes = await until(() => get("/plugins/pr-notes?repo=acme/orbit&number=44"), (x) => (x.runs?.length ?? 0) > 0);
    expect(notes.runs[0]).toMatchObject({ id: "r2", state: "queued", plugin: MANIFEST.name });
  });

  step("an action the plugin never declared is refused, whatever the window sends", async () => {
    const r = await post("/plugins/pr-action", { plugin: MANIFEST.name, id: "delete-everything", repo: "acme/orbit", number: 44 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as Json).error).toContain("no such action");
  });

  step("and so is a pull request reference that is not one", async () => {
    const r = await post("/plugins/pr-action", { plugin: MANIFEST.name, id: "review", repo: "acme", number: 0 });
    expect(r.status).toBe(400);
  });
});

describe("settings the manifest declared", () => {
  step("are typed by the manifest, whatever the form sent", async () => {
    const r = await post("/plugins/settings", { name: MANIFEST.name, values: { repos: "acme/orbit\n\n acme/v2 ", junk: 1 } });
    expect(((await r.json()) as Json).values).toEqual({ repos: ["acme/orbit", "acme/v2"] });
    expect((await get(`/plugins/settings?name=${MANIFEST.name}`)).values).toEqual({ repos: ["acme/orbit", "acme/v2"] });
  });
});

describe("a plugin filling in its own settings", () => {
  step("writes the field it declared, and the window reads it back", async () => {
    await post("/plugins/settings", { name: MANIFEST.name, values: { repos: "acme/prefill" } });
    const v = await until(() => get(`/plugins/settings?name=${MANIFEST.name}`),
      (r: Json) => (r.values?.repos ?? []).includes("acme/filled-by-the-plugin"));
    expect(v.values.repos).toEqual(["acme/orbit", "acme/filled-by-the-plugin"]);
  });

  step("and cannot write into another plugin, whatever it sends", async () => {
    // The name comes from the token, never from the request: there is no
    // field here to name somebody else with.
    const r = await fetch(base + "/plugin/self/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "somebody-else", values: { repos: ["x/y"] } }),
    });
    expect(r.status).toBe(403);
  });
});

describe("a restart", () => {
  step("stops the plugin with the server, brings it back with a fresh token, and its notes are still there", async () => {
    const script = "plugin.js agx-draws-marker";
    const before = Bun.spawnSync(["pgrep", "-f", script]).stdout.toString().trim();
    expect(before).not.toBe("");
    await stop();
    // Gone with the server — not left looping on a dead token.
    let after = "";
    for (let i = 0; i < 30; i++) {
      after = Bun.spawnSync(["pgrep", "-f", script]).stdout.toString().trim();
      if (!after) break;
      await Bun.sleep(100);
    }
    if (after) console.error("survivors:", Bun.spawnSync(["ps", "-o", "pid,ppid,pgid,sid,args", "-p", after.split("\n").join(",")]).stdout.toString());
    expect(after).toBe("");
    await boot();
    expect(await until(heading, (h) => h !== null, 10_000)).toBe("hello from orbit-reviewer");
    const n1 = (await get("/plugins/pr-notes?repo=acme/orbit&number=42")).notes.find((n: Json) => n.id === "n1");
    expect(n1.status).toBe("resolved");
  }, SERVER_BOOT_MS + 12_000);
});
