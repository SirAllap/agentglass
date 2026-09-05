/*
 * THE WHOLE CREW CHAIN, against a real server.
 *
 * A prompt arrives on /ingest → the answer carries the reminder → the session
 * posts to /agents/status with the session the reminder baked in → the next
 * prompt is not reminded → /agents/board shows the row by the name it chose,
 * tied to its session → the setting turns it off and on. Each step is unit-
 * tested on its own; this is the one place the seams between them are, and a
 * seam is where the last two features in this file were found broken.
 *
 * Booted the way ingest-origin.test.ts boots, for the same reasons: a named
 * environment, a scratch config dir, a scratch database, no scanner.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-lantern-route-"));
  const port = 4900 + Math.floor(Math.random() * 30);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "lantern.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const prompt = (session_id: string) =>
  post("/ingest", { source_app: "orbit", session_id, hook_event_type: "UserPromptSubmit", payload: { prompt: "hi" } })
    .then((r) => r.json() as Promise<{ ok: boolean; remind?: string }>);

test("a prompt is reminded once, and carries this session's own id", async () => {
  const first = await prompt("lantern-a");
  expect(first.ok).toBe(true);
  expect(first.remind, "the first prompt of a session is where the ask goes").toContain("/agents/status");
  expect(first.remind).toContain('"session":"lantern-a"');
  // The server names itself for the curl, so the line works pasted as-is.
  expect(first.remind).toContain(base);

  const second = await prompt("lantern-a");
  expect(second.remind, "asked once per interval, not once per prompt").toBeUndefined();
});

test("a tool call is never reminded, whatever the clock says", async () => {
  const r = await post("/ingest", { source_app: "orbit", session_id: "lantern-tool", hook_event_type: "PreToolUse", payload: {} })
    .then((x) => x.json() as Promise<{ remind?: string }>);
  expect(r.remind).toBeUndefined();
});

test("a session that answered is on the board by its own name, and not reminded again", async () => {
  await prompt("lantern-b"); // asked
  const said = await post("/agents/status", { name: "orbit-1042-migration", doing: "the migration", worktree: dir, session: "lantern-b" });
  expect(said.status).toBe(200);
  const board = await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: { name: string; doing?: string; session?: string; from: string }[] }>);
  const row = board.agents.find((a) => a.name === "orbit-1042-migration");
  expect(row, "the answer is a row, by the name the session chose").toBeDefined();
  expect(row!.doing).toBe("the migration");
  expect(row!.session).toBe("lantern-b");
  expect(row!.from).toBe("said");
  // A fresh clock for the ask alone would remind now; the answer is what stops it.
  const again = await prompt("lantern-b");
  expect(again.remind).toBeUndefined();
});

test("done clears the line — from the session that wrote it, and from nobody else", async () => {
  const names = async () => (await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: { name: string }[] }>)).agents.map((a) => a.name);
  /* No session: refused outright, the line stays. Another session: refused as
     "not yours", the line stays. This route is tokenless on loopback, so the
     session id is the only thing the writer has that a bystander does not. */
  const anon = await post("/agents/status", { name: "orbit-1042-migration", done: true });
  expect(anon.status).toBe(400);
  const other = await post("/agents/status", { name: "orbit-1042-migration", done: true, session: "lantern-z" });
  expect(other.status).toBe(403);
  expect(await names()).toContain("orbit-1042-migration");
  const own = await post("/agents/status", { name: "orbit-1042-migration", done: true, session: "lantern-b" });
  expect(own.status).toBe(200);
  expect(await names()).not.toContain("orbit-1042-migration");
});

test("a free-text field arrives at the table cut, not whole", async () => {
  const r = await post("/agents/status", { name: "wide", doing: "d".repeat(20_000), worktree: "/w/" + "a".repeat(20_000), branch: "b".repeat(20_000), session: "lantern-w" });
  expect(r.status).toBe(200);
  const board = await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: { name: string; doing?: string; worktree?: string; branch?: string }[] }>);
  const row = board.agents.find((a) => a.name === "wide")!;
  expect(row.worktree!.length).toBeLessThanOrEqual(512);
  expect(row.branch!.length).toBeLessThanOrEqual(512);
  expect(row.doing!.length).toBeLessThanOrEqual(4096);
});

test("the setting is read, written, clamped, and switches the ask off and on", async () => {
  const before = await fetch(base + "/lantern/settings").then((r) => r.json() as Promise<{ nudge: boolean; minutes: number; min: number; max: number }>);
  expect(before).toMatchObject({ nudge: true, minutes: 20 });
  expect(before.min).toBeLessThan(before.max);

  const off = await post("/lantern/settings", { nudge: false, minutes: 1 }).then((r) => r.json() as Promise<{ ok: boolean; nudge: boolean; minutes: number }>);
  expect(off.ok).toBe(true);
  expect(off.nudge).toBe(false);
  expect(off.minutes, "a minute of nagging is not a setting — clamped to the floor").toBe(before.min);
  expect((await prompt("lantern-c")).remind, "off means off, on a session never asked before").toBeUndefined();

  const bad = await post("/lantern/settings", { minutes: "soon" });
  expect(bad.status).toBe(400);

  const on = await post("/lantern/settings", { nudge: true }).then((r) => r.json() as Promise<{ nudge: boolean }>);
  expect(on.nudge).toBe(true);
  expect((await prompt("lantern-d")).remind).toContain('"session":"lantern-d"');
});

test("the watch has its own switch and clock, read and written beside the reminder's", async () => {
  const before = await fetch(base + "/lantern/settings").then((r) => r.json() as Promise<{ watch: boolean; watchMinutes: number; min: number }>);
  expect(before).toMatchObject({ watch: true, watchMinutes: 15 });
  const off = await post("/lantern/settings", { watch: false, watchMinutes: 1 }).then((r) => r.json() as Promise<{ ok: boolean; watch: boolean; watchMinutes: number; nudge: boolean }>);
  expect(off).toMatchObject({ ok: true, watch: false, watchMinutes: before.min, nudge: true });
  const board = await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ watch: { on: boolean; every: number; at: number; flagged: number } }>);
  expect(board.watch, "the board carries the watch's state for the view's one line").toMatchObject({ on: false, every: before.min, at: 0, flagged: 0 });
  const on = await post("/lantern/settings", { watch: true, watchMinutes: 30 }).then((r) => r.json() as Promise<{ watch: boolean; watchMinutes: number }>);
  expect(on).toMatchObject({ watch: true, watchMinutes: 30 });
  // The prompt-cache window rides the same settings and the board carries it.
  const ttl = await post("/lantern/settings", { cacheTtlMinutes: 60 }).then((r) => r.json() as Promise<{ cacheTtlMinutes: number }>);
  expect(ttl.cacheTtlMinutes).toBe(60);
  expect((await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ cacheTtlMinutes: number }>)).cacheTtlMinutes).toBe(60);
  expect((await post("/lantern/settings", { cacheTtlMinutes: "warm" })).status).toBe(400);
});

test("stopped on a permission shows on the board first, with why — and clears when the session moves", async () => {
  // The hook says the session stopped for a person. This is the only place
  // that fact exists for a session the scanner owns, and the board reads it.
  // Shaped like a real hook: send_event.py inherits the pane, and Claude Code
  // puts the transcript and cwd in every payload — the sighting needs all three.
  // One pane per session: the board is keyed by pane — a pane is a place, and
  // one running two sessions in turn is still one place — so two sessions on
  // one pane would be one row, the newer one's.
  const hook = (session_id: string, hook_event_type: string, message?: string) =>
    post("/ingest", { source_app: "orbit", session_id, hook_event_type, tmux_pane: session_id === "lantern-wait" ? "%77" : "%78",
      payload: { transcript_path: join(dir, `${session_id}.jsonl`), cwd: dir, ...(message ? { message } : {}) } });
  await hook("lantern-wait", "PreToolUse");
  await hook("lantern-wait", "Notification", "Claude needs your permission to use Bash");
  await hook("lantern-busy", "PostToolUse");
  type Row = { session?: string; state: string; needsYou?: { kind: string; why: string } };
  const read = () => fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: Row[] }>);
  let board = await read();
  const waiting = board.agents.find((a) => a.session === "lantern-wait");
  expect(waiting, "a hooked session is a row").toBeDefined();
  expect(waiting!.state).toBe("waiting");
  expect(waiting!.needsYou).toMatchObject({ kind: "permission", why: "Claude needs your permission to use Bash" });
  expect(board.agents[0]!.session, "who needs you comes first").toBe("lantern-wait");

  await hook("lantern-wait", "PostToolUse"); // the person answered; the tool ran
  board = await read();
  const moved = board.agents.find((a) => a.session === "lantern-wait")!;
  expect(moved.needsYou).toBeUndefined();
  expect(moved.state).toBe("working");
});

test("the Lantern's own chat is never 'needs you', and is never reminded — its hooks say what it is", async () => {
  // "What sense does it make for the lantern itself to tell me it needs help?"
  // Its pane carries AGENTGLASS_ROLE=lantern (the bench passes it with -e);
  // send_event.py forwards it on every event. A wait-shaped Notification from
  // it is you mid-conversation, not an agent stopped on you.
  const hook = (hook_event_type: string, extra: Record<string, unknown> = {}) =>
    post("/ingest", { source_app: "orbit", session_id: "lantern-self", hook_event_type, tmux_pane: "%79", role: "lantern",
      payload: { transcript_path: join(dir, "lantern-self.jsonl"), cwd: dir, ...extra } })
      .then((r) => r.json() as Promise<{ ok: boolean; remind?: string }>);
  const first = await hook("UserPromptSubmit", { prompt: "You are the Lantern for this machine" });
  expect(first.ok).toBe(true);
  expect(first.remind, "the watcher is not asked to watch itself").toBeUndefined();
  await hook("Notification", { message: "Claude is waiting for your input" });
  type Row = { session?: string; state: string; role?: string; needsYou?: unknown };
  const board = await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: Row[] }>);
  const self = board.agents.find((a) => a.session === "lantern-self");
  expect(self, "it is on the field, marked").toBeDefined();
  expect(self!.role).toBe("lantern");
  expect(self!.needsYou).toBeUndefined();
  expect(self!.state).not.toBe("waiting");
  // And a session with no role saying the same thing IS stopped on you — the
  // exemption is the role, not the message.
  await post("/ingest", { source_app: "orbit", session_id: "lantern-other", hook_event_type: "Notification", tmux_pane: "%80",
    payload: { transcript_path: join(dir, "lantern-other.jsonl"), cwd: dir, message: "Claude is waiting for your input" } });
  const again = await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: Row[] }>);
  expect(again.agents.find((a) => a.session === "lantern-other")!.needsYou).toBeDefined();
});

test("the Lantern is known by its own first prompt, with no role in the environment — and its status post is not a second agent", async () => {
  // "Why are there 2 lanterns, and who the hell ran them?" — one chat,
  // launched before the role existed, reminded to post its status, and the
  // board drew the post beside the pane. The prompt is ours, so it is the mark.
  const hook = (hook_event_type: string, extra: Record<string, unknown> = {}) =>
    post("/ingest", { source_app: "orbit", session_id: "lantern-by-prompt", hook_event_type, tmux_pane: "%81",
      payload: { transcript_path: join(dir, "lantern-by-prompt.jsonl"), cwd: dir, ...extra } })
      .then((r) => r.json() as Promise<{ ok: boolean; remind?: string }>);
  const first = await hook("UserPromptSubmit", { prompt: "You are the Lantern for this machine: you read the field and answer questions about it." });
  expect(first.remind, "the very prompt that opens the chat is the mark — no reminder rides its answer").toBeUndefined();
  await hook("Notification", { message: "Claude is waiting for your input" });
  // Even if a reminder had reached it, its status post is dropped rather than drawn.
  const posted = await post("/agents/status", { name: "lantern", doing: "Lantern: answering questions", worktree: dir, session: "lantern-by-prompt" })
    .then((r) => r.json() as Promise<{ ok: boolean; ignored?: string }>);
  expect(posted.ignored).toContain("does not post");
  type Row = { name: string; session?: string; role?: string; needsYou?: unknown };
  const board = await fetch(base + "/agents/board").then((r) => r.json() as Promise<{ agents: Row[] }>);
  const mine = board.agents.filter((a) => a.session === "lantern-by-prompt" || a.name === "lantern");
  expect(mine, "one row, the pane's").toHaveLength(1);
  expect(mine[0]).toMatchObject({ role: "lantern" });
  expect(mine[0]!.needsYou).toBeUndefined();
});

test("a ticket for the Lantern's chat: minted here, with the field as its first message, in a real checkout", async () => {
  // The board has rows in `dir` (the hook sightings above), so the chat is
  // rooted there. The client sends nothing but an offer of a checkout.
  const r = await post("/lantern/ticket", { cwd: dir }).then((x) => x.json() as Promise<{ ok: boolean; ticket?: string; cwd?: string; error?: string }>);
  expect(r.ok, r.error).toBe(true);
  expect(typeof r.ticket).toBe("string");
  expect(r.cwd).toBe(dir);
});
