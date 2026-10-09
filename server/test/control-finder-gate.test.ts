/*
 * `open finder` puts a file chosen by the caller in front of the person, so who
 * may send it is the whole question, and it is asked of a running server:
 * the source-text test next door only proves the line is there.
 *
 * Which layer refuses is not this file's business: the outer origin check
 * already turns a foreign page away before trustedCaller is reached (measured:
 * deleting the trustedCaller line leaves these green), and a remote caller with
 * no Origin cannot be made from a loopback test. The line itself is pinned by
 * mutating-routes-guard.test.ts, which does go red without it; this file pins
 * the behaviour a caller sees, whichever layer gives it.
 *
 * Also pinned here, because it needs a running server: with no window attached
 * the command is turned away with a 503 instead of a false ok, with a window it
 * is delivered and answers how many, and each command leaves one audit line
 * that names the door and not the path.
 *
 * A page on another origin must be refused outright (it is the one caller that
 * could otherwise show somebody a file without being asked), a loopback caller
 * with no Origin is the agent this exists for, and a bad path is a 400 that
 * never reaches a window.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-control-finder-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

const sockets: WebSocket[] = [];
/** A dashboard window: a /stream client that records the control frames. */
async function window_(): Promise<{ frames: any[]; ws: WebSocket }> {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  const frames: any[] = [];
  ws.addEventListener("message", (ev) => {
    try { const f = JSON.parse(String((ev as MessageEvent).data)); if (f.type === "control") frames.push(f.data); } catch { /* not json */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  // A control frame goes to windows that said hello, as the app's does on every connect.
  ws.send(JSON.stringify({ type: "hello", clientId: `win-${crypto.randomUUID()}`, browser: true }));
  await Bun.sleep(100);
  return { frames, ws };
}

/* Every test starts with no window attached, so the one that asserts on that
   does not depend on running first. */
afterEach(async () => {
  for (const w of sockets.splice(0)) try { w.close(); } catch { /* gone */ }
  await Bun.sleep(150);
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + "/control", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const finder = (path: string) => ({ cmd: "open", what: "finder", path });

describe("POST /control with no window attached", () => {
  test("is a 503 'no window', not a false ok", async () => {
    const r = await post(finder("/home/ana/notes/plan.md"));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: "no window" });
  });

  test("a malformed command is still a 400, not a 503", async () => {
    expect((await post({ cmd: "ui", do: "nope.nothing" })).status).toBe(400);
  });
});

describe("POST /control open finder", () => {
  test("a caller on this machine with no Origin is accepted, and the window gets the frame", async () => {
    const w = await window_();
    const r = await post(finder("/home/ana/notes/plan.md"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
    await Bun.sleep(150);
    expect(w.frames).toContainEqual({ cmd: "open", what: "finder", path: "/home/ana/notes/plan.md", kind: "file" });
  });

  test("a page on another origin is refused, and the same body from this machine is not", async () => {
    const r = await post(finder("/home/ana/notes/plan.md"), { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  test("a bad path is a 400, not a command", async () => {
    for (const p of ["plan.md", "/home/ana/../bob/plan.md", "/home/ana/a\0b"]) {
      const r = await post(finder(p));
      expect(r.status).toBe(400);
    }
  });
});

describe("POST /control with the ui wire shape", () => {
  test("is delivered as a ui frame, and a deny-by-default id never is", async () => {
    const w = await window_();
    const r = await post({ cmd: "ui", do: "settings.open", args: { page: "appearance", row: "theme" } });
    expect(r.status).toBe(200);
    expect(await post({ cmd: "ui", do: "settings.reset", args: { id: "x", value: 1 } }).then((x) => x.status)).toBe(400);
    await Bun.sleep(150);
    expect(w.frames).toContainEqual({ cmd: "ui", do: "settings.open", args: { page: "appearance", row: "theme" } });
    expect(w.frames.some((f) => f.do === "settings.reset")).toBe(false);
  });

  test("each command leaves one audit line: the door and the verdict, never the path", async () => {
    await window_();
    await post({ cmd: "ui", do: "peek.file", args: { root: "/home/ana/code/orbit", path: "docs/secret-plan.md" } });
    const log = await (await fetch(base + "/actions?limit=50")).json() as { actions: { action: string; ok: boolean; target: string | null; detail: string | null }[] };
    const mine = log.actions.filter((a) => a.action === "/control/peek.file");
    expect(mine.length).toBe(1);
    expect(mine[0]!.ok).toBe(true);
    expect(JSON.stringify(log.actions)).not.toContain("secret-plan");
    expect(JSON.stringify(log.actions)).not.toContain("orbit");
  });
});

describe("POST /control settings.set", () => {
  const setBody = (value: unknown) => ({ cmd: "ui", do: "settings.set", args: { id: "diff.wrap", value } });
  type Line = { action: string; ok: boolean; target: string | null; detail: string | null };
  const lines = async () => ((await (await fetch(base + "/actions?limit=200")).json()) as { actions: Line[] }).actions.filter((a) => a.action === "/control/settings.set");

  /** A window that answers every frame that carries a request id, the way App does. */
  async function answering(reply: (data: any) => Record<string, unknown>) {
    const w = await window_();
    const asked: any[] = [];
    w.ws.addEventListener("message", (ev) => {
      try {
        const f = JSON.parse(String((ev as MessageEvent).data));
        if (f.type !== "control" || !f.rid) return;
        asked.push(f.data);
        void fetch(base + "/control/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid: f.rid, ...reply(f.data) }) });
      } catch { /* not json */ }
    });
    return { w, asked };
  }

  test("is delivered, answered with what the window did, and the audit line names the setting and never the value", async () => {
    const { asked } = await answering(() => ({ ok: true, applied: true, value: { ok: true, id: "terminal.font", prev: "", value: "fira", undo: "u1" } }));
    const r = await post({ cmd: "ui", do: "settings.set", args: { id: "terminal.font", value: "fira-private-face" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, applied: true, value: { undo: "u1" } });
    expect(asked).toContainEqual({ cmd: "ui", do: "settings.set", args: { id: "terminal.font", value: "fira-private-face" } });
    const mine = (await lines()).filter((l) => l.target === "terminal.font");
    expect(mine.length).toBe(1);
    expect(mine[0]!.ok).toBe(true);
    expect(JSON.stringify(await lines())).not.toContain("fira-private-face");
  });

  test("a window that refuses the value makes the audit line a failure, not an ok", async () => {
    await answering(() => ({ ok: false, applied: false, error: "not a valid value for terminal.fontSize" }));
    const r = await post({ cmd: "ui", do: "settings.set", args: { id: "terminal.fontSize", value: 99 } });
    expect(await r.json()).toMatchObject({ ok: false, applied: false });
    const mine = (await lines()).filter((l) => l.target === "terminal.fontSize");
    expect(mine.length).toBe(1);
    expect(mine[0]!.ok).toBe(false);
  });

  test("a value that is not a scalar never reaches a window", async () => {
    const { asked } = await answering(() => ({ ok: true, applied: true }));
    for (const value of [{ a: 1 }, [1], null]) expect((await post(setBody(value))).status).toBe(400);
    await Bun.sleep(100);
    expect(asked).toEqual([]);
  });

  test("past the per-minute limit it is a 429, is not delivered, and is a line too", async () => {
    const { asked } = await answering(() => ({ ok: true, applied: true, value: { ok: true } }));
    let first429 = -1;
    for (let i = 0; i < 40; i++) {
      const r = await post(setBody(i % 2 === 0));
      if (r.status === 429) { first429 = i; break; }
      expect(r.status).toBe(200);
    }
    // The writes this file spent earlier count against the same caller.
    expect(first429).toBeGreaterThan(20);
    expect(first429).toBeLessThan(31);
    expect(asked.filter((f) => f.args?.id === "diff.wrap").length).toBe(first429);
    expect((await lines()).some((l) => !l.ok && l.detail === "rate limited")).toBe(true);
    // Reads and opens are not writes: still answered.
    expect((await post({ cmd: "ui", do: "settings.get", args: { id: "diff.wrap" } })).status).toBe(200);
    expect((await post({ cmd: "ui", do: "settings.open", args: { page: "diff" } })).status).toBe(200);
  });
});
