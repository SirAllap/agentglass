/*
 * Lanes from the agent's side: the real CLI, a real server, and stand-ins for
 * the two windows that cannot be real without Electron — the app's window that
 * makes a lane's host, and the host itself.
 *
 * What is pinned is the seam: `lane new` reaches the manager and comes back
 * with an id, `--lane` reaches that host and nobody else, the CLI never
 * addresses a lane by the tab it holds in the person's window, and a lane that
 * is gone is refused by name instead of answered by the visible tab.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const sockets: WebSocket[] = [];
/** Who was asked what, by window name. */
const seen: Array<{ to: string; op: string; args: Record<string, any> }> = [];

const origin = { "content-type": "application/json", Origin: "" };
const postJson = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { ...origin, Origin: base }, body: JSON.stringify(body) });

async function windowNamed(name: string, answer: (op: string, args: Record<string, any>) => Record<string, unknown>) {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: name, browser: true }));
  ws.addEventListener("message", async (ev) => {
    let f: any;
    try { f = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (f.type !== "browser") return;
    seen.push({ to: name, op: f.data.op, args: f.data.args ?? {} });
    await postJson("/browser/result", { client: name, id: f.data.id, ...answer(f.data.op, f.data.args ?? {}) });
  });
  return ws;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-lanecli-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  // The person's own window, with a panel mounted, and the app's manager.
  await windowNamed("visible", (op) => op === "observe"
    ? { ok: true, value: { title: "t", url: "http://localhost/", visible: false, tree: [], console: [], network: [] } }
    : op === "open"
    ? { ok: true, value: { tab: "t1-orbit", id: "t1-orbit", url: "http://localhost/", title: "the person's page" } }
    : { ok: true, value: { title: "the person's page", url: "http://localhost/", text: "" } });
  await postJson("/browser/ready", { client: "visible", on: true });
  await windowNamed("mgr", (op, args) => {
    if (op === "lane" && typeof args.make === "string") {
      // A host comes up a beat after the manager answers, as a real one does.
      void windowNamed(`host-${args.make}`, (o) => o === "observe"
        ? { ok: true, value: { title: "t", url: "http://localhost/", visible: false, tree: [], console: [], network: [] } }
        : o === "screencast" ? { ok: true, value: { frames: [] } }
        : { ok: true, value: { title: "the lane's page", url: "http://localhost/", text: "" } }).then(async () => {
        await postJson("/browser/ready", { client: `host-${args.make}`, on: true, lanes: [args.make] });
      });
    }
    return { ok: true, value: "done" };
  });
  await postJson("/browser/ready", { client: "mgr", on: true, manager: true });
  await Bun.sleep(150);
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

async function cli(...args: string[]) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_BROWSER_STATE_DIR: join(dir, "cache"), AGENTGLASS_PROFILE: "orbit-agent" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

describe.skipIf(!HAVE_PY)("agentglass-browser lane", () => {
  let id = "";

  test("`lane new` makes a private lane and prints its id", async () => {
    const r = await cli("lane", "new");
    expect(r.code).toBe(0);
    id = JSON.parse(r.out).lane.id;
    expect(id).toMatch(/^l[0-9a-f]{8}$/);
    expect(seen.find((s) => s.to === "mgr")?.args).toMatchObject({ make: id, container: "private" });
  }, 20_000);

  test("`--shared` and `--as` say which container, and only when asked", async () => {
    const shared = await cli("lane", "new", "--shared");
    const named = await cli("lane", "new", "--as", "orbit-qa");
    expect(shared.code).toBe(0);
    expect(named.code).toBe(0);
    const made = seen.filter((s) => s.to === "mgr" && "make" in s.args).map((s) => [s.args.container, s.args.name]);
    expect(made).toEqual([["private", undefined], ["shared", undefined], ["named", "orbit-qa"]]);
    for (const l of JSON.parse((await cli("lane", "list")).out).lanes) {
      if (l.id !== id) expect((await cli("lane", "close", l.id)).code).toBe(0);
    }
  }, 30_000);

  test("`--lane` reaches the lane's host, without the tab the identity holds in the person's window", async () => {
    // The identity holds a tab in the person's window, so a bare verb would be addressed to it.
    expect((await cli("open", "http://localhost/")).code).toBe(0);
    expect((await cli("read")).code).toBe(0);
    expect(seen.at(-1)).toMatchObject({ to: "visible", args: { page: "t1-orbit" } });
    seen.length = 0;
    const r = await cli("read", "--lane", id);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.to)).toEqual([`host-${id}`]);
    expect(seen[0].args.lane).toBe(id);
    expect(seen[0].args.page).toBeUndefined();
    const plain = await cli("read", "--active");
    expect(plain.code).toBe(0);
    expect(seen.map((s) => s.to)).toEqual([`host-${id}`, "visible"]);
  }, 20_000);

  test("a hidden page in a lane is not raised as an alarm, and on the person's window still is", async () => {
    const inLane = await cli("observe", "--summary", "--lane", id);
    const onScreen = await cli("observe", "--summary", "--active");
    expect(inLane.code).toBe(0);
    expect(inLane.out).not.toContain("NOT VISIBLE");
    expect(onScreen.out).toContain("NOT VISIBLE");
  }, 20_000);

  test("a verb that answers early, the screencast's watch, reaches the lane and is not refused for want of a tab", async () => {
    seen.length = 0;
    const r = await cli("screencast", "watch", "--seconds", "0.3", "--lane", id);
    expect(r.code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((s) => s.to))).toEqual(new Set([`host-${id}`]));
    expect(seen.every((s) => s.args.lane === id)).toBe(true);
    // Not the tab this identity holds in the person's window (an earlier test gave it one).
    expect(seen.every((s) => s.args.page === undefined)).toBe(true);
  }, 20_000);

  test("`lane list` names the lane and who opened it", async () => {
    const lanes = JSON.parse((await cli("lane", "list")).out).lanes;
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ id, container: "private" });
    expect(lanes[0].as).toBeTruthy();
  });

  test("a closed lane is refused by name and the visible window is never asked", async () => {
    expect((await cli("lane", "close", id)).code).toBe(0);
    // The identity holds a tab in the person's window, so a bare verb would be addressed to it.
    expect((await cli("open", "http://localhost/")).code).toBe(0);
    expect((await cli("read")).code).toBe(0);
    expect(seen.at(-1)).toMatchObject({ to: "visible", args: { page: "t1-orbit" } });
    seen.length = 0;
    const r = await cli("read", "--lane", id);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("no lane called");
    expect(seen).toHaveLength(0);
  }, 20_000);

  test("`lane close` without an id, and an id that is not one, are refused before any request", async () => {
    expect((await cli("lane", "close")).code).not.toBe(0);
    expect((await cli("read", "--lane", "../x")).code).not.toBe(0);
  });
});
