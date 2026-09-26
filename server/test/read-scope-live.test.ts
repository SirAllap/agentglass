/*
 * The same four decisions as read-scope-tightening.test.ts, asked of a real
 * server over HTTP with real device credentials.
 *
 * "A session that is running now" is a chat pane that is open: a tmux session
 * of that name on the engine's own socket, running `sleep`, under a private
 * TMUX_TMPDIR. `claude` is a stub that sleeps, found on the PATH the server
 * starts with, so a turn that is accepted stays accepted. Everything the
 * server could write is jailed under one temp dir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-this-test";
const SOCKET = "agx-readscope";
const LIVE = "aaaaaaaa-1111-4222-8333-000000000001";
const IDLE = "aaaaaaaa-1111-4222-8333-000000000002";
/** A pane sitting on a permission prompt of its own. */
const ASKING = "aaaaaaaa-1111-4222-8333-000000000003";
let dir = "", outside = "", tmuxDir = "", repo = "", base = "", readPhone = "", phoneA = "", phoneB = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
const savedXdg = process.env.XDG_CONFIG_HOME;
// A turn that is accepted answers with a stream whose headers arrive with its
// first byte, which a sleeping stub never sends; these hold those requests and
// are aborted at the end.
const turns = new AbortController();

/** A turn, as its outcome: the refusal when there is one, else "streaming". A
 *  request that failed outright is neither, and throws. */
async function send(cred: string, resumeId: string): Promise<Response | "streaming"> {
  const r = fetch(base + "/chat/send", {
    method: "POST", headers: as(cred), signal: turns.signal,
    body: JSON.stringify({ cwd: repo, message: "carry on", resumeId }),
  });
  return Promise.race([r, Bun.sleep(1500).then(() => "streaming" as const)]);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-readscope-live-"));
  repo = join(dir, "orbit");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  // A link inside the project to a checkout outside it: spelled in scope,
  // opened out of it.
  outside = mkdtempSync(join(tmpdir(), "agx-readscope-outside-"));
  Bun.spawnSync(["git", "init", "-q", outside]);
  symlinkSync(outside, join(dir, "vendor-link"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexec sleep 30\n");
  chmodSync(join(bin, "claude"), 0o755);

  tmuxDir = join(dir, "tmux");
  mkdirSync(tmuxDir, { mode: 0o700 });
  const made = Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCKET, "new-session", "-d", "-s", LIVE, "sleep", "300"], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMUX_TMPDIR: tmuxDir },
  });
  if (made.exitCode !== 0) throw new Error("could not open the stand-in pane: " + made.stderr.toString());
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCKET, "new-session", "-d", "-s", ASKING, "sh", "-c", "echo 'Do you want to proceed? Esc to cancel'; exec sleep 300"], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMUX_TMPDIR: tmuxDir },
  });

  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  readPhone = issueDevice("Look-only tablet", "read").token;
  phoneA = issueDevice("Phone A", "answer").token;
  phoneB = issueDevice("Phone B", "answer").token;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMUX_TMPDIR: tmuxDir,
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_CACHE_DIR: join(dir, "cache", "agentglass"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "readscope.db"),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(async () => {
  turns.abort();
  try { proc?.kill(); } catch { /* already gone */ }
  Bun.spawnSync(["tmux", "-L", SOCKET, "kill-server"], { env: { PATH: process.env.PATH ?? "", TMUX_TMPDIR: tmuxDir } });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  try { rmSync(outside, { recursive: true, force: true }); } catch { /* fine */ }
});

const as = (cred: string) => ({ authorization: `Bearer ${cred}`, "content-type": "application/json" });
const post = (path: string, cred: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: as(cred), body: JSON.stringify(body) });

/** Hold a tool call in the live session, the way the hook does, and wait for
 *  it to be pending. */
async function hold(id: string): Promise<void> {
  void fetch(base + "/gate", {
    method: "POST", headers: as(TOKEN),
    body: JSON.stringify({ id, source_app: "claude", session_id: LIVE, tool_name: "Bash", tool_input: { command: "make deploy" }, timeout_ms: 30_000 }),
  }).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const p = await fetch(base + "/gate/pending", { headers: as(TOKEN) }).then((x) => x.json() as Promise<{ gates: { id: string }[] }>);
    if (p.gates.some((g) => g.id === id)) return;
    await Bun.sleep(50);
  }
  throw new Error("the gate never appeared in the pending queue");
}

describe("the notification mirror", () => {
  test("a read device is refused the socket before it is upgraded", async () => {
    const r = await fetch(`${base}/notifications?token=${encodeURIComponent(readPhone)}`, {
      headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(r.status).toBe(403);
  });

  test("and the probe; the desk still gets it", async () => {
    expect((await fetch(base + "/notifications/capability", { headers: as(readPhone) })).status).toBe(403);
    expect((await fetch(base + "/notifications/capability", { headers: as(TOKEN) })).status).toBe(200);
  });
});

describe("an answer device and the session it speaks to", () => {
  test("an idle session is not woken by a phone", async () => {
    const r = await send(phoneA, IDLE);
    expect(r).not.toBe("streaming");
    expect((r as Response).status).toBe(403);
    expect(await (r as Response).text()).toContain("idle");
  });

  test("a running one is answered", async () => {
    // An open pane, no turn in flight: the process engine takes the turn.
    const r = await send(phoneA, LIVE);
    expect(r === "streaming" ? 200 : r.status).toBe(200);
  });

  test("and the phone that answered cannot allow what it asked for", async () => {
    const id = "00000000-0000-4000-8000-00000000f401";
    await hold(id);
    const self = await post("/gate/decide", phoneA, { id, decision: "allow" });
    expect(self.status).toBe(403);
    // Another phone can, which is the whole of the rule: a second pair of eyes.
    const other = await post("/gate/decide", phoneB, { id, decision: "allow" });
    expect(((await other.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("a deny from the same phone still lands", async () => {
    const id = "00000000-0000-4000-8000-00000000f402";
    await hold(id);
    const r = await post("/gate/decide", phoneA, { id, decision: "deny" });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("nor press the pane's own prompt, except to cancel it", async () => {
    expect((await post("/chat/pane/key", phoneA, { session: LIVE, key: "Enter" })).status).toBe(403);
    // Escape passes the check and meets the next one: there is no pane here.
    expect((await post("/chat/pane/key", phoneA, { session: LIVE, key: "Escape" })).status).not.toBe(403);
    expect((await post("/chat/pane/key", phoneB, { session: LIVE, key: "Enter" })).status).not.toBe(403);
  });
});

describe("a prompt the phone raised", () => {
  test("is not answered by pasting the next turn into it", async () => {
    const first = await send(phoneA, ASKING);
    expect(first === "streaming" ? 200 : first.status).toBe(200);
    const again = await send(phoneA, ASKING);
    expect(again).not.toBe("streaming");
    expect((again as Response).status).toBe(403);
    // Another phone reaches the pane: answering somebody else's prompt is allowed.
    const other = await send(phoneB, ASKING);
    expect(other === "streaming" ? 200 : other.status).not.toBe(403);
  });
});

describe("where a turn runs", () => {
  test("a link out of the project is out of the project, even for the desk", async () => {
    const r = await fetch(base + "/chat/send", {
      method: "POST", headers: as(TOKEN), signal: turns.signal,
      body: JSON.stringify({ cwd: join(dir, "vendor-link"), message: "carry on" }),
    });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("outside the open project");
  });
});
