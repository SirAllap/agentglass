/*
 * How an open reaches the screen, on the wire: the `present` mode of a
 * /control body and what the window is told.
 *
 * Pinned: a caller that names itself (`as`) is quiet by default and one that
 * does not is now; `present` in the body wins either way; a word that is
 * neither is a 400 before any window is asked; the frame carries the mode and
 * the name so the window can decide (web/test/quiet-present.test.ts is that
 * decision); a quiet open is always answered, because the window may hold it,
 * and a held one comes back `queued` without being a failure; and the audit
 * line names the mode and whether it was held, and still never the arguments.
 * presentOf is the one function behind the default, tested alone first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";
import { presentOf } from "../../shared/uiActions.ts";
import { parseReply } from "../src/control.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-ui-quiet-"));
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
interface Win { frames: { data: any; rid?: string; present?: string; as?: string }[]; ws: WebSocket }
async function window_(): Promise<Win> {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  const frames: Win["frames"] = [];
  ws.addEventListener("message", (ev) => {
    try { const f = JSON.parse(String((ev as MessageEvent).data)); if (f.type === "control") frames.push({ data: f.data, rid: f.rid, present: f.present, as: f.as }); } catch { /* not json */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  await Bun.sleep(100);
  return { frames, ws };
}

afterEach(async () => {
  for (const w of sockets.splice(0)) try { w.close(); } catch { /* gone */ }
  await Bun.sleep(150);
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});


const post = (body: unknown) =>
  fetch(base + "/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const result = (body: unknown) =>
  fetch(base + "/control/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function ridOf(w: Win): Promise<string> {
  for (let i = 0; i < 50; i++) { const f = w.frames.find((x) => x.rid); if (f) return f.rid!; await Bun.sleep(40); }
  throw new Error("no frame with a request id arrived");
}
const open = { cmd: "ui", do: "settings.open", args: { page: "notifications" } };

describe("presentOf", () => {
  test("no word: quiet for a caller that named itself, now for one that did not", () => {
    expect(presentOf(undefined, "claude-1")).toBe("quiet");
    expect(presentOf(null, "claude-1")).toBe("quiet");
    expect(presentOf(undefined, null)).toBe("now");
  });
  test("the word wins either way", () => {
    expect(presentOf("now", "claude-1")).toBe("now");
    expect(presentOf("quiet", null)).toBe("quiet");
  });
  test("anything else is refused, not guessed", () => {
    for (const bad of ["", "Quiet", "later", 1, true, {}, []]) expect(presentOf(bad, "claude-1")).toBeNull();
  });
});

describe("the frame a window gets", () => {
  test("a caller with a name gets quiet and its name", async () => {
    const w = await window_();
    const asked = post({ ...open, as: "claude-1" });
    const rid = await ridOf(w);
    expect(w.frames[0]).toMatchObject({ present: "quiet", as: "claude-1" });
    await result({ rid, ok: true, applied: true });
    await asked;
  });
  test("a caller with no name gets now, and no id means no wait", async () => {
    const w = await window_();
    const r = await post(open);
    expect(await r.json()).toMatchObject({ ok: true, windows: 1 });
    await Bun.sleep(100);
    expect(w.frames[0]).toMatchObject({ present: "now" });
    expect(w.frames[0]!.rid).toBeUndefined();
    expect(w.frames[0]!.as).toBeUndefined();
  });
  test("--now: a named caller can ask for now", async () => {
    const w = await window_();
    const asked = post({ ...open, as: "claude-1", present: "now", id: "x" });
    const rid = await ridOf(w);
    expect(w.frames[0]).toMatchObject({ present: "now", as: "claude-1" });
    await result({ rid, ok: true, applied: true });
    await asked;
  });
  test("a word that is neither is a 400 and no window hears of it", async () => {
    const w = await window_();
    const r = await post({ ...open, as: "claude-1", present: "soon" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: "present is quiet or now" });
    await Bun.sleep(100);
    expect(w.frames).toEqual([]);
  });
});

describe("a held open", () => {
  test("comes back queued, ok and not applied, to a caller that never sent an id", async () => {
    const w = await window_();
    const asked = post({ ...open, as: "claude-1" });
    await result({ rid: await ridOf(w), ok: true, applied: false, queued: true, value: { queued: true, label: "Settings > Notifications" } });
    const r = await asked;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, applied: false, queued: true });
  });
  test("a window that says not-applied without queued is still a failure", async () => {
    const w = await window_();
    const asked = post({ ...open, as: "claude-1" });
    await result({ rid: await ridOf(w), ok: true, applied: false });
    expect(await (await asked).json()).toMatchObject({ ok: true, applied: false });
    const log = await (await fetch(base + "/actions?limit=50")).json() as { actions: { action: string; ok: boolean; target: string | null }[] };
    const mine = log.actions.filter((a) => a.action === "/control/settings.open");
    expect(mine[0]!.ok).toBe(false);
  });
  test("queued is accepted only from an ok, not-applied reply", async () => {
    expect(parseReply({ ok: true, applied: false, queued: true })).toEqual({ ok: true, applied: false, queued: true });
    expect(parseReply({ ok: true, applied: true, queued: true })).toEqual({ ok: true, applied: true });
    expect(parseReply({ ok: false, applied: false, queued: true })).toEqual({ ok: false, applied: false });
    expect(parseReply({ ok: true, applied: false, queued: "yes" })).toEqual({ ok: true, applied: false });
  });
});

describe("the audit line", () => {
  test("names the mode and that it was held, never the arguments", async () => {
    const w = await window_();
    const asked = post({ ...open, as: "claude-7" });
    await result({ rid: await ridOf(w), ok: true, applied: false, queued: true });
    await asked;
    const log = await (await fetch(base + "/actions?limit=50")).json() as { actions: { action: string; ok: boolean; target: string | null }[] };
    const line = log.actions.find((a) => a.action === "/control/settings.open" && a.target?.includes("claude-7"));
    expect(line).not.toBeUndefined();
    expect(line!.ok).toBe(true);
    expect(line!.target).toBe("as claude-7 · quiet · queued");
    expect(JSON.stringify(log)).not.toContain("notifications");
  });
  test("a now open says now", async () => {
    const w = await window_();
    const asked = post({ ...open, as: "claude-8", present: "now", id: "y" });
    await result({ rid: await ridOf(w), ok: true, applied: true });
    await asked;
    const log = await (await fetch(base + "/actions?limit=50")).json() as { actions: { action: string; target: string | null }[] };
    expect(log.actions.find((a) => a.target?.includes("claude-8"))!.target).toBe("as claude-8 · now");
  });
});
